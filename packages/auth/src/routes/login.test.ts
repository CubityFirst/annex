import { describe, it, expect, vi, beforeEach } from "vitest";
import { checkModeration, handleLogin } from "./login";

vi.mock("../turnstile", () => ({ verifyTurnstile: vi.fn(async () => true) }));
vi.mock("../password", () => ({
  verifyPassword: vi.fn(async () => true),
  hashPassword: vi.fn(async () => "new-hash"),
  needsRehash: vi.fn(() => false),
  DUMMY_PASSWORD_HASH: "dummy-hash",
}));
vi.mock("../jwt", () => ({ signJwt: vi.fn(async () => "signed.jwt"), verifyJwt: vi.fn() }));
vi.mock("../sessions", () => ({
  createSession: vi.fn(async () => "sess-1"),
  SESSION_TTL_MS: 7 * 24 * 60 * 60 * 1000,
}));
vi.mock("../mfa", () => ({
  verifyAndConsumeTotp: vi.fn(async () => true),
  validateAndConsumeBackupCode: vi.fn(async () => true),
}));

import { verifyTurnstile } from "../turnstile";
import { signJwt, verifyJwt } from "../jwt";
import { verifyAndConsumeTotp } from "../mfa";

type UserRow = {
  id: string; email: string; name: string; password_hash: string; created_at: string;
  moderation: number; totp_secret: string | null; force_password_change: number;
  is_admin: number; email_verified: number;
};

function baseUser(overrides?: Partial<UserRow>): UserRow {
  return {
    id: "user-1",
    email: "test@example.com",
    name: "Test",
    password_hash: "hash",
    created_at: "2026-01-01",
    moderation: 0,
    totp_secret: null,
    force_password_change: 0,
    is_admin: 0,
    email_verified: 1,
    ...overrides,
  };
}

// SQL-aware D1 mock: the user SELECT and the webauthn existence check both call
// .first(), so dispatch by the query text. createSession is module-mocked, so no
// session writes hit this.
function makeEnv(opts?: { user?: UserRow | null; hasWebauthn?: boolean; limitSuccess?: boolean }) {
  const user = opts?.user === undefined ? baseUser() : opts.user;
  const hasWebauthn = opts?.hasWebauthn ?? false;
  const run = vi.fn().mockResolvedValue({ meta: { changes: 1 } });
  const prepare = vi.fn((sql: string) => ({
    bind: vi.fn(() => ({
      first: vi.fn(async () => {
        if (sql.includes("FROM users")) return user;
        if (sql.includes("webauthn_credentials")) return hasWebauthn ? { 1: 1 } : null;
        return null;
      }),
      run,
    })),
  }));
  const limit = vi.fn(async () => ({ success: opts?.limitSuccess ?? true }));
  return {
    env: {
      DB: { prepare },
      JWT_SECRET: "secret",
      TURNSTILE_SECRET: "ts-secret",
      RATE_LIMITER_AUTH: { limit },
    } as unknown as Parameters<typeof handleLogin>[1],
    prepare,
    run,
    limit,
  };
}

function req(body: unknown) {
  return new Request("http://localhost/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(verifyTurnstile).mockResolvedValue(true);
  vi.mocked(verifyAndConsumeTotp).mockResolvedValue(true);
  vi.mocked(signJwt).mockResolvedValue("signed.jwt");
});

describe("checkModeration", () => {
  it("returns null for an active account (moderation=0)", () => {
    expect(checkModeration(0)).toBeNull();
  });

  it("returns a 403 account_disabled response for moderation=-1", async () => {
    const res = checkModeration(-1);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
    const body = await res!.json<{ ok: boolean; error: string }>();
    expect(body.error).toBe("account_disabled");
  });

  it("returns a 403 account_suspended response when suspended until a future time", async () => {
    const untilSeconds = Math.floor(Date.now() / 1000) + 3600;
    const res = checkModeration(untilSeconds);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
    const body = await res!.json<{ ok: boolean; error: string; until: number }>();
    expect(body.error).toBe("account_suspended");
    expect(body.until).toBe(untilSeconds);
  });

  it("returns null when a suspension timestamp is in the past (expired)", () => {
    const expiredSeconds = Math.floor(Date.now() / 1000) - 1;
    expect(checkModeration(expiredSeconds)).toBeNull();
  });

  it("returns null when the suspension expires exactly now", () => {
    // nowSeconds === moderation → suspension has just expired
    const nowSeconds = Math.floor(Date.now() / 1000);
    expect(checkModeration(nowSeconds)).toBeNull();
  });
});

describe("handleLogin - 2FA prompt carries a pre-auth token", () => {
  it("includes preAuthToken in the totp_required response", async () => {
    const { env } = makeEnv({ user: baseUser({ totp_secret: "SECRET" }) });
    const res = await handleLogin(req({ email: "test@example.com", password: "pw", turnstileToken: "t" }), env);
    expect(res.status).toBe(200);
    const body = await res.json<{ error: string; preAuthToken: string }>();
    expect(body.error).toBe("totp_required");
    expect(typeof body.preAuthToken).toBe("string");
    expect(body.preAuthToken).toBe("signed.jwt");
    // Signed with the pre2fa marker so only the continuation path can redeem it.
    expect(signJwt).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1", email: "test@example.com", pre2fa: true }),
      "secret",
    );
  });

  it("includes preAuthToken in the two_factor_required response", async () => {
    const { env } = makeEnv({ user: baseUser({ totp_secret: "SECRET" }), hasWebauthn: true });
    const res = await handleLogin(req({ email: "test@example.com", password: "pw", turnstileToken: "t" }), env);
    expect(res.status).toBe(200);
    const body = await res.json<{ error: string; methods: string[]; preAuthToken: string }>();
    expect(body.error).toBe("two_factor_required");
    expect(body.methods).toEqual(["totp", "webauthn"]);
    expect(typeof body.preAuthToken).toBe("string");
    expect(body.preAuthToken).toBe("signed.jwt");
  });
});

