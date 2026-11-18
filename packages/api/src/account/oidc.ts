// Annex as an OpenID Connect relying party of the identity service
// (https://auth.cubityfir.st). Authorization Code + PKCE (S256), state and
// nonce, id_token checked by oauth4webapi (iss, aud, exp, iat, nonce, azp,
// alg pinned to RS256) and its signature verified against the issuer's JWKS.
//
// Shared by the API worker (the docs app) and the admin worker (its own
// client); each passes its own OidcClientConfig.

import * as oauth from "oauth4webapi";
import { hmacSign, hmacVerify, b64url, b64urlDecodeBytes } from "./jwt";

export interface OidcClientConfig {
  issuer: string;
  clientId: string;
  // Absent for a public client (PKCE only).
  clientSecret?: string;
  redirectUri: string;
  postLogoutRedirectUri: string;
  scope: string;
  // Service binding to the identity worker (cubityfirst-auth, default
  // export). Every server-side request whose host is the issuer's host
  // (discovery, JWKS, token) goes through it: Annex's workers share the
  // cubityfir.st zone with auth.cubityfir.st, and a Worker's fetch() to
  // another Worker's hostname on the same zone skips that Worker and hits
  // the origin (a placeholder record), so a public fetch would fail in
  // production. Only the browser redirects (authorize, logout) use the
  // public URL.
  binding?: { fetch(input: string, init?: RequestInit): Promise<Response> };
  // Local dev only: when the binding has no running target (no local
  // `wrangler dev` of the identity worker), fall back to a direct fetch of
  // the issuer URL.
  allowPublicFallback?: boolean;
  // Test hook: replaces the direct fetch (non-binding requests).
  fetchImpl?: typeof fetch;
}

// Routes requests for the issuer's host through the service binding.
export function identityFetch(cfg: Pick<OidcClientConfig, "issuer" | "binding" | "allowPublicFallback" | "fetchImpl">): (url: string, init?: RequestInit) => Promise<Response> {
  const direct = cfg.fetchImpl ?? ((u: string, i?: RequestInit) => fetch(u, i));
  const binding = cfg.binding;
  if (!binding) return direct;
  const issuerHost = new URL(cfg.issuer).host;
  return async (url, init) => {
    if (new URL(url).host !== issuerHost) return direct(url, init);
    if (!cfg.allowPublicFallback) return binding.fetch(url, init);
    // A request body can only be read once; keep a copy for the retry.
    const body = typeof init?.body === "string" || init?.body instanceof URLSearchParams ? init.body : undefined;
    try {
      const res = await binding.fetch(url, init);
      // wrangler dev answers a binding with no local target with a 503.
      if (res.status !== 503) return res;
    } catch {
      // fall through to the direct fetch
    }
    return direct(url, { ...init, body });
  };
}

export interface VerifiedIdentity {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string;
  roles: string[];
  idToken: string;
}

export class OidcError extends Error {
  constructor(readonly code: string, message?: string) {
    super(message ?? code);
  }
}

// ---------------------------------------------------------------------------
// Discovery + JWKS cache (per isolate)
// ---------------------------------------------------------------------------

const DISCOVERY_TTL_MS = 60 * 60 * 1000;
const discoveryCache = new Map<string, { as: oauth.AuthorizationServer; at: number }>();
const jwksCaches = new Map<string, oauth.JWKSCacheInput>();

export function clearOidcCaches(): void {
  discoveryCache.clear();
  jwksCaches.clear();
}

function httpOptions(cfg: OidcClientConfig): oauth.HttpRequestOptions<"GET" | "POST", unknown> {
  const opts: oauth.HttpRequestOptions<"GET" | "POST", unknown> = { signal: () => AbortSignal.timeout(10_000) };
  // Local dev points at `wrangler dev` of the identity worker over http.
  if (new URL(cfg.issuer).protocol === "http:") opts[oauth.allowInsecureRequests] = true;
  if (cfg.binding || cfg.fetchImpl) {
    const f = identityFetch(cfg);
    opts[oauth.customFetch] = (url, init) => f(url, init as RequestInit);
  }
  return opts;
}

