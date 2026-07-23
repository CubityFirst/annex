import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleVerifyEmail } from "./verify-email";

vi.mock("../verification", () => ({
  consumeVerificationToken: vi.fn(),
}));
vi.mock("../sessions", () => ({
  createSession: vi.fn(),
  SESSION_TTL_MS: 7 * 24 * 60 * 60 * 1000,
}));
vi.mock("../jwt", () => ({
  signJwt: vi.fn(),
}));
vi.mock("../email", () => ({
  sendEmailChangedNotice: vi.fn().mockResolvedValue(true),
}));
vi.mock("../stripe-client", () => ({
  syncStripeCustomerEmail: vi.fn().mockResolvedValue(undefined),
}));

import { consumeVerificationToken } from "../verification";
import { createSession } from "../sessions";
import { signJwt } from "../jwt";
import { sendEmailChangedNotice } from "../email";
import { syncStripeCustomerEmail } from "../stripe-client";

const userRow = { id: "user-1", email: "test@example.com", name: "Test", created_at: "2026-01-01T00:00:00Z" };

// .run() for the UPDATE, then .first() for the SELECT, both off the same chain.
function makeEnv(row: typeof userRow | null) {
  const run = vi.fn().mockResolvedValue({});
  const first = vi.fn().mockResolvedValue(row);
  const bind = vi.fn().mockReturnValue({ run, first });
  const prepare = vi.fn().mockReturnValue({ bind });
  return { env: { DB: { prepare }, JWT_SECRET: "secret" } as unknown as Parameters<typeof handleVerifyEmail>[1], prepare, bind, run, first };
}

// Queue-based mock for the change-confirm path, where the SELECT and UPDATE
// need distinct results (and the UPDATE may reject on a UNIQUE violation).
function makeQueueEnv(opts: { userEmail: string | null; moderation?: number; updateError?: Error }) {
  const bindCalls: unknown[][] = [];
  const sqls: string[] = [];
  const first = vi.fn().mockResolvedValue(
    opts.userEmail !== null ? { email: opts.userEmail, moderation: opts.moderation ?? 0 } : null,
  );
  const run = opts.updateError
    ? vi.fn().mockRejectedValue(opts.updateError)
    : vi.fn().mockResolvedValue({});
  const prepare = vi.fn((sql: string) => {
    sqls.push(sql);
    return { bind: vi.fn((...args: unknown[]) => { bindCalls.push(args); return { first, run }; }) };
  });
  return { env: { DB: { prepare }, JWT_SECRET: "secret" } as unknown as Parameters<typeof handleVerifyEmail>[1], prepare, sqls, bindCalls, run, first };
}

function req(body: unknown) {
  return new Request("http://localhost/verify-email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(consumeVerificationToken).mockResolvedValue({ userId: "user-1", email: null });
  vi.mocked(createSession).mockResolvedValue("sess-new");
  vi.mocked(signJwt).mockResolvedValue("signed.jwt.token");
});

