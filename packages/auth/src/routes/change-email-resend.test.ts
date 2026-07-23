import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleChangeEmailResend } from "./change-email-resend";

vi.mock("../auth-session", () => ({
  requireAuthenticatedSession: vi.fn(),
}));
vi.mock("../verification", () => ({
  createVerificationToken: vi.fn(),
}));
vi.mock("../email", () => ({
  sendEmailChangeConfirmEmail: vi.fn().mockResolvedValue(true),
}));

import { requireAuthenticatedSession } from "../auth-session";
import { createVerificationToken } from "../verification";
import { sendEmailChangeConfirmEmail } from "../email";

const mockSession = { userId: "user-1", email: "old@example.com", expiresAt: Date.now() + 3600_000 };

// A pending token old enough to clear the 5-minute resend floor.
const OLD_ENOUGH = () => Date.now() - 10 * 60 * 1000;

function makeEnv(pending: { email: string; created_at: number } | null, opts: { rateLimited?: boolean } = {}) {
  const sqls: string[] = [];
  const bindCalls: unknown[][] = [];
  const prepare = vi.fn((sql: string) => {
    sqls.push(sql);
    return {
      bind: vi.fn((...args: unknown[]) => {
        bindCalls.push(args);
        return {
          first: vi.fn().mockResolvedValue(pending),
          run: vi.fn().mockResolvedValue({}),
        };
      }),
    };
  });
  const limit = vi.fn().mockResolvedValue({ success: !opts.rateLimited });
  const env = {
    DB: { prepare },
    APP_ORIGIN: "http://localhost:5173",
    RATE_LIMITER_EMAIL_VERIFY: { limit },
  } as unknown as Parameters<typeof handleChangeEmailResend>[1];
  return { env, sqls, bindCalls, limit };
}

function req() {
  return new Request("http://localhost/change-email/resend", { method: "POST", body: "{}" });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAuthenticatedSession).mockResolvedValue(mockSession);
  vi.mocked(createVerificationToken).mockResolvedValue("tok-456");
  vi.mocked(sendEmailChangeConfirmEmail).mockResolvedValue(true);
});

describe("handleChangeEmailResend", () => {
  it("returns 401 when the session is invalid", async () => {
    vi.mocked(requireAuthenticatedSession).mockResolvedValue(
      Response.json({ ok: false, error: "Unauthorized" }, { status: 401 }),
    );
    const res = await handleChangeEmailResend(req(), makeEnv({ email: "new@example.com", created_at: OLD_ENOUGH() }).env);
    expect(res.status).toBe(401);
  });

  it("throttles per-user via the email-verify limiter", async () => {
    const { env, limit } = makeEnv({ email: "new@example.com", created_at: OLD_ENOUGH() }, { rateLimited: true });
    const res = await handleChangeEmailResend(req(), env);
    expect(res.status).toBe(429);
    expect(limit).toHaveBeenCalledWith({ key: "change-email:user-1" });
    expect(sendEmailChangeConfirmEmail).not.toHaveBeenCalled();
  });

  it("returns 400 no_pending_change when nothing is pending", async () => {
    const res = await handleChangeEmailResend(req(), makeEnv(null).env);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("no_pending_change");
    expect(createVerificationToken).not.toHaveBeenCalled();
  });

  it("refuses with 429 too_soon inside the 5-minute resend floor", async () => {
    const { env } = makeEnv({ email: "new@example.com", created_at: Date.now() - 60_000 });
    const res = await handleChangeEmailResend(req(), env);
    expect(res.status).toBe(429);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("too_soon");
    expect(sendEmailChangeConfirmEmail).not.toHaveBeenCalled();
  });

  it("re-issues the token with a fresh TTL and resends the confirm email", async () => {
    const { env, sqls, bindCalls } = makeEnv({ email: "new@example.com", created_at: OLD_ENOUGH() });
    const res = await handleChangeEmailResend(req(), env);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; data: { sent: boolean; pendingEmail: string } };
    expect(json.data).toEqual({ sent: true, pendingEmail: "new@example.com" });

    // Lookup and delete are both scoped to the caller's change tokens.
    const selIdx = sqls.findIndex(s => s.startsWith("SELECT email"));
    expect(sqls[selIdx]).toContain("email IS NOT NULL");
    expect(bindCalls[selIdx][0]).toBe("user-1");
    const delIdx = sqls.findIndex(s => s.startsWith("DELETE"));
    expect(sqls[delIdx]).toContain("email IS NOT NULL");
    expect(bindCalls[delIdx]).toEqual(["user-1"]);

    expect(createVerificationToken).toHaveBeenCalledWith(env, "user-1", "new@example.com");
    expect(sendEmailChangeConfirmEmail).toHaveBeenCalledWith(
      env,
      "new@example.com",
      "http://localhost:5173/verify-email?token=tok-456",
    );
  });

  it("surfaces a failed send as 500 send_failed", async () => {
    vi.mocked(sendEmailChangeConfirmEmail).mockResolvedValueOnce(false);
    const { env } = makeEnv({ email: "new@example.com", created_at: OLD_ENOUGH() });
    const res = await handleChangeEmailResend(req(), env);
    expect(res.status).toBe(500);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("send_failed");
  });
});