export async function discover(cfg: OidcClientConfig, nowMs: number = Date.now()): Promise<oauth.AuthorizationServer> {
  const hit = discoveryCache.get(cfg.issuer);
  if (hit && nowMs - hit.at < DISCOVERY_TTL_MS) return hit.as;
  const issuer = new URL(cfg.issuer);
  const res = await oauth.discoveryRequest(issuer, { ...httpOptions(cfg), algorithm: "oidc" });
  // Validates that the document's `issuer` is exactly the configured issuer.
  const as = await oauth.processDiscoveryResponse(issuer, res);
  discoveryCache.set(cfg.issuer, { as, at: nowMs });
  return as;
}

function client(cfg: OidcClientConfig): oauth.Client {
  return { client_id: cfg.clientId, id_token_signed_response_alg: "RS256" };
}

function clientAuth(cfg: OidcClientConfig): oauth.ClientAuth {
  return cfg.clientSecret ? oauth.ClientSecretBasic(cfg.clientSecret) : oauth.None();
}

// ---------------------------------------------------------------------------
// Login state cookie
// ---------------------------------------------------------------------------
//
// state, nonce and the PKCE verifier live in a short-lived HttpOnly cookie,
// HMAC-signed with the worker's JWT_SECRET so it can't be forged or edited.
// SameSite=Lax: the callback is a top-level GET navigation from the identity
// host, which Lax cookies ride along on.

export const LOGIN_STATE_TTL_MS = 10 * 60 * 1000;

export interface LoginState {
  state: string;
  nonce: string;
  verifier: string;
  returnTo: string;
  exp: number;
}

export async function sealLoginState(s: LoginState, secret: string): Promise<string> {
  const body = b64url(new TextEncoder().encode(JSON.stringify(s)));
  return `${body}.${await hmacSign(`oidc-state.${body}`, secret)}`;
}

export async function openLoginState(sealed: string | null, secret: string, nowMs: number = Date.now()): Promise<LoginState | null> {
  if (!sealed) return null;
  const dot = sealed.indexOf(".");
  if (dot < 1) return null;
  const body = sealed.slice(0, dot);
  if (!(await hmacVerify(`oidc-state.${body}`, sealed.slice(dot + 1), secret))) return null;
  try {
    const s = JSON.parse(new TextDecoder().decode(b64urlDecodeBytes(body))) as LoginState;
    if (typeof s.exp !== "number" || s.exp <= nowMs) return null;
    if (![s.state, s.nonce, s.verifier, s.returnTo].every(v => typeof v === "string" && v.length > 0)) return null;
    return s;
  } catch {
    return null;
  }
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

export function stateCookie(name: string, value: string, opts: { path: string; secure: boolean; maxAgeSec: number }): string {
  return [
    `${name}=${value}`,
    `Path=${opts.path}`,
    `Max-Age=${opts.maxAgeSec}`,
    "HttpOnly",
    "SameSite=Lax",
    ...(opts.secure ? ["Secure"] : []),
  ].join("; ");
}

// Only same-origin app paths: "/x", never "//host", "/\\host" or a scheme.
export function safeReturnTo(raw: string | null | undefined, fallback = "/"): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) return fallback;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return fallback;
  // Reject control characters (CR/LF in particular).
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return fallback;
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Flow
// ---------------------------------------------------------------------------

export interface LoginRedirect {
  url: string;
  state: LoginState;
}

