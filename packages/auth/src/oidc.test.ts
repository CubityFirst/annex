import { describe, it, expect } from "vitest";
import {
  b64urlToBytes,
  bytesToB64url,
  buildDiscoveryDocument,
  buildIdTokenClaims,
  constantTimeEqual,
  rolesForUser,
  deriveS256Challenge,
  derivePublicJwk,
  hashClientSecret,
  parseRedirectUris,
  redirectUriAllowed,
  resolveScopes,
  scopedClaims,
  signRs256,
  verifyClientSecret,
  verifyPkceS256,
  verifyRs256,
  type OidcUser,
  type PrivateJwk,
} from "./oidc";

async function generatePrivateJwk(): Promise<PrivateJwk> {
  const kp = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const jwk = (await crypto.subtle.exportKey("jwk", kp.privateKey)) as PrivateJwk;
  jwk.kid = "test-key";
  jwk.alg = "RS256";
  jwk.use = "sig";
  return jwk;
}

describe("base64url", () => {
  it("round-trips arbitrary bytes", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 255, 64, 63, 62]);
    expect([...b64urlToBytes(bytesToB64url(bytes))]).toEqual([...bytes]);
  });
  it("produces url-safe output with no padding", () => {
    const s = bytesToB64url(new Uint8Array([255, 255, 255]));
    expect(s).not.toMatch(/[+/=]/);
  });
});

describe("PKCE (S256)", () => {
  // RFC 7636 Appendix B reference vector.
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

  it("derives the spec challenge from the spec verifier", async () => {
    expect(await deriveS256Challenge(verifier)).toBe(challenge);
  });
  it("verifies a correct verifier", async () => {
    expect(await verifyPkceS256(verifier, challenge)).toBe(true);
  });
  it("rejects a wrong verifier", async () => {
    expect(await verifyPkceS256("not-the-verifier", challenge)).toBe(false);
  });
  it("rejects empty inputs", async () => {
    expect(await verifyPkceS256("", challenge)).toBe(false);
    expect(await verifyPkceS256(verifier, "")).toBe(false);
  });
});

describe("resolveScopes", () => {
  const allowed = "openid profile email";
  it("intersects requested with allowed", () => {
    expect(resolveScopes("openid email", allowed)).toBe("openid email");
  });
  it("drops scopes the client may not request", () => {
    expect(resolveScopes("openid email", "openid")).toBe("openid");
  });
  it("drops unknown scopes", () => {
    expect(resolveScopes("openid admin profile", allowed)).toBe("openid profile");
  });
  it("requires openid", () => {
    expect(resolveScopes("profile email", allowed)).toBeNull();
    expect(resolveScopes("", allowed)).toBeNull();
    expect(resolveScopes(null, allowed)).toBeNull();
  });
  it("grants roles only when the client allows it", () => {
    expect(resolveScopes("openid roles", "openid profile email roles")).toBe("openid roles");
    // client not allowed `roles` -> it's dropped
    expect(resolveScopes("openid roles", "openid profile email")).toBe("openid");
  });
});

describe("roles", () => {
  const admin: OidcUser = { id: "u1", email: "a@b.com", emailVerified: true, name: "Ada", isAdmin: true };
  const plain: OidcUser = { id: "u2", email: "c@d.com", emailVerified: true, name: "Cy", isAdmin: false };

  it("gives admins the admin role, others just user", () => {
    expect(rolesForUser(admin)).toEqual(["user", "admin"]);
    expect(rolesForUser(plain)).toEqual(["user"]);
  });

  it("only emits the roles claim when the scope is granted", () => {
    expect(scopedClaims(admin, new Set(["openid"]))).not.toHaveProperty("roles");
    expect(scopedClaims(admin, new Set(["openid", "roles"]))).toMatchObject({ roles: ["user", "admin"] });
    expect(scopedClaims(plain, new Set(["openid", "roles"]))).toMatchObject({ roles: ["user"] });
  });
});

describe("redirect URIs", () => {
  it("parses a JSON array and ignores junk", () => {
    expect(parseRedirectUris('["https://a/cb","https://b/cb"]')).toEqual(["https://a/cb", "https://b/cb"]);
    expect(parseRedirectUris("not json")).toEqual([]);
    expect(parseRedirectUris('{"a":1}')).toEqual([]);
  });
  it("matches only on an exact string", () => {
    const reg = ["https://app.example.com/cb"];
    expect(redirectUriAllowed("https://app.example.com/cb", reg)).toBe(true);
    expect(redirectUriAllowed("https://app.example.com/cb/", reg)).toBe(false);
    expect(redirectUriAllowed("https://app.example.com/cb?x=1", reg)).toBe(false);
    expect(redirectUriAllowed("https://evil.example.com/cb", reg)).toBe(false);
    expect(redirectUriAllowed("https://app.example.com.evil.com/cb", reg)).toBe(false);
  });
});

describe("client secrets", () => {
  it("verifies the right secret and rejects the wrong one", async () => {
    const hash = await hashClientSecret("s3cr3t-value");
    expect(await verifyClientSecret("s3cr3t-value", hash)).toBe(true);
    expect(await verifyClientSecret("wrong", hash)).toBe(false);
  });
  it("constantTimeEqual compares correctly", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
  });
});

