// OIDC provider primitives for "Sign in with Annex".
//
// This module is deliberately framework-free and mostly pure so the
// security-critical bits (PKCE, scope resolution, exact redirect matching,
// RS256 signing/verification, JWKS derivation) are unit-testable in isolation.
//
// Signing uses RS256 (asymmetric) — NOT the HS256 `JWT_SECRET` used for
// first-party Annex sessions — so connected services can verify id_tokens
// offline against the published JWKS without ever holding an Annex secret.

import { toArrayBuffer } from "./crypto";

const RS = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;

// ---------------------------------------------------------------------------
// base64url + JSON (UTF-8 safe; payloads carry names/emails that may be unicode)
// ---------------------------------------------------------------------------

export function bytesToB64url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlToBytes(input: string): Uint8Array {
  let s = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4;
  if (pad) s += "=".repeat(4 - pad);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function encodeJson(obj: unknown): string {
  return bytesToB64url(new TextEncoder().encode(JSON.stringify(obj)));
}

function decodeJsonPart<T = Record<string, unknown>>(part: string): T {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(part))) as T;
}

// ---------------------------------------------------------------------------
// Hashing / constant-time compare
// ---------------------------------------------------------------------------

async function sha256Bytes(input: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", toArrayBuffer(new TextEncoder().encode(input)));
  return new Uint8Array(digest);
}

export async function sha256b64url(input: string): Promise<string> {
  return bytesToB64url(await sha256Bytes(input));
}

// Length-independent only when both inputs are the same length; we compare
// fixed-length digests so this is a constant-time equality for our use.
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Client secrets are high-entropy random strings, so a single SHA-256 is
// sufficient (unlike user passwords, which need a slow KDF). Mirrors how the
// registration script computes the stored hash.
export async function hashClientSecret(secret: string): Promise<string> {
  return sha256b64url(secret);
}

export async function verifyClientSecret(secret: string, storedHash: string): Promise<boolean> {
  return constantTimeEqual(await sha256b64url(secret), storedHash);
}

// ---------------------------------------------------------------------------
// PKCE (S256 only)
// ---------------------------------------------------------------------------

export async function deriveS256Challenge(verifier: string): Promise<string> {
  return sha256b64url(verifier);
}

export async function verifyPkceS256(verifier: string, challenge: string): Promise<boolean> {
  if (!verifier || !challenge) return false;
  return constantTimeEqual(await deriveS256Challenge(verifier), challenge);
}

// ---------------------------------------------------------------------------
// Scopes / redirect URIs
// ---------------------------------------------------------------------------

// Intersect requested scopes with what the client is allowed, dropping unknowns.
// Returns null if the result wouldn't include `openid` (which OIDC requires).
export function resolveScopes(requested: string | null | undefined, allowed: string): string | null {
  const allow = new Set(allowed.split(/\s+/).filter(Boolean));
  const granted = new Set((requested ?? "").split(/\s+/).filter(Boolean).filter((s) => allow.has(s)));
  if (!granted.has("openid")) return null;
  return [...granted].join(" ");
}

