// Sign in with auth.cubityfir.st (Annex as an OIDC client).
//
//   GET  /auth/login?return_to=/path  -> 302 to the identity service
//   GET  /auth/callback               -> verifies, upserts the users mirror,
//                                        creates an Annex session, sets the
//                                        single-use handoff cookie, 302 to the
//                                        SPA's /auth/complete#status=ok
//   POST /auth/exchange               -> { token } (redeems the handoff
//                                        cookie once, within 60s)
//   POST /auth/logout                 -> revokes the Annex session and returns
//                                        the identity service's end-session URL
//   POST /dev/quick-login             -> local dev only (DEV_QUICK_LOGIN)
//
// Browser paths are /api/auth/* (the frontend worker and the Vite dev proxy
// strip the /api prefix), so the state cookie is scoped to /api/auth.

import { errorResponse, Errors, okResponse } from "../lib";
import {
  buildLoginRedirect,
  buildLogoutUrl,
  completeLogin,
  openLoginState,
  readCookie,
  safeReturnTo,
  sealLoginState,
  stateCookie,
  OidcError,
  LOGIN_STATE_TTL_MS,
  type OidcClientConfig,
} from "../account/oidc";
import { createPendingSession, createSessionToken, redeemHandoff, revokeSessionByToken, type SessionEnv, type SessionKind } from "../account/session";
import { DEV_USER_PREFIX, isLocalDeploy, refreshMirror, type IdentityUser } from "../account/identity";
import { syncStripeCustomerEmail } from "../account/stripe-client";

export interface AuthRouteEnv extends SessionEnv {
  OIDC_ISSUER?: string;
  OIDC_CLIENT_ID?: string;
  OIDC_CLIENT_SECRET?: string;
  OIDC_REDIRECT_URI?: string;
  OIDC_POST_LOGOUT_REDIRECT_URI?: string;
  APP_ORIGIN?: string;
  // Service binding to the identity worker's HTTP surface (default export of
  // cubityfirst-auth): discovery, JWKS and the token exchange go through it.
  IDENTITY_OIDC?: { fetch(input: string, init?: RequestInit): Promise<Response> };
}

export const STATE_COOKIE = "annex_oidc";
// The single-use handoff code travels ONLY in this HttpOnly, SameSite=Strict
// cookie - never in a URL - so it can be redeemed only by the browser that
// completed the sign-in (a leaked or crafted /auth/complete link carries
// nothing that signs anyone in).
export const HANDOFF_COOKIE = "annex_handoff";
const STATE_COOKIE_PATH = "/api/auth";
export const APP_SCOPE = "openid profile email roles";

// Test hook: lets tests point the flow at a fake identity provider.
let fetchOverride: typeof fetch | undefined;
export function setOidcFetchForTests(f: typeof fetch | undefined): void {
  fetchOverride = f;
}

// One sign-in flow: the docs app and the admin panel each run the same
// login/callback/exchange/logout handlers with their own OIDC client, origin
// and session kind.
export interface AuthFlow {
  kind: SessionKind;
  oidc: OidcClientConfig | null;
  // Origin of the SPA that owns /auth/complete.
  appOrigin: string;
}

function trimOrigin(origin: string): string {
  return origin.replace(/\/+$/, "");
}

export function appOidcConfig(env: AuthRouteEnv): OidcClientConfig | null {
  return oidcConfigFor(env, env.APP_ORIGIN ?? "https://docs.cubityfir.st");
}

// Builds a client config from the OIDC_* vars of whichever worker is asking.
export function oidcConfigFor(env: AuthRouteEnv, origin: string): OidcClientConfig | null {
  if (!env.OIDC_ISSUER || !env.OIDC_CLIENT_ID) return null;
  const base = trimOrigin(origin);
  return {
    issuer: trimOrigin(env.OIDC_ISSUER),
    clientId: env.OIDC_CLIENT_ID,
    clientSecret: env.OIDC_CLIENT_SECRET || undefined,
    redirectUri: env.OIDC_REDIRECT_URI || `${base}/api/auth/callback`,
    // The provider matches this byte for byte against the registration,
    // which is the bare origin (no trailing slash).
    postLogoutRedirectUri: env.OIDC_POST_LOGOUT_REDIRECT_URI || base,
    scope: APP_SCOPE,
    binding: env.IDENTITY_OIDC,
    allowPublicFallback: isLocalDeploy({ APP_ORIGIN: base }),
    fetchImpl: fetchOverride,
  };
}

export function appAuthFlow(env: AuthRouteEnv): AuthFlow {
  const appOrigin = trimOrigin(env.APP_ORIGIN ?? "https://docs.cubityfir.st");
  return { kind: "app", oidc: oidcConfigFor(env, appOrigin), appOrigin };
}

function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  for (const c of cookies) headers.append("Set-Cookie", c);
  return new Response(null, { status: 302, headers });
}

// Sends the browser to the SPA's /auth/complete with the outcome in the URL
// fragment (fragments never reach servers, logs or Referer headers).
function toComplete(flow: AuthFlow, fragment: Record<string, string>, cookies: string[]): Response {
  return redirect(`${flow.appOrigin}/auth/complete#${new URLSearchParams(fragment).toString()}`, cookies);
}

