import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleChangeEmail } from "./change-email";

vi.mock("../auth-session", () => ({
  requireAuthenticatedSession: vi.fn(),
}));
vi.mock("../mfa", () => ({
  requireMFA: vi.fn(),
}));
vi.mock("../verification", () => ({
  createVerificationToken: vi.fn(),
  isEmailVerificationEnabled: vi.fn(),
}));
vi.mock("../email", () => ({
  sendEmailChangeConfirmEmail: vi.fn().mockResolvedValue(true),
  sendEmailChangedNotice: vi.fn().mockResolvedValue(true),
}));
vi.mock("../stripe-client", () => ({
  syncStripeCustomerEmail: vi.fn().mockResolvedValue(undefined),
}));

import { requireAuthenticatedSession } from "../auth-session";
import { requireMFA } from "../mfa";
import { createVerificationToken, isEmailVerificationEnabled } from "../verification";
import { sendEmailChangeConfirmEmail, sendEmailChangedNotice } from "../email";
import { syncStripeCustomerEmail } from "../stripe-client";

const mockSession = { userId: "user-1", email: "old@example.com", expiresAt: Date.now() + 3600_000 };

// Queue-based D1 mock: first() results shift in handler call-order
// (1: SELECT email+password_hash, 2: SELECT id uniqueness pre-check).
// SQL strings + bind args are captured so WHERE scoping can be asserted.
function makeEnv(opts: {
  user?: { email: string; password_hash: string } | null;
  taken?: boolean;
  flagOn?: boolean;
  updateError?: Error;
  rateLimited?: boolean;
}) {
  const firstResults: unknown[] = [opts.user ?? null, opts.taken ? { id: "other-user" } : null];
  const sqls: string[] = [];
  const bindCalls: unknown[][] = [];
  const run = vi.fn((): Promise<unknown> => Promise.resolve({}));
  const prepare = vi.fn((sql: string) => {
    sqls.push(sql);
    return {
      bind: vi.fn((...args: unknown[]) => {
        bindCalls.push(args);
        return {
          first: vi.fn(() => Promise.resolve(firstResults.shift() ?? null)),
          run: sql.startsWith("UPDATE users") && opts.updateError
            ? vi.fn(() => Promise.reject(opts.updateError))
            : run,
        };
      }),
    };
  });
  const limit = vi.fn().mockResolvedValue({ success: !opts.rateLimited });
  const env = {
    DB: { prepare },
    APP_ORIGIN: "http://localhost:5173",
    RATE_LIMITER_EMAIL_VERIFY: { limit },
  } as unknown as Parameters<typeof handleChangeEmail>[1];
  // Flag reads go through isEmailVerificationEnabled (mocked above) - the
  // helper itself is covered in verification.test.ts, incl. the dev bypass.
  vi.mocked(isEmailVerificationEnabled).mockResolvedValue(opts.flagOn ?? false);
  return { env, prepare, sqls, bindCalls, run, limit };
}

function makeRequest(body: Record<string, unknown>) {
  return new Request("http://localhost/change-email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

let userHash: string;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(requireAuthenticatedSession).mockResolvedValue(mockSession);
  vi.mocked(requireMFA).mockResolvedValue(null);
  vi.mocked(createVerificationToken).mockResolvedValue("tok-123");
  if (!userHash) {
    const { hashPassword } = await import("../password");
    userHash = await hashPassword("current-password");
  }
});

function userRow() {
  return { email: "old@example.com", password_hash: userHash };
}

