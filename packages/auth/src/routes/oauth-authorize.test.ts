import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleOAuthAuthorize } from "./oauth-authorize";

vi.mock("../auth-session", () => ({ requireAuthenticatedSession: vi.fn() }));
vi.mock("../oidc", () => ({
  OIDC_CODE_TTL_MS: 60_000,
  parseRedirectUris: vi.fn((s: string) => s.split(",")),
  redirectUriAllowed: vi.fn(() => true),
  resolveScopes: vi.fn(() => "openid profile"),
}));

import { requireAuthenticatedSession } from "../auth-session";
import { redirectUriAllowed, resolveScopes } from "../oidc";

const mockSession = { userId: "user-1", email: "user@example.com", expiresAt: Date.now() + 3600_000 };

const trustedClient = {
  client_id: "client-1", client_name: "App", redirect_uris: "https://app/cb",
  allowed_scopes: "openid profile", trusted: 1, disabled: 0,
};

function makeEnv(client: typeof trustedClient | null, rateLimitSuccess = true) {
  const first = vi.fn().mockResolvedValue(client);
  const run = vi.fn().mockResolvedValue({ meta: { changes: 1 } });
  const bind = vi.fn().mockReturnValue({ first, run });
  const prepare = vi.fn().mockReturnValue({ bind });
  const limit = vi.fn().mockResolvedValue({ success: rateLimitSuccess });
  return { env: { DB: { prepare }, RATE_LIMITER_OIDC: { limit } } as unknown as Parameters<typeof handleOAuthAuthorize>[1], prepare, bind, run, first, limit };
}

const base = {
  client_id: "client-1", redirect_uri: "https://app/cb", response_type: "code",
  scope: "openid profile", state: "xyz", code_challenge: "abc", code_challenge_method: "S256",
};

function req(body: Record<string, unknown>) {
  return new Request("http://localhost/oauth/authorize", {
    method: "POST",
    headers: { Authorization: "Bearer t", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAuthenticatedSession).mockResolvedValue(mockSession);
  vi.mocked(redirectUriAllowed).mockReturnValue(true);
  vi.mocked(resolveScopes).mockReturnValue("openid profile");
});

describe("handleOAuthAuthorize", () => {
  it("returns 401 when the session is invalid", async () => {
    vi.mocked(requireAuthenticatedSession).mockResolvedValue(
      Response.json({ ok: false, error: "Unauthorized" }, { status: 401 }),
    );
    const { env } = makeEnv(trustedClient);
    const res = await handleOAuthAuthorize(req(base), env);
    expect(res.status).toBe(401);
  });

  it("returns 429 before reading or writing OAuth state when the user limit is exceeded", async () => {
    const { env, prepare, limit } = makeEnv(trustedClient, false);
    const res = await handleOAuthAuthorize(req(base), env);
    expect(res.status).toBe(429);
    expect(limit).toHaveBeenCalledWith({ key: "oidc-authorize:user-1" });
    expect(prepare).not.toHaveBeenCalled();
  });

  it("rejects a body missing client_id / redirect_uri", async () => {
    const { env } = makeEnv(trustedClient);
    const res = await handleOAuthAuthorize(req({ client_id: "client-1" }), env);
    expect(res.status).toBe(400);
  });

  it("400s (never redirects) for an unknown/disabled client", async () => {
    const { env } = makeEnv(null);
    const res = await handleOAuthAuthorize(req(base), env);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("invalid_client");
  });

  it("400s (never redirects) for a redirect_uri off the allowlist", async () => {
    vi.mocked(redirectUriAllowed).mockReturnValue(false);
    const { env } = makeEnv(trustedClient);
    const res = await handleOAuthAuthorize(req(base), env);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("invalid_redirect_uri");
  });

  it("redirects with access_denied when the user denies", async () => {
    const { env } = makeEnv(trustedClient);
    const res = await handleOAuthAuthorize(req({ ...base, denied: true }), env);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { redirectTo: string } };
    expect(json.data.redirectTo).toContain("error=access_denied");
    expect(json.data.redirectTo).toContain("state=xyz");
  });

  it("redirects with unsupported_response_type for non-code flows", async () => {
    const { env } = makeEnv(trustedClient);
    const res = await handleOAuthAuthorize(req({ ...base, response_type: "token" }), env);
    const json = (await res.json()) as { data: { redirectTo: string } };
    expect(json.data.redirectTo).toContain("error=unsupported_response_type");
  });

  it("redirects with invalid_scope when scope resolution fails", async () => {
    vi.mocked(resolveScopes).mockReturnValue(null as never);
    const { env } = makeEnv(trustedClient);
    const res = await handleOAuthAuthorize(req(base), env);
    const json = (await res.json()) as { data: { redirectTo: string } };
    expect(json.data.redirectTo).toContain("error=invalid_scope");
  });

  it("redirects with invalid_request when PKCE is missing / not S256", async () => {
    const { env } = makeEnv(trustedClient);
    const res = await handleOAuthAuthorize(req({ ...base, code_challenge_method: "plain" }), env);
    const json = (await res.json()) as { data: { redirectTo: string } };
    expect(json.data.redirectTo).toContain("error=invalid_request");
  });

  it("returns consentRequired for an untrusted client without approval", async () => {
    const { env, run } = makeEnv({ ...trustedClient, trusted: 0 });
    const res = await handleOAuthAuthorize(req(base), env);
    const json = (await res.json()) as { data: { consentRequired: boolean; scope: string; email: string } };
    expect(json.data.consentRequired).toBe(true);
    expect(json.data.email).toBe("user@example.com");
    // no code minted yet
    expect(run).not.toHaveBeenCalled();
  });

  it("mints a code and returns redirectTo for a trusted client", async () => {
    const { env, run } = makeEnv(trustedClient);
    const res = await handleOAuthAuthorize(req(base), env);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { redirectTo: string } };
    expect(json.data.redirectTo).toContain("code=");
    expect(json.data.redirectTo).toContain("state=xyz");
    // GC delete + code INSERT
    expect(run).toHaveBeenCalledTimes(2);
  });
});