function cookieOpts(flow: AuthFlow, maxAgeSec: number) {
  return { path: STATE_COOKIE_PATH, secure: flow.appOrigin.startsWith("https://"), maxAgeSec };
}

export async function handleLogin(flow: AuthFlow, env: SessionEnv, url: URL): Promise<Response> {
  const cfg = flow.oidc;
  if (!cfg) return Response.json({ ok: false, error: "sign_in_not_configured" }, { status: 503 });
  const returnTo = safeReturnTo(url.searchParams.get("return_to"));
  // Only `login` (force re-authentication) is passed through; anything else
  // would let a link drive the identity service's prompt handling.
  const prompt = url.searchParams.get("prompt") === "login" ? "login" : undefined;
  let login;
  try {
    login = await buildLoginRedirect(cfg, { returnTo, prompt });
  } catch (err) {
    console.error("[auth] login redirect failed", String(err));
    return toComplete(flow, { error: "identity_unavailable" }, []);
  }
  const sealed = await sealLoginState(login.state, env.JWT_SECRET);
  return redirect(login.url, [stateCookie(STATE_COOKIE, sealed, cookieOpts(flow, LOGIN_STATE_TTL_MS / 1000))]);
}

export async function handleCallback(flow: AuthFlow, env: SessionEnv & { STRIPE_SECRET_KEY?: string }, request: Request, url: URL): Promise<Response> {
  const cfg = flow.oidc;
  if (!cfg) return Response.json({ ok: false, error: "sign_in_not_configured" }, { status: 503 });
  const clear = stateCookie(STATE_COOKIE, "", cookieOpts(flow, 0));

  const login = await openLoginState(readCookie(request, STATE_COOKIE), env.JWT_SECRET);
  if (!login) return toComplete(flow, { error: "login_expired" }, [clear]);

  // The user cancelled or the identity service refused: pass the OAuth error
  // code through (a fixed vocabulary - never the free-text description).
  const oauthError = url.searchParams.get("error");
  if (oauthError) {
    const code = /^[a-z_]{1,64}$/.test(oauthError) ? oauthError : "sign_in_failed";
    return toComplete(flow, { error: code }, [clear]);
  }

  // The callback URL the identity service redirected to is our registered
  // redirect_uri; rebuild it from config (behind the frontend worker the
  // request URL is https://api/auth/callback).
  const callbackUrl = new URL(cfg.redirectUri);
  callbackUrl.search = url.search;

  let identity;
  try {
    identity = await completeLogin(cfg, callbackUrl, login);
  } catch (err) {
    const code = err instanceof OidcError ? err.code : "sign_in_failed";
    console.error("[auth] callback failed", { code, err: String(err) });
    return toComplete(flow, { error: /^[a-z_]{1,64}$/.test(code) ? code : "sign_in_failed" }, [clear]);
  }

  const outcome = await startSession(env, request, identity, flow.kind);
  if ("error" in outcome) return toComplete(flow, { error: outcome.error }, [clear]);
  const handoff = handoffCookie(flow, outcome.handoffCode, 60);
  return toComplete(flow, { status: "ok", return_to: login.returnTo }, [clear, handoff]);
}

function handoffCookie(flow: AuthFlow, value: string, maxAgeSec: number): string {
  return stateCookie(HANDOFF_COOKIE, value, cookieOpts(flow, maxAgeSec)).replace("SameSite=Lax", "SameSite=Strict");
}

export async function handleExchange(flow: AuthFlow, env: SessionEnv, request: Request): Promise<Response> {
  const code = readCookie(request, HANDOFF_COOKIE) ?? "";
  const token = code ? await redeemHandoff(env, code, flow.kind) : null;
  const headers = new Headers({ "Cache-Control": "no-store" });
  headers.append("Set-Cookie", handoffCookie(flow, "", 0));
  if (!token) return Response.json({ ok: false, error: "invalid_code" }, { status: 400, headers });
  return Response.json({ ok: true, data: { token } }, { headers });
}