describe("handleVerifyEmail", () => {
  it("rejects a missing token", async () => {
    const { env, prepare } = makeEnv(userRow);
    const res = await handleVerifyEmail(req({}), env);
    expect(res.status).toBe(400);
    expect(prepare).not.toHaveBeenCalled();
  });

  it("returns 400 for an invalid/expired token", async () => {
    vi.mocked(consumeVerificationToken).mockResolvedValue(null);
    // The dead-token lookup finds no row (unknown or GC'd token).
    const { env } = makeEnv(null);
    const res = await handleVerifyEmail(req({ token: "bad" }), env);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { ok: boolean; error: string };
    expect(json.error).toBe("invalid_or_expired_token");
  });

  it("returns change_link_expired for a dead change token", async () => {
    vi.mocked(consumeVerificationToken).mockResolvedValue(null);
    // The dead-token lookup finds a consumed/expired row carrying a pending email.
    const { env } = makeQueueEnv({ userEmail: "pending@example.com" });
    const res = await handleVerifyEmail(req({ token: "stale-change" }), env);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { ok: boolean; error: string };
    expect(json.error).toBe("change_link_expired");
  });

  it("returns 404 when the user vanished after token consumption", async () => {
    const { env } = makeEnv(null);
    const res = await handleVerifyEmail(req({ token: "good" }), env);
    expect(res.status).toBe(404);
  });

  it("marks the email verified, mints a session, and returns the token + user", async () => {
    const { env, run } = makeEnv(userRow);
    const res = await handleVerifyEmail(req({ token: "good" }), env);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; data: { verified: boolean; token: string; user: { id: string } } };
    expect(json.data.verified).toBe(true);
    expect(json.data.token).toBe("signed.jwt.token");
    expect(json.data.user.id).toBe("user-1");
    // UPDATE users SET email_verified = 1 ... was issued
    expect(run).toHaveBeenCalled();
    expect(createSession).toHaveBeenCalled();
    expect(signJwt).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1", sid: "sess-new", isAdmin: false }),
      "secret",
    );
  });

  describe("change-confirm tokens (token carries a pending email)", () => {
    beforeEach(() => {
      vi.mocked(consumeVerificationToken).mockResolvedValue({ userId: "user-1", email: "new@example.com" });
    });

    it("applies the new email, notifies the old address, and does NOT mint a session", async () => {
      const { env, sqls, bindCalls } = makeQueueEnv({ userEmail: "old@example.com" });
      const res = await handleVerifyEmail(req({ token: "change" }), env);
      expect(res.status).toBe(200);
      const json = (await res.json()) as { ok: boolean; data: { verified: boolean; emailChanged: boolean; userId: string; email: string; token?: string; user?: unknown } };
      expect(json.data.emailChanged).toBe(true);
      expect(json.data.userId).toBe("user-1");
      expect(json.data.email).toBe("new@example.com");
      // Deliberately no session: mailbox access must not bypass the
      // password+MFA gate that protected the change request.
      expect(json.data.token).toBeUndefined();
      expect(json.data.user).toBeUndefined();
      expect(createSession).not.toHaveBeenCalled();
      expect(signJwt).not.toHaveBeenCalled();

      const updateIdx = sqls.findIndex(s => s.includes("UPDATE users SET email = ?"));
      expect(updateIdx).toBeGreaterThanOrEqual(0);
      expect(sqls[updateIdx]).toContain("email_verified = 1");
      expect(bindCalls[updateIdx][0]).toBe("new@example.com");
      expect(bindCalls[updateIdx][2]).toBe("user-1");

      expect(sendEmailChangedNotice).toHaveBeenCalledWith(env, "old@example.com", "new@example.com");
      expect(syncStripeCustomerEmail).toHaveBeenCalledWith(env, "user-1", "new@example.com");
    });

    it("returns 409 email_taken when the address was claimed before confirmation", async () => {
      const { env } = makeQueueEnv({ userEmail: "old@example.com", updateError: new Error("UNIQUE constraint failed: users.email") });
      const res = await handleVerifyEmail(req({ token: "change" }), env);
      expect(res.status).toBe(409);
      const json = (await res.json()) as { ok: boolean; error: string };
      expect(json.error).toBe("email_taken");
      expect(sendEmailChangedNotice).not.toHaveBeenCalled();
      expect(syncStripeCustomerEmail).not.toHaveBeenCalled();
    });

    it("returns 404 when the user vanished", async () => {
      const { env } = makeQueueEnv({ userEmail: null });
      const res = await handleVerifyEmail(req({ token: "change" }), env);
      expect(res.status).toBe(404);
    });

    it("refuses to apply for a disabled account", async () => {
      const { env, run } = makeQueueEnv({ userEmail: "old@example.com", moderation: -1 });
      const res = await handleVerifyEmail(req({ token: "change" }), env);
      expect(res.status).toBe(403);
      const json = (await res.json()) as { error: string };
      expect(json.error).toBe("account_disabled");
      expect(run).not.toHaveBeenCalled();
    });

    it("refuses to apply for a currently-suspended account", async () => {
      const until = Math.floor(Date.now() / 1000) + 3600;
      const { env, run } = makeQueueEnv({ userEmail: "old@example.com", moderation: until });
      const res = await handleVerifyEmail(req({ token: "change" }), env);
      expect(res.status).toBe(403);
      const json = (await res.json()) as { error: string };
      expect(json.error).toBe("account_suspended");
      expect(run).not.toHaveBeenCalled();
    });

    it("applies normally once a past suspension has lapsed", async () => {
      const lapsed = Math.floor(Date.now() / 1000) - 3600;
      const { env } = makeQueueEnv({ userEmail: "old@example.com", moderation: lapsed });
      const res = await handleVerifyEmail(req({ token: "change" }), env);
      expect(res.status).toBe(200);
    });

    it("rethrows a non-UNIQUE update failure instead of reporting email_taken", async () => {
      const { env } = makeQueueEnv({
        userEmail: "old@example.com",
        updateError: new Error("D1_ERROR: network timeout"),
      });
      await expect(handleVerifyEmail(req({ token: "change" }), env)).rejects.toThrow("network timeout");
      expect(sendEmailChangedNotice).not.toHaveBeenCalled();
    });
  });
});
