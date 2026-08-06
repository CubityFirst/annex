import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../webauthn", () => ({
  verifyWebauthnAssertion: vi.fn(),
}));
vi.mock("../verification", () => ({
  isEmailVerificationEnabled: vi.fn(),
}));
vi.mock("../jwt", () => ({
  signJwt: vi.fn(async () => "signed.jwt"),
}));
vi.mock("../sessions", () => ({
  createSession: vi.fn(async () => "session-1"),
  SESSION_TTL_MS: 7 * 24 * 60 * 60 * 1000,
}));

import { handleWebauthnAuthFinish } from "./webauthn-auth-finish";
import { verifyWebauthnAssertion } from "../webauthn";
import { isEmailVerificationEnabled } from "../verification";
import { createSession } from "../sessions";

function request() {
  return new Request("http://localhost/webauthn/auth/finish", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      userId: "user-1",
      email: "user@example.com",
      challengeId: "challenge-1",
      response: { id: "credential-1" },
    }),
  });
}

function makeEnv(emailVerified: number) {
  const first = vi.fn().mockResolvedValue({
    id: "user-1",
    email: "user@example.com",
    name: "User",
    created_at: "2026-01-01",
    moderation: 0,
    force_password_change: 0,
    is_admin: 0,
    email_verified: emailVerified,
  });
  const bind = vi.fn().mockReturnValue({ first });
  const prepare = vi.fn().mockReturnValue({ bind });
  return {
    DB: { prepare },
    JWT_SECRET: "secret",
  } as unknown as Parameters<typeof handleWebauthnAuthFinish>[1];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(verifyWebauthnAssertion).mockResolvedValue(null);
  vi.mocked(isEmailVerificationEnabled).mockResolvedValue(false);
});

describe("handleWebauthnAuthFinish email verification", () => {
  it("blocks an unverified account before consuming its assertion challenge", async () => {
    vi.mocked(isEmailVerificationEnabled).mockResolvedValue(true);

    const response = await handleWebauthnAuthFinish(request(), makeEnv(0));

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "email_not_verified" });
    expect(verifyWebauthnAssertion).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
  });

  it("does not consult the feature flag for an already verified account", async () => {
    const response = await handleWebauthnAuthFinish(request(), makeEnv(1));

    expect(response.status).toBe(200);
    expect(isEmailVerificationEnabled).not.toHaveBeenCalled();
    expect(verifyWebauthnAssertion).toHaveBeenCalledOnce();
  });
});