describe("handleChangeEmail", () => {
  it("returns 400 when newEmail is missing", async () => {
    const res = await handleChangeEmail(makeRequest({ currentPassword: "x" }), makeEnv({}).env);
    expect(res.status).toBe(400);
  });

  it("returns 400 when currentPassword is missing", async () => {
    const res = await handleChangeEmail(makeRequest({ newEmail: "new@example.com" }), makeEnv({}).env);
    expect(res.status).toBe(400);
  });

  it("returns 400 for a malformed address", async () => {
    const res = await handleChangeEmail(
      makeRequest({ newEmail: "not-an-email", currentPassword: "current-password" }),
      makeEnv({ user: userRow() }).env,
    );
    expect(res.status).toBe(400);
  });

  it("returns 401 when the session is invalid", async () => {
    vi.mocked(requireAuthenticatedSession).mockResolvedValue(
      Response.json({ ok: false, error: "Unauthorized" }, { status: 401 }),
    );
    const res = await handleChangeEmail(
      makeRequest({ newEmail: "new@example.com", currentPassword: "current-password" }),
      makeEnv({}).env,
    );
    expect(res.status).toBe(401);
  });

  it("returns 400 same_email when the new address equals the current one (case-insensitively)", async () => {
    const res = await handleChangeEmail(
      makeRequest({ newEmail: "  OLD@example.com ", currentPassword: "current-password" }),
      makeEnv({ user: userRow() }).env,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("same_email");
  });

  it("returns 401 when the current password is wrong", async () => {
    const res = await handleChangeEmail(
      makeRequest({ newEmail: "new@example.com", currentPassword: "wrong-password" }),
      makeEnv({ user: userRow() }).env,
    );
    expect(res.status).toBe(401);
    expect(requireMFA).not.toHaveBeenCalled();
  });

  it("returns the MFA error response when MFA fails", async () => {
    vi.mocked(requireMFA).mockResolvedValue(
      Response.json({ ok: false, error: "mfa_required" }, { status: 200 }),
    );
    const res = await handleChangeEmail(
      makeRequest({ newEmail: "new@example.com", currentPassword: "current-password" }),
      makeEnv({ user: userRow() }).env,
    );
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("mfa_required");
  });

  it("throttles per-user via the email-verify limiter", async () => {
    const { env, limit } = makeEnv({ user: userRow(), rateLimited: true });
    const res = await handleChangeEmail(
      makeRequest({ newEmail: "new@example.com", currentPassword: "current-password" }),
      env,
    );
    expect(res.status).toBe(429);
    expect(limit).toHaveBeenCalledWith({ key: "change-email:user-1" });
  });

  it("returns 409 when the address belongs to another account", async () => {
    const { env, run } = makeEnv({ user: userRow(), taken: true });
    const res = await handleChangeEmail(
      makeRequest({ newEmail: "new@example.com", currentPassword: "current-password" }),
      env,
    );
    expect(res.status).toBe(409);
    // No mutation happened.
    expect(run).not.toHaveBeenCalled();
  });

  describe("flag OFF (immediate apply)", () => {
    it("normalizes, updates the row unverified, notifies the old address, and syncs Stripe", async () => {
      const { env, sqls, bindCalls } = makeEnv({ user: userRow(), flagOn: false });
      const res = await handleChangeEmail(
        makeRequest({ newEmail: "  New@Example.COM ", currentPassword: "current-password" }),
        env,
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as { ok: boolean; data: { applied: boolean; email: string } };
      expect(json.data).toEqual({ applied: true, email: "new@example.com" });

      // Prior pending change tokens are always invalidated first.
      const delIdx = sqls.findIndex(s => s.includes("DELETE FROM email_verification_tokens"));
      expect(delIdx).toBeGreaterThanOrEqual(0);
      expect(sqls[delIdx]).toContain("email IS NOT NULL");
      expect(bindCalls[delIdx]).toEqual(["user-1"]);

      const updIdx = sqls.findIndex(s => s.startsWith("UPDATE users SET email = ?"));
      expect(updIdx).toBeGreaterThanOrEqual(0);
      expect(sqls[updIdx]).toContain("email_verified = 0");
      expect(bindCalls[updIdx]).toEqual(["new@example.com", "user-1"]);

      expect(sendEmailChangedNotice).toHaveBeenCalledWith(env, "old@example.com", "new@example.com");
      expect(syncStripeCustomerEmail).toHaveBeenCalledWith(env, "user-1", "new@example.com");
      expect(createVerificationToken).not.toHaveBeenCalled();
      expect(sendEmailChangeConfirmEmail).not.toHaveBeenCalled();
    });

    it("returns 409 on a UNIQUE-constraint race past the pre-check", async () => {
      const { env } = makeEnv({
        user: userRow(),
        flagOn: false,
        updateError: new Error("UNIQUE constraint failed: users.email"),
      });
      const res = await handleChangeEmail(
        makeRequest({ newEmail: "new@example.com", currentPassword: "current-password" }),
        env,
      );
      expect(res.status).toBe(409);
      expect(sendEmailChangedNotice).not.toHaveBeenCalled();
    });

    it("rethrows a non-UNIQUE update failure instead of reporting 409", async () => {
      const { env } = makeEnv({
        user: userRow(),
        flagOn: false,
        updateError: new Error("D1_ERROR: network timeout"),
      });
      await expect(
        handleChangeEmail(
          makeRequest({ newEmail: "new@example.com", currentPassword: "current-password" }),
          env,
        ),
      ).rejects.toThrow("network timeout");
      expect(sendEmailChangedNotice).not.toHaveBeenCalled();
    });
  });

  describe("flag ON (confirm-first)", () => {
    it("leaves users untouched and sends a confirm link to the NEW address", async () => {
      const { env, sqls, bindCalls } = makeEnv({ user: userRow(), flagOn: true });
      const res = await handleChangeEmail(
        makeRequest({ newEmail: "new@example.com", currentPassword: "current-password" }),
        env,
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as { ok: boolean; data: { applied: boolean; pendingEmail: string } };
      expect(json.data).toEqual({ applied: false, pendingEmail: "new@example.com" });

      expect(sqls.some(s => s.startsWith("UPDATE users"))).toBe(false);
      // Earlier pending changes are still invalidated.
      const delIdx = sqls.findIndex(s => s.includes("DELETE FROM email_verification_tokens"));
      expect(delIdx).toBeGreaterThanOrEqual(0);
      expect(bindCalls[delIdx]).toEqual(["user-1"]);

      expect(createVerificationToken).toHaveBeenCalledWith(env, "user-1", "new@example.com");
      expect(sendEmailChangeConfirmEmail).toHaveBeenCalledWith(
        env,
        "new@example.com",
        "http://localhost:5173/verify-email?token=tok-123",
      );
      expect(sendEmailChangedNotice).not.toHaveBeenCalled();
      expect(syncStripeCustomerEmail).not.toHaveBeenCalled();
    });

    it("surfaces a failed confirm send and drops the orphaned token", async () => {
      vi.mocked(sendEmailChangeConfirmEmail).mockResolvedValueOnce(false);
      const { env, sqls, bindCalls } = makeEnv({ user: userRow(), flagOn: true });
      const res = await handleChangeEmail(
        makeRequest({ newEmail: "new@example.com", currentPassword: "current-password" }),
        env,
      );
      expect(res.status).toBe(500);
      const json = (await res.json()) as { error: string };
      expect(json.error).toBe("send_failed");
      // The just-created token is cleaned up so no phantom pending state remains.
      const delByIdIdx = sqls.findIndex(s => s === "DELETE FROM email_verification_tokens WHERE id = ?");
      expect(delByIdIdx).toBeGreaterThanOrEqual(0);
      expect(bindCalls[delByIdIdx]).toEqual(["tok-123"]);
    });
  });
});