export async function handleLogout(flow: AuthFlow, env: SessionEnv, request: Request): Promise<Response> {
  const authHeader = request.headers.get("Authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const { idToken } = token ? await revokeSessionByToken(env, token, flow.kind) : { idToken: null };
  const logoutUrl = flow.oidc ? await buildLogoutUrl(flow.oidc, idToken) : `${flow.appOrigin}/`;
  return okResponse({ logoutUrl });
}

// The docs app's routes (src/index.ts).
export const handleAuthLogin = (_request: Request, env: AuthRouteEnv, url: URL) => handleLogin(appAuthFlow(env), env, url);
export const handleAuthCallback = (request: Request, env: AuthRouteEnv, url: URL) => handleCallback(appAuthFlow(env), env, request, url);
export const handleAuthExchange = (request: Request, env: AuthRouteEnv) => handleExchange(appAuthFlow(env), env, request);
export const handleAuthLogout = (request: Request, env: AuthRouteEnv) => handleLogout(appAuthFlow(env), env, request);

// Shared by the app and admin callbacks: refuses accounts Annex has blocked
// or processed as deleted, upserts the mirror, creates a pending session.
export async function startSession(
  env: SessionEnv & { STRIPE_SECRET_KEY?: string },
  request: Request,
  identity: { sub: string; email: string; emailVerified: boolean; name: string; roles: string[]; idToken: string },
  kind: SessionKind,
): Promise<{ handoffCode: string } | { error: string }> {
  const [gone, blocked, existing] = await env.DB.batch([
    env.DB.prepare("SELECT 1 AS x FROM identity_deletions WHERE user_id = ?").bind(identity.sub),
    env.DB.prepare("SELECT 1 AS x FROM user_deletions WHERE user_id = ?").bind(identity.sub),
    env.DB.prepare("SELECT created_at, email FROM users WHERE id = ?").bind(identity.sub),
  ]);
  if (gone.results.length > 0) return { error: "account_deleted" };
  if (blocked.results.length > 0) return { error: "account_disabled" };
  if (kind === "admin" && !identity.roles.includes("admin")) return { error: "not_admin" };

  const now = Date.now();
  // The token endpoint only issues tokens to accounts in good standing, so
  // the identity is active right now.
  const user: IdentityUser = {
    id: identity.sub,
    email: identity.email,
    name: identity.name,
    emailVerified: identity.emailVerified,
    isAdmin: identity.roles.includes("admin"),
    status: "active",
    suspendedUntil: null,
    createdAt: (existing.results[0] as { created_at?: string } | undefined)?.created_at ?? new Date(now).toISOString(),
  };
  await refreshMirror(env.DB, user, now, { login: true });
  // The email is changed on the identity service now; keep the Stripe
  // customer's receipt address in step when a sign-in brings a new one.
  const previousEmail = (existing.results[0] as { email?: string } | undefined)?.email;
  if (previousEmail && previousEmail !== user.email) await syncStripeCustomerEmail(env, user.id, user.email);
  const { handoffCode } = await createPendingSession(env.DB, { userId: user.id, kind, request, idToken: identity.idToken, nowMs: now });
  return { handoffCode };
}

type DevVariant = "standard-free" | "standard-ink" | "admin-free" | "admin-ink";

// Local-dev sign-in without the identity service: mints a mirror-only user
// (id prefixed dev-) and a session. Doubly gated: DEV_QUICK_LOGIN must be
// "true" AND APP_ORIGIN must be a localhost origin, so a stray flag in
// production can never mint credential-free sessions. Standing checks skip
// the identity RPC for these users only under the same gate.
//
// Body: { variant } for a fresh dev user, or { email, name?, admin? } to sign
// in as (or create) a specific dev user - the e2e suites use the latter.
export async function handleDevQuickLogin(request: Request, env: AuthRouteEnv & { DEV_QUICK_LOGIN?: string }): Promise<Response> {
  if (env.DEV_QUICK_LOGIN !== "true" || !isLocalDeploy(env)) return errorResponse(Errors.NOT_FOUND);

  const body = await request.json<{ variant?: DevVariant; email?: string; name?: string; admin?: boolean }>().catch(() => null);
  if (!body) return errorResponse(Errors.BAD_REQUEST);

  let id: string;
  let email: string;
  let name: string;
  let isAdmin: boolean;
  let hasInk = false;
  const now = Date.now();

  if (typeof body.email === "string" && body.email.includes("@")) {
    email = body.email.trim().toLowerCase();
    const existing = await env.DB.prepare("SELECT id, name, is_admin FROM users WHERE lower(email) = ? AND id LIKE 'dev-%'")
      .bind(email).first<{ id: string; name: string; is_admin: number }>();
    id = existing?.id ?? `${DEV_USER_PREFIX}${crypto.randomUUID()}`;
    name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : existing?.name ?? email.split("@")[0];
    isAdmin = typeof body.admin === "boolean" ? body.admin : Boolean(existing?.is_admin);
  } else {
    const variant = body.variant ?? "standard-free";
    isAdmin = variant === "admin-free" || variant === "admin-ink";
    hasInk = variant === "standard-ink" || variant === "admin-ink";
    id = `${DEV_USER_PREFIX}${crypto.randomUUID()}`;
    email = `${id.slice(0, 12)}@localhost`;
    name = `${isAdmin ? "Dev Admin" : "Dev User"}${hasInk ? " (Ink)" : ""}`;
  }

  await refreshMirror(env.DB, {
    id, email, name, emailVerified: true, isAdmin, status: "active", suspendedUntil: null, createdAt: new Date(now).toISOString(),
  }, now, { login: true });
  if (hasInk) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO user_billing (user_id, granted_plan, granted_plan_reason, granted_plan_started_at) VALUES (?, 'ink', 'dev', ?)",
    ).bind(id, now).run();
  }
  const token = await createSessionToken(env, { userId: id, email, isAdmin, kind: "app", request });
  return okResponse({ token, userId: id });
}