describe("handleLogin - pre-auth continuation", () => {
  const validClaims = () => ({ userId: "user-1", email: "test@example.com", expiresAt: Date.now() + 60_000, pre2fa: true });

  it("issues a session for a valid pre-auth token + totpCode without touching Turnstile", async () => {
    vi.mocked(verifyJwt).mockResolvedValue(validClaims() as never);
    const { env } = makeEnv({ user: baseUser({ totp_secret: "SECRET" }) });
    const res = await handleLogin(req({ preAuthToken: "pre.token", totpCode: "123456" }), env);
    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean; data: { token: string; user: { id: string } } }>();
    expect(body.ok).toBe(true);
    expect(body.data.token).toBe("signed.jwt");
    expect(body.data.user.id).toBe("user-1");
    // The whole point of the token: no re-verification of Turnstile.
    expect(verifyTurnstile).not.toHaveBeenCalled();
  });

  it("returns invalid_totp and consumes the MFA rate limit for a wrong code", async () => {
    vi.mocked(verifyJwt).mockResolvedValue(validClaims() as never);
    vi.mocked(verifyAndConsumeTotp).mockResolvedValue(false);
    const { env, limit } = makeEnv({ user: baseUser({ totp_secret: "SECRET" }) });
    const res = await handleLogin(req({ preAuthToken: "pre.token", totpCode: "000000" }), env);
    expect(res.status).toBe(401);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe("invalid_totp");
    expect(limit).toHaveBeenCalledWith({ key: "mfa:user-1" });
  });

  it("returns 401 pre_auth_expired for an expired token", async () => {
    vi.mocked(verifyJwt).mockResolvedValue({ ...validClaims(), expiresAt: Date.now() - 1 } as never);
    const { env } = makeEnv({ user: baseUser({ totp_secret: "SECRET" }) });
    const res = await handleLogin(req({ preAuthToken: "pre.token", totpCode: "123456" }), env);
    expect(res.status).toBe(401);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe("pre_auth_expired");
  });

  it("returns 401 pre_auth_expired for a tampered/garbage token", async () => {
    vi.mocked(verifyJwt).mockResolvedValue(null);
    const { env } = makeEnv({ user: baseUser({ totp_secret: "SECRET" }) });
    const res = await handleLogin(req({ preAuthToken: "garbage", totpCode: "123456" }), env);
    expect(res.status).toBe(401);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe("pre_auth_expired");
  });

  it("refuses a token lacking the pre2fa claim (e.g. a real session token)", async () => {
    // Same secret, valid signature/expiry, but no pre2fa marker.
    vi.mocked(verifyJwt).mockResolvedValue({ userId: "user-1", email: "test@example.com", expiresAt: Date.now() + 60_000, sid: "sess-x" } as never);
    const { env } = makeEnv({ user: baseUser({ totp_secret: "SECRET" }) });
    const res = await handleLogin(req({ preAuthToken: "session.token", totpCode: "123456" }), env);
    expect(res.status).toBe(401);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe("pre_auth_expired");
  });

  it("returns 401 pre_auth_expired when the user row is gone", async () => {
    vi.mocked(verifyJwt).mockResolvedValue(validClaims() as never);
    const { env } = makeEnv({ user: null });
    const res = await handleLogin(req({ preAuthToken: "pre.token", totpCode: "123456" }), env);
    expect(res.status).toBe(401);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe("pre_auth_expired");
  });

  it("returns 401 Unauthorized when TOTP was disabled mid-flow", async () => {
    vi.mocked(verifyJwt).mockResolvedValue(validClaims() as never);
    const { env } = makeEnv({ user: baseUser({ totp_secret: null }) });
    const res = await handleLogin(req({ preAuthToken: "pre.token", totpCode: "123456" }), env);
    expect(res.status).toBe(401);
  });

  it("returns 400 when neither totpCode nor backupCode is supplied", async () => {
    vi.mocked(verifyJwt).mockResolvedValue(validClaims() as never);
    const { env } = makeEnv({ user: baseUser({ totp_secret: "SECRET" }) });
    const res = await handleLogin(req({ preAuthToken: "pre.token" }), env);
    expect(res.status).toBe(400);
  });
});

describe("handleLogin - password path still works", () => {
  it("issues a session for valid credentials with no 2FA", async () => {
    const { env } = makeEnv({ user: baseUser() });
    const res = await handleLogin(req({ email: "test@example.com", password: "pw", turnstileToken: "t" }), env);
    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean; data: { token: string } }>();
    expect(body.ok).toBe(true);
    expect(body.data.token).toBe("signed.jwt");
    expect(verifyTurnstile).toHaveBeenCalledOnce();
  });

  it("rejects a failed Turnstile check", async () => {
    vi.mocked(verifyTurnstile).mockResolvedValue(false);
    const { env } = makeEnv({ user: baseUser() });
    const res = await handleLogin(req({ email: "test@example.com", password: "pw", turnstileToken: "bad" }), env);
    expect(res.status).toBe(400);
  });
});
