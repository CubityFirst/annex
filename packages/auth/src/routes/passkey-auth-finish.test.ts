import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../webauthn", () => ({
  verifyDiscoverableAssertion: vi.fn(),
  verifyWebauthnAssertion: vi.fn(),
}));
vi.mock("../verification", () => ({
  isEmailVerificationEnabled: vi.fn(),
}));
vi.mock("../jwt", () => ({
  signJwt: vi.fn(async () => "signed.jwt"),
  verifyJwt: vi.fn(),
}));
vi.mock("../sessions", () => ({
  createSession: vi.fn(async () => "session-1"),
  SESSION_TTL_MS: 7 * 24 * 60 * 60 * 1000,
}));

import { handlePasskeyAuthFinish } from "./passkey-auth-finish";
import { verifyDiscoverableAssertion } from "../webauthn";
import { isEmailVerificationEnabled } from "../verification";
import { createSession } from "../sessions";

function request(body: Record<string, unknown> = { challengeId: "challenge-1", response: { id: "credential-1" } }) {
  return new Request("http://localhost/webauthn/auth/passkey/finish", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeEnv(overrides: Record<string, unknown> = {}) {
  const user = {
    id: "user-1",
    email: "user@example.com",
    name: "User",
    created_at: "2026-01-01",
    moderation: 0,
    force_password_change: 0,
    is_admin: 0,
    email_verified: 1,
    ...overrides,
  };
  const first = vi.fn().mockResolvedValue(user);
  const run = vi.fn().mockResolvedValue({ meta: { changes: 1 } });
  const bind = vi.fn().mockReturnValue({ first, run });
  const prepare = vi.fn().mockReturnValue({ bind });
  return {
    env: { DB: { prepare }, JWT_SECRET: "secret" } as unknown as Parameters<typeof handlePasskeyAuthFinish>[1],
    bind,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(verifyDiscoverableAssertion).mockResolvedValue({ userId: "user-1" });
  vi.mocked(isEmailVerificationEnabled).mockResolvedValue(false);
});

describe("handlePasskeyAuthFinish", () => {
  it("rejects a request without a challenge or assertion", async () => {
    const { env } = makeEnv();
    const response = await handlePasskeyAuthFinish(request({ challengeId: "c" }), env);
    expect(response.status).toBe(400);
    expect(verifyDiscoverableAssertion).not.toHaveBeenCalled();
  });

  it("issues a session for the account the verified passkey belongs to", async () => {
    const { env, bind } = makeEnv();
    const response = await handlePasskeyAuthFinish(request(), env);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, data: { token: "signed.jwt", user: { id: "user-1" } } });
    expect(bind).toHaveBeenCalledWith("user-1");
    expect(createSession).toHaveBeenCalledOnce();
  });

  it("passes a failed assertion through without loading the account", async () => {
    vi.mocked(verifyDiscoverableAssertion).mockResolvedValue(
      Response.json({ ok: false, error: "unauthorized" }, { status: 401 }),
    );
    const { env, bind } = makeEnv();
    const response = await handlePasskeyAuthFinish(request(), env);

    expect(response.status).toBe(401);
    expect(bind).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
  });

  it("refuses a disabled account", async () => {
    const { env } = makeEnv({ moderation: -1 });
    const response = await handlePasskeyAuthFinish(request(), env);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "account_disabled" });
    expect(createSession).not.toHaveBeenCalled();
  });

  it("gates an unverified account and returns its email for the resend prompt", async () => {
    vi.mocked(isEmailVerificationEnabled).mockResolvedValue(true);
    const { env } = makeEnv({ email_verified: 0 });
    const response = await handlePasskeyAuthFinish(request(), env);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "email_not_verified", email: "user@example.com" });
    expect(createSession).not.toHaveBeenCalled();
  });

  it("routes a forced password change to the change-token flow instead of a session", async () => {
    const { env } = makeEnv({ force_password_change: 1 });
    const response = await handlePasskeyAuthFinish(request(), env);

    expect(await response.json()).toMatchObject({ error: "password_change_required", changeToken: "signed.jwt" });
    expect(createSession).not.toHaveBeenCalled();
  });
});