describe("JWKS derivation", () => {
  it("strips private fields from the public JWK", async () => {
    const priv = await generatePrivateJwk();
    const pub = derivePublicJwk(priv);
    expect(pub).toEqual({ kty: priv.kty, n: priv.n, e: priv.e, alg: "RS256", use: "sig", kid: "test-key" });
    expect(pub).not.toHaveProperty("d");
    expect(pub).not.toHaveProperty("p");
    expect(pub).not.toHaveProperty("q");
  });
});

describe("RS256 sign/verify", () => {
  it("round-trips a payload", async () => {
    const priv = await generatePrivateJwk();
    const token = await signRs256({ sub: "u1", exp: Math.floor(Date.now() / 1000) + 60 }, priv);
    const payload = await verifyRs256(token, priv);
    expect(payload?.sub).toBe("u1");
  });
  it("rejects a tampered signature", async () => {
    const priv = await generatePrivateJwk();
    const token = await signRs256({ sub: "u1" }, priv);
    const tampered = `${token.slice(0, -3)}aaa`;
    expect(await verifyRs256(tampered, priv)).toBeNull();
  });
  it("rejects an expired token", async () => {
    const priv = await generatePrivateJwk();
    const token = await signRs256({ sub: "u1", exp: Math.floor(Date.now() / 1000) - 5 }, priv);
    expect(await verifyRs256(token, priv)).toBeNull();
  });
  it("rejects alg-confusion (none / HS256 headers)", async () => {
    const priv = await generatePrivateJwk();
    const valid = await signRs256({ sub: "u1" }, priv);
    const [, body, sig] = valid.split(".");
    const noneHeader = bytesToB64url(new TextEncoder().encode(JSON.stringify({ alg: "none", typ: "JWT" })));
    const hsHeader = bytesToB64url(new TextEncoder().encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
    expect(await verifyRs256(`${noneHeader}.${body}.`, priv)).toBeNull();
    expect(await verifyRs256(`${hsHeader}.${body}.${sig}`, priv)).toBeNull();
  });
});

describe("claims", () => {
  const user: OidcUser = { id: "u1", email: "a@b.com", emailVerified: true, name: "Ada", isAdmin: false };

  it("scopes claims by grant", () => {
    expect(scopedClaims(user, new Set(["openid"]))).toEqual({ sub: "u1" });
    expect(scopedClaims(user, new Set(["openid", "email"]))).toEqual({
      sub: "u1",
      email: "a@b.com",
      email_verified: true,
    });
    expect(scopedClaims(user, new Set(["openid", "profile"]))).toEqual({ sub: "u1", name: "Ada" });
  });

  it("emits picture under the profile scope when the user has one", () => {
    const withPic: OidcUser = { ...user, picture: "https://app.example/api/avatar/u1" };
    // picture rides the profile scope alongside name...
    expect(scopedClaims(withPic, new Set(["openid", "profile"]))).toEqual({
      sub: "u1",
      name: "Ada",
      picture: "https://app.example/api/avatar/u1",
    });
    // ...not openid alone, and is omitted entirely when unset.
    expect(scopedClaims(withPic, new Set(["openid"]))).toEqual({ sub: "u1" });
    expect(scopedClaims(user, new Set(["openid", "profile"]))).not.toHaveProperty("picture");
  });

  it("builds id_token claims with iss/aud/exp and optional nonce", () => {
    const claims = buildIdTokenClaims({
      issuer: "https://auth.cubityfir.st",
      clientId: "annx_abc",
      user,
      scopes: new Set(["openid", "email"]),
      nonce: "n-123",
      nowSec: 1000,
      ttlSec: 3600,
    });
    expect(claims).toMatchObject({
      iss: "https://auth.cubityfir.st",
      aud: "annx_abc",
      sub: "u1",
      email: "a@b.com",
      email_verified: true,
      nonce: "n-123",
      iat: 1000,
      auth_time: 1000,
      exp: 4600,
    });
  });

  it("omits nonce when not supplied", () => {
    const claims = buildIdTokenClaims({
      issuer: "i",
      clientId: "c",
      user,
      scopes: new Set(["openid"]),
      nowSec: 0,
      ttlSec: 1,
    });
    expect(claims).not.toHaveProperty("nonce");
  });
});

describe("discovery document", () => {
  it("points each endpoint at the right host", () => {
    const doc = buildDiscoveryDocument("https://auth.cubityfir.st", "https://docs.cubityfir.st/oauth/authorize");
    expect(doc).toMatchObject({
      issuer: "https://auth.cubityfir.st",
      authorization_endpoint: "https://docs.cubityfir.st/oauth/authorize",
      token_endpoint: "https://auth.cubityfir.st/oauth/token",
      userinfo_endpoint: "https://auth.cubityfir.st/oauth/userinfo",
      jwks_uri: "https://auth.cubityfir.st/oauth/jwks",
      code_challenge_methods_supported: ["S256"],
      id_token_signing_alg_values_supported: ["RS256"],
      claims_supported: expect.arrayContaining(["picture"]),
    });
  });
});
