import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleDeleteAccount } from "./delete-account";

vi.mock("../auth-session", () => ({
  requireAuthenticatedSession: vi.fn(),
}));

vi.mock("../mfa", () => ({
  requireMFA: vi.fn(),
}));

import { requireAuthenticatedSession } from "../auth-session";
import { requireMFA } from "../mfa";

const mockSession = { userId: "user-1", email: "test@example.com", expiresAt: Date.now() + 3600_000 };

function makeEnv(passwordHash?: string, rateLimitSuccess = true) {
  return {
    // No STRIPE_SECRET_KEY so the Stripe customer-delete branch is skipped.
    DB: {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue(passwordHash ? { password_hash: passwordHash } : null),
          run: vi.fn().mockResolvedValue(undefined),
        }),
      }),
    },
    RATE_LIMITER_AUTH: {
      limit: vi.fn().mockResolvedValue({ success: rateLimitSuccess }),
    },
  } as unknown as Parameters<typeof handleDeleteAccount>[1];
}

function makeRequest(body: Record<string, unknown>) {
  return new Request("http://localhost/delete-account", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAuthenticatedSession).mockResolvedValue(mockSession);
  vi.mocked(requireMFA).mockResolvedValue(null);
});

describe("handleDeleteAccount", () => {
  it("returns 401 when the session is invalid", async () => {
    vi.mocked(requireAuthenticatedSession).mockResolvedValue(
      Response.json({ ok: false, error: "Unauthorized" }, { status: 401 }),
    );
    const res = await handleDeleteAccount(makeRequest({ currentPassword: "pw" }), makeEnv());
    expect(res.status).toBe(401);
  });

  it("returns 400 when currentPassword is missing (no re-auth)", async () => {
    const res = await handleDeleteAccount(makeRequest({}), makeEnv("hash"));
    expect(res.status).toBe(400);
  });

  it("returns 429 when the per-user rate limit is exceeded", async () => {
    const res = await handleDeleteAccount(
      makeRequest({ currentPassword: "pw" }),
      makeEnv("hash", false),
    );
    expect(res.status).toBe(429);
  });

  it("returns 401 when the current password is wrong", async () => {
    const { hashPassword } = await import("../password");
    const hash = await hashPassword("correct-password");
    const res = await handleDeleteAccount(
      makeRequest({ currentPassword: "wrong-password" }),
      makeEnv(hash),
    );
    expect(res.status).toBe(401);
  });

  it("deletes the account on correct password + passing MFA", async () => {
    const { hashPassword } = await import("../password");
    const hash = await hashPassword("correct-password");
    const env = makeEnv(hash);
    const res = await handleDeleteAccount(
      makeRequest({ currentPassword: "correct-password" }),
      env,
    );
    expect(res.status).toBe(200);
    expect(env.DB.prepare).toHaveBeenCalledWith("DELETE FROM users WHERE id = ?");
  });

  it("does not delete when MFA fails", async () => {
    vi.mocked(requireMFA).mockResolvedValue(
      Response.json({ ok: false, error: "mfa_required" }, { status: 200 }),
    );
    const { hashPassword } = await import("../password");
    const hash = await hashPassword("correct-password");
    const env = makeEnv(hash);
    await handleDeleteAccount(makeRequest({ currentPassword: "correct-password" }), env);
    expect(env.DB.prepare).not.toHaveBeenCalledWith("DELETE FROM users WHERE id = ?");
  });
});
