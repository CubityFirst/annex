import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./password", () => ({
  verifyPassword: vi.fn(),
}));

import { requireEnrollmentStepUp } from "./mfa";
import { verifyPassword } from "./password";
import type { Env } from "./index";

function makeEnv(opts?: { hasKey?: boolean; limitSuccess?: boolean }) {
  const first = vi.fn();
  const prepare = vi.fn((sql: string) => ({
    bind: vi.fn(() => ({
      first: vi.fn(async () => {
        if (sql.includes("FROM users")) {
          return { password_hash: "stored-hash", totp_secret: null };
        }
        if (sql.includes("webauthn_credentials")) {
          return opts?.hasKey ? { id: "credential-1" } : null;
        }
        return first();
      }),
    })),
  }));
  const limit = vi.fn(async () => ({ success: opts?.limitSuccess ?? true }));
  const env = {
    DB: { prepare },
    RATE_LIMITER_AUTH: { limit },
  } as unknown as Env;
  return { env, prepare, limit };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(verifyPassword).mockResolvedValue(true);
});

describe("requireEnrollmentStepUp", () => {
  it("rejects first-factor enrollment when a bearer session has no password proof", async () => {
    const { env, limit } = makeEnv();

    const response = await requireEnrollmentStepUp(env, "user-1", {});

    expect(response?.status).toBe(401);
    expect(await response?.json()).toMatchObject({ error: "password_required" });
    expect(verifyPassword).not.toHaveBeenCalled();
    expect(limit).not.toHaveBeenCalled();
  });

  it("accepts the current password for an account with no existing factor", async () => {
    const { env, limit } = makeEnv();

    expect(await requireEnrollmentStepUp(env, "user-1", {
      currentPassword: "current-password",
    })).toBeNull();
    expect(limit).toHaveBeenCalledWith({ key: "enroll-factor:user-1" });
    expect(verifyPassword).toHaveBeenCalledWith("current-password", "stored-hash");
  });

  it("rate-limits password guesses before verifying them", async () => {
    const { env } = makeEnv({ limitSuccess: false });

    const response = await requireEnrollmentStepUp(env, "user-1", {
      currentPassword: "guess",
    });

    expect(response?.status).toBe(429);
    expect(verifyPassword).not.toHaveBeenCalled();
  });

  it("rejects an incorrect current password", async () => {
    vi.mocked(verifyPassword).mockResolvedValue(false);
    const { env } = makeEnv();

    const response = await requireEnrollmentStepUp(env, "user-1", {
      currentPassword: "wrong",
    });

    expect(response?.status).toBe(401);
  });
});
