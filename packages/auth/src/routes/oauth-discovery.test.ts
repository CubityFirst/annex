import { describe, it, expect } from "vitest";
import { handleOAuthDiscovery, handleOAuthJwks } from "./oauth-discovery";

// A structurally complete RSA private JWK (values are opaque to these handlers -
// nothing here signs or verifies), so the real ../oidc helpers run end to end.
const PRIVATE_JWK = { kty: "RSA", n: "modulus", e: "AQAB", d: "priv-d", p: "priv-p", q: "priv-q", dp: "priv-dp", dq: "priv-dq", qi: "priv-qi", kid: "k1" };

const env = {
  OIDC_ISSUER: "https://auth.example.com",
  OIDC_AUTHORIZE_URL: "https://app.example.com/oauth/authorize",
  OIDC_PRIVATE_KEY: JSON.stringify(PRIVATE_JWK),
} as unknown as Parameters<typeof handleOAuthDiscovery>[1];

describe("handleOAuthDiscovery", () => {
  it("serves the discovery doc with a cache header", async () => {
    const res = handleOAuthDiscovery(new Request("http://localhost/.well-known/openid-configuration"), env);
    expect(res.headers.get("Cache-Control")).toContain("max-age=3600");
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.issuer).toBe("https://auth.example.com");
    expect(json.authorization_endpoint).toBe("https://app.example.com/oauth/authorize");
    expect(json.jwks_uri).toBe("https://auth.example.com/oauth/jwks");
  });
});

describe("handleOAuthJwks", () => {
  it("publishes only the public JWK (private fields stripped)", async () => {
    const res = handleOAuthJwks(new Request("http://localhost/oauth/jwks"), env);
    expect(res.headers.get("Cache-Control")).toContain("max-age=3600");
    const json = (await res.json()) as { keys: Array<Record<string, unknown>> };
    expect(json.keys).toEqual([{ kty: "RSA", n: "modulus", e: "AQAB", alg: "RS256", use: "sig", kid: "k1" }]);
  });
});
