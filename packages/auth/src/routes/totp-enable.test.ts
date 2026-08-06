import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleTotpEnable } from "./totp-enable";

vi.mock("../auth-session", () => ({
  requireAuthenticatedSession: vi.fn(),
}));
vi.mock("../totp", () => ({
  verifyTOTP: vi.fn(),
}));
vi.mock("../mfa", () => ({
  requireEnrollmentStepUp: vi.fn(),
}));

import { requireAuthenticatedSession } from "../auth-session";
import { verifyTOTP } from "../totp";
import { requireEnrollmentStepUp } from "../mfa";

const mockSession = { userId: "user-1", email: "test@example.com", expiresAt: Date.now() + 3600_000 };

function makeEnv(row: { totp_secret: string | null } | null) {
  const run = vi.fn().mockResolvedValue({});
  const first = vi.fn().mockResolvedValue(row);
  const bind = vi.fn().mockReturnValue({ run, first });
  const prepare = vi.fn().mockReturnValue({ bind });
  return { env: { DB: { prepare } } as unknown as Parameters<typeof handleTotpEnable>[1], prepare, bind, run };
}

function req(body: unknown) {
  return new Request("http://localhost/totp/enable", {
    method: "POST",
    headers: { Authorization: "Bearer t", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAuthenticatedSession).mockResolvedValue(mockSession);
  vi.mocked(requireEnrollmentStepUp).mockResolvedValue(null as never);
  vi.mocked(verifyTOTP).mockResolvedValue(true);
});

describe("handleTotpEnable", () => {
  it("rejects a body missing secret/code", async () => {
    const { env } = makeEnv({ totp_secret: null });
    const res = await handleTotpEnable(req({ secret: "S" }), env);
    expect(res.status).toBe(400);
  });

  it("returns 401 when the session is invalid", async () => {
    vi.mocked(requireAuthenticatedSession).mockResolvedValue(
      Response.json({ ok: false, error: "Unauthorized" }, { status: 401 }),
    );
    const { env } = makeEnv({ totp_secret: null });
    const res = await handleTotpEnable(req({ secret: "S", code: "123456" }), env);
    expect(res.status).toBe(401);
  });

  it("refuses to re-enable when TOTP is already on", async () => {
    const { env } = makeEnv({ totp_secret: "EXISTING" });
    const res = await handleTotpEnable(req({ secret: "S", code: "123456" }), env);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("totp_already_enabled");
  });

  it("propagates an MFA challenge failure", async () => {
    vi.mocked(requireEnrollmentStepUp).mockResolvedValue(
      Response.json({ ok: false, error: "mfa_required" }, { status: 401 }) as never,
    );
    const { env, run } = makeEnv({ totp_secret: null });
    const res = await handleTotpEnable(req({ secret: "S", code: "123456" }), env);
    expect(res.status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects an invalid enrollment code", async () => {
    vi.mocked(verifyTOTP).mockResolvedValue(false);
    const { env, run } = makeEnv({ totp_secret: null });
    const res = await handleTotpEnable(req({ secret: "S", code: "000000" }), env);
    expect(res.status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });

  it("enables TOTP and persists the secret on a valid code", async () => {
    const { env, run, bind } = makeEnv({ totp_secret: null });
    const res = await handleTotpEnable(req({ secret: "NEWSECRET", code: "123456" }), env);
    expect(res.status).toBe(200);
    expect(run).toHaveBeenCalledOnce();
    expect(bind).toHaveBeenLastCalledWith("NEWSECRET", "user-1");
  });

  it("passes current password and recovery-code step-up to first-factor enrollment", async () => {
    const { env } = makeEnv({ totp_secret: null });
    await handleTotpEnable(req({
      secret: "NEWSECRET",
      code: "123456",
      currentPassword: "current-password",
      backupCode: "ABCD-1234",
    }), env);

    expect(requireEnrollmentStepUp).toHaveBeenCalledWith(env, "user-1", expect.objectContaining({
      currentPassword: "current-password",
      backupCode: "ABCD-1234",
    }));
  });
});