export function parseRedirectUris(json: string): string[] {
  try {
    const arr: unknown = JSON.parse(json);
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

// Exact string match — no prefix/wildcard matching, which is the single most
// important defence against open-redirect / token-theft in an OAuth provider.
export function redirectUriAllowed(redirectUri: string, registered: string[]): boolean {
  return registered.includes(redirectUri);
}

// ---------------------------------------------------------------------------
// RS256 sign / verify + JWKS
// ---------------------------------------------------------------------------

export interface PrivateJwk {
  kty: string;
  n: string;
  e: string;
  d: string;
  kid: string;
  alg?: string;
  use?: string;
  [k: string]: unknown;
}

export interface PublicJwk {
  kty: string;
  n: string;
  e: string;
  alg: "RS256";
  use: "sig";
  kid: string;
}

export function parsePrivateJwk(secret: string): PrivateJwk {
  const jwk = JSON.parse(secret) as PrivateJwk;
  if (jwk.kty !== "RSA" || !jwk.n || !jwk.e || !jwk.d || !jwk.kid) {
    throw new Error("OIDC_PRIVATE_KEY is not a complete RSA private JWK (need kty/n/e/d/kid)");
  }
  return jwk;
}

// The public half is just the private JWK with the private fields stripped —
// an RSA private JWK already carries the public modulus (n) and exponent (e).
export function derivePublicJwk(privateJwk: PrivateJwk): PublicJwk {
  return { kty: privateJwk.kty, n: privateJwk.n, e: privateJwk.e, alg: "RS256", use: "sig", kid: privateJwk.kid };
}

async function importPrivate(jwk: PrivateJwk): Promise<CryptoKey> {
  return crypto.subtle.importKey("jwk", jwk as JsonWebKey, RS, false, ["sign"]);
}

async function importPublic(jwk: PublicJwk): Promise<CryptoKey> {
  return crypto.subtle.importKey("jwk", jwk as JsonWebKey, RS, false, ["verify"]);
}

export async function signRs256(payload: Record<string, unknown>, privateJwk: PrivateJwk): Promise<string> {
  const header = { alg: "RS256", typ: "JWT", kid: privateJwk.kid };
  const signingInput = `${encodeJson(header)}.${encodeJson(payload)}`;
  const key = await importPrivate(privateJwk);
  const sig = await crypto.subtle.sign(RS, key, toArrayBuffer(new TextEncoder().encode(signingInput)));
  return `${signingInput}.${bytesToB64url(new Uint8Array(sig))}`;
}

// Verifies an RS256 JWT signed by THIS provider (alg pinned to RS256 — never
// trust the token's alg to pick the verifier; that's the classic alg-confusion
// hole). Returns the payload, or null if signature/format/exp is bad.
export async function verifyRs256(token: string, privateJwk: PrivateJwk): Promise<Record<string, unknown> | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  let header: { alg?: unknown; typ?: unknown };
  try {
    header = decodeJsonPart(parts[0]);
  } catch {
    return null;
  }
  if (header.alg !== "RS256" || header.typ !== "JWT") return null;

  const key = await importPublic(derivePublicJwk(privateJwk));
  let ok: boolean;
  try {
    ok = await crypto.subtle.verify(
      RS,
      key,
      toArrayBuffer(b64urlToBytes(parts[2])),
      toArrayBuffer(new TextEncoder().encode(`${parts[0]}.${parts[1]}`)),
    );
  } catch {
    return null;
  }
  if (!ok) return null;

  let payload: Record<string, unknown>;
  try {
    payload = decodeJsonPart(parts[1]);
  } catch {
    return null;
  }
  if (typeof payload.exp === "number" && payload.exp * 1000 <= Date.now()) return null;
  return payload;
}

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

export interface OidcUser {
  id: string;
  email: string;
  emailVerified: boolean;
  name: string;
  // Annex platform-admin flag (users.is_admin). Surfaced as the "admin" role
  // when the `roles` scope is granted, so connected services can gate admin-only
  // features. Read live at token/userinfo time, so revoking admin takes effect.
  isAdmin: boolean;
  // Public URL of the user's avatar (`${APP_ORIGIN}/api/avatar/{id}`), set by the
  // token/userinfo handlers and emitted as the `picture` claim under the `profile`
  // scope. The avatar endpoint 404s for users who never uploaded one, so relying
  // parties should fall back to their own placeholder. Optional so unit tests and
  // any non-request caller can omit it.
  picture?: string;
}

// The roles a user carries. Everyone is a "user"; Annex platform-admins also
// get "admin". Kept as an array so more roles can be added without a breaking
// claim-shape change.
export function rolesForUser(user: OidcUser): string[] {
  return user.isAdmin ? ["user", "admin"] : ["user"];
}

// Standard OIDC claims, filtered by the granted scope set. `openid` always
// yields `sub`; `email` adds email/email_verified; `profile` adds name +
// picture (when the caller supplied one); `roles` adds the roles array.
export function scopedClaims(user: OidcUser, scopes: Set<string>): Record<string, unknown> {
  const claims: Record<string, unknown> = { sub: user.id };
  if (scopes.has("email")) {
    claims.email = user.email;
    claims.email_verified = user.emailVerified;
  }
  if (scopes.has("profile")) {
    claims.name = user.name;
    if (user.picture) claims.picture = user.picture;
  }
  if (scopes.has("roles")) {
    claims.roles = rolesForUser(user);
  }
  return claims;
}

export function buildIdTokenClaims(opts: {
  issuer: string;
  clientId: string;
  user: OidcUser;
  scopes: Set<string>;
  nonce?: string | null;
  nowSec: number;
  ttlSec: number;
}): Record<string, unknown> {
  const claims: Record<string, unknown> = {
    iss: opts.issuer,
    aud: opts.clientId,
    iat: opts.nowSec,
    auth_time: opts.nowSec,
    exp: opts.nowSec + opts.ttlSec,
    ...scopedClaims(opts.user, opts.scopes),
  };
  if (opts.nonce) claims.nonce = opts.nonce;
  return claims;
}

export function buildAccessTokenClaims(opts: {
  issuer: string;
  clientId: string;
  sub: string;
  scope: string;
  nowSec: number;
  ttlSec: number;
}): Record<string, unknown> {
  return {
    iss: opts.issuer,
    aud: opts.clientId,
    sub: opts.sub,
    scope: opts.scope,
    token_use: "access",
    iat: opts.nowSec,
    exp: opts.nowSec + opts.ttlSec,
  };
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

// `issuer` is the dedicated identity origin (e.g. https://auth.cubityfir.st).
// `authorizeUrl` is the browser-facing authorization endpoint, which lives on
// the APP origin (docs.cubityfir.st) because that's where the user's Annex
// session exists — OIDC permits endpoints on different hosts.
export function buildDiscoveryDocument(issuer: string, authorizeUrl: string): Record<string, unknown> {
  return {
    issuer,
    authorization_endpoint: authorizeUrl,
    token_endpoint: `${issuer}/oauth/token`,
    userinfo_endpoint: `${issuer}/oauth/userinfo`,
    jwks_uri: `${issuer}/oauth/jwks`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
    scopes_supported: ["openid", "profile", "email", "roles"],
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
    code_challenge_methods_supported: ["S256"],
    claims_supported: ["sub", "iss", "aud", "exp", "iat", "auth_time", "nonce", "email", "email_verified", "name", "picture", "roles"],
  };
}

// ID + access tokens both live 1h. The Annex session that authorized them is
// independent and longer-lived; revoking the Annex session does not retro-kill
// already-issued OIDC tokens (they're short by design).
export const OIDC_TOKEN_TTL_SEC = 60 * 60;
// Authorization codes are single-use and short — matches admin_handoffs.
export const OIDC_CODE_TTL_MS = 5 * 60 * 1000;
