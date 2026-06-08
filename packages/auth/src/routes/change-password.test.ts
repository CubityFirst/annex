import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleChangePassword } from "./change-password";

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
  } as unknown as Parameters<typeof handleChangePassword>[1];
}

function makeRequest(body: Record<string, unknown>, authHeader?: string) {
  return new Request("http://localhost/change-password", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(authHeader ? { Authorization: authHeader } : {}),
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireMFA).mockResolvedValue(null);
});

describe("handleChangePassword", () => {
  it("returns 400 when currentPassword is missing", async () => {
    const res = await handleChangePassword(makeRequest({ newPassword: "NewP@ssw0rd99" }), makeEnv());
    expect(res.status).toBe(400);
  });

  it("returns 400 when newPassword is missing", async () => {
    const res = await handleChangePassword(makeRequest({ currentPassword: "old-pass" }), makeEnv());
    expect(res.status).toBe(400);
  });

  it("returns 401 when session is invalid", async () => {
    vi.mocked(requireAuthenticatedSession).mockResolvedValue(
      Response.json({ ok: false, error: "Unauthorized" }, { status: 401 }),
    );
    const res = await handleChangePassword(
      makeRequest({ currentPassword: "old", newPassword: "NewP@ssw0rd99" }),
      makeEnv(),
    );
    expect(res.status).toBe(401);
  });

  it("returns 400 with password_too_weak when new password is weak", async () => {
    vi.mocked(requireAuthenticatedSession).mockResolvedValue(mockSession);
    const res = await handleChangePassword(
      makeRequest({ currentPassword: "old-pass", newPassword: "weak" }),
      makeEnv(),
    );
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe("password_too_weak");
  });

  it("returns 401 when current password is wrong", async () => {
    vi.mocked(requireAuthenticatedSession).mockResolvedValue(mockSession);

    // hash of "correct-password"
    const { hashPassword } = await import("../password");
    const hash = await hashPassword("correct-password");

    const res = await handleChangePassword(
      makeRequest({ currentPassword: "wrong-password", newPassword: "NewP@ssw0rd99!" }),
      makeEnv(hash),
    );
    expect(res.status).toBe(401);
  });

  it("returns 200 and updates password on success", async () => {
    vi.mocked(requireAuthenticatedSession).mockResolvedValue(mockSession);

    const { hashPassword } = await import("../password");
    const hash = await hashPassword("current-password");

    const env = makeEnv(hash);
    const res = await handleChangePassword(
      makeRequest({ currentPassword: "current-password", newPassword: "NewP@ssw0rd99!" }),
      env,
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean }>();
    expect(body.ok).toBe(true);
    // Verify the DB update ran
    expect(env.DB.prepare).toHaveBeenCalledWith("UPDATE users SET password_hash = ? WHERE id = ?");
  });

  it("returns 429 when the per-user rate limit is exceeded", async () => {
    vi.mocked(requireAuthenticatedSession).mockResolvedValue(mockSession);
    const res = await handleChangePassword(
      makeRequest({ currentPassword: "current-password", newPassword: "NewP@ssw0rd99!" }),
      makeEnv("unused-hash", false),
    );
    expect(res.status).toBe(429);
  });

  it("returns the MFA error response when MFA check fails", async () => {
    vi.mocked(requireAuthenticatedSession).mockResolvedValue(mockSession);
    vi.mocked(requireMFA).mockResolvedValue(
      Response.json({ ok: false, error: "mfa_required" }, { status: 200 }),
    );

    const { hashPassword } = await import("../password");
    const hash = await hashPassword("current-password");

    const res = await handleChangePassword(
      makeRequest({ currentPassword: "current-password", newPassword: "NewP@ssw0rd99!" }),
      makeEnv(hash),
    );
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe("mfa_required");
  });
});