export async function buildLoginRedirect(
  cfg: OidcClientConfig,
  opts: { returnTo: string; prompt?: string; nowMs?: number },
): Promise<LoginRedirect> {
  const as = await discover(cfg, opts.nowMs);
  if (!as.authorization_endpoint) throw new OidcError("misconfigured", "issuer has no authorization_endpoint");
  const verifier = oauth.generateRandomCodeVerifier();
  const state: LoginState = {
    state: oauth.generateRandomState(),
    nonce: oauth.generateRandomNonce(),
    verifier,
    returnTo: opts.returnTo,
    exp: (opts.nowMs ?? Date.now()) + LOGIN_STATE_TTL_MS,
  };
  const url = new URL(as.authorization_endpoint);
  url.searchParams.set("client_id", cfg.clientId);
  url.searchParams.set("redirect_uri", cfg.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", cfg.scope);
  url.searchParams.set("state", state.state);
  url.searchParams.set("nonce", state.nonce);
  url.searchParams.set("code_challenge", await oauth.calculatePKCECodeChallenge(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  if (opts.prompt) url.searchParams.set("prompt", opts.prompt);
  return { url: url.toString(), state };
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

// Completes the callback: checks state (and `iss` when the server sends it),
// redeems the code with the PKCE verifier, validates the id_token claims
// including nonce, and verifies its signature against the JWKS.
export async function completeLogin(cfg: OidcClientConfig, callbackUrl: URL, login: LoginState): Promise<VerifiedIdentity> {
  const as = await discover(cfg);
  const c = client(cfg);

  let params: URLSearchParams;
  try {
    params = oauth.validateAuthResponse(as, c, callbackUrl, login.state);
  } catch (err) {
    if (err instanceof oauth.AuthorizationResponseError) throw new OidcError(err.error, err.error_description ?? undefined);
    throw new OidcError("invalid_callback", String(err));
  }

  const opts = httpOptions(cfg);
  const res = await oauth.authorizationCodeGrantRequest(as, c, clientAuth(cfg), params, cfg.redirectUri, login.verifier, opts);
  let tokens: oauth.TokenEndpointResponse;
  try {
    tokens = await oauth.processAuthorizationCodeResponse(as, c, res, { expectedNonce: login.nonce, requireIdToken: true });
  } catch (err) {
    if (err instanceof oauth.ResponseBodyError) throw new OidcError(err.error, err.error_description ?? undefined);
    throw new OidcError("invalid_token_response", String(err));
  }

  let jwks = jwksCaches.get(cfg.issuer);
  if (!jwks) {
    jwks = {};
    jwksCaches.set(cfg.issuer, jwks);
  }
  try {
    await oauth.validateApplicationLevelSignature(as, res, { ...opts, [oauth.jwksCache]: jwks });
  } catch (err) {
    throw new OidcError("invalid_signature", String(err));
  }

  const claims = oauth.getValidatedIdTokenClaims(tokens);
  if (!claims || typeof claims.sub !== "string" || !claims.sub) throw new OidcError("invalid_id_token", "missing sub");
  const email = asString(claims.email);
  if (!email) throw new OidcError("invalid_id_token", "missing email (request the email scope)");
  const roles = Array.isArray(claims.roles) ? (claims.roles as unknown[]).filter((r): r is string => typeof r === "string") : [];
  return {
    sub: claims.sub,
    email,
    emailVerified: claims.email_verified === true,
    name: asString(claims.name) || email,
    roles,
    idToken: tokens.id_token as string,
  };
}

// RP-initiated logout URL. Falls back to the configured post-logout URI when
// discovery is unavailable, so signing out of Annex never depends on the
// identity service being up.
export async function buildLogoutUrl(cfg: OidcClientConfig, idToken: string | null): Promise<string> {
  let endSession: string | undefined;
  try {
    endSession = (await discover(cfg)).end_session_endpoint;
  } catch (err) {
    console.error("[oidc] discovery failed during logout", String(err));
  }
  if (!endSession) return cfg.postLogoutRedirectUri;
  const url = new URL(endSession);
  if (idToken) url.searchParams.set("id_token_hint", idToken);
  else url.searchParams.set("client_id", cfg.clientId);
  url.searchParams.set("post_logout_redirect_uri", cfg.postLogoutRedirectUri);
  return url.toString();
}
