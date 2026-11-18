// Sign in with auth.cubityfir.st (Annex as an OIDC client).
//
//   GET  /auth/login?return_to=/path  -> 302 to the identity service
//   GET  /auth/callback               -> verifies, upserts the users mirror,
//                                        creates an Annex session, 302 to the
//                                        SPA's /auth/complete#code=...
//   POST /auth/exchange { code }      -> { token } (single use, 60s)
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
import { createPendingSession, createSessionToken, redeemHandoff, revokeSessionByToken, type SessionEnv } from "../account/session";
import { DEV_USER_PREFIX, isLocalDeploy, refreshMirror, type IdentityUser } from "../account/identity";

export interface AuthRouteEnv extends SessionEnv {
  OIDC_ISSUER?: string;
  OIDC_CLIENT_ID?: string;
  OIDC_CLIENT_SECRET?: string;
  OIDC_REDIRECT_URI?: string;
  OIDC_POST_LOGOUT_REDIRECT_URI?: string;
  APP_ORIGIN?: string;
}

export const STATE_COOKIE = "annex_oidc";
const STATE_COOKIE_PATH = "/api/auth";
export const APP_SCOPE = "openid profile email roles";

// Test hook: lets tests point the flow at a fake identity provider.
let fetchOverride: typeof fetch | undefined;
export function setOidcFetchForTests(f: typeof fetch | undefined): void {
  fetchOverride = f;
}

function appOrigin(env: AuthRouteEnv): string {
  return (env.APP_ORIGIN ?? "https://docs.cubityfir.st").replace(/\/+$/, "");
}

export function appOidcConfig(env: AuthRouteEnv): OidcClientConfig | null {
  if (!env.OIDC_ISSUER || !env.OIDC_CLIENT_ID) return null;
  const origin = appOrigin(env);
  return {
    issuer: env.OIDC_ISSUER.replace(/\/+$/, ""),
    clientId: env.OIDC_CLIENT_ID,
    clientSecret: env.OIDC_CLIENT_SECRET || undefined,
    redirectUri: env.OIDC_REDIRECT_URI || `${origin}/api/auth/callback`,
    postLogoutRedirectUri: env.OIDC_POST_LOGOUT_REDIRECT_URI || `${origin}/`,
    scope: APP_SCOPE,
    fetchImpl: fetchOverride,
  };
}

function isSecure(env: AuthRouteEnv): boolean {
  return appOrigin(env).startsWith("https://");
}

function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  for (const c of cookies) headers.append("Set-Cookie", c);
  return new Response(null, { status: 302, headers });
}

// Sends the browser to the SPA's /auth/complete with the outcome in the URL
// fragment (fragments never reach servers, logs or Referer headers).
function toComplete(env: AuthRouteEnv, fragment: Record<string, string>, cookies: string[]): Response {
  return redirect(`${appOrigin(env)}/auth/complete#${new URLSearchParams(fragment).toString()}`, cookies);
}

function clearStateCookie(env: AuthRouteEnv): string {
  return stateCookie(STATE_COOKIE, "", { path: STATE_COOKIE_PATH, secure: isSecure(env), maxAgeSec: 0 });
}

export async function handleAuthLogin(request: Request, env: AuthRouteEnv, url: URL): Promise<Response> {
  const cfg = appOidcConfig(env);
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
    return toComplete(env, { error: "identity_unavailable" }, []);
  }
  const sealed = await sealLoginState(login.state, env.JWT_SECRET);
  return redirect(login.url, [
    stateCookie(STATE_COOKIE, sealed, { path: STATE_COOKIE_PATH, secure: isSecure(env), maxAgeSec: LOGIN_STATE_TTL_MS / 1000 }),
  ]);
}

export async function handleAuthCallback(request: Request, env: AuthRouteEnv, url: URL): Promise<Response> {
  const cfg = appOidcConfig(env);
  if (!cfg) return Response.json({ ok: false, error: "sign_in_not_configured" }, { status: 503 });
  const clear = clearStateCookie(env);

  const login = await openLoginState(readCookie(request, STATE_COOKIE), env.JWT_SECRET);
  if (!login) return toComplete(env, { error: "login_expired" }, [clear]);

  // The user cancelled or the identity service refused: pass the OAuth error
  // code through (a fixed vocabulary - never the free-text description).
  const oauthError = url.searchParams.get("error");
  if (oauthError) {
    const code = /^[a-z_]{1,64}$/.test(oauthError) ? oauthError : "sign_in_failed";
    return toComplete(env, { error: code }, [clear]);
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
    return toComplete(env, { error: /^[a-z_]{1,64}$/.test(code) ? code : "sign_in_failed" }, [clear]);
  }

  const outcome = await startSession(env, request, identity, "app");
  if ("error" in outcome) return toComplete(env, { error: outcome.error }, [clear]);
  return toComplete(env, { code: outcome.handoffCode, return_to: login.returnTo }, [clear]);
}

// Shared by the app and admin callbacks: refuses accounts Annex has blocked
// or processed as deleted, upserts the mirror, creates a pending session.
export async function startSession(
  env: SessionEnv,
  request: Request,
  identity: { sub: string; email: string; emailVerified: boolean; name: string; roles: string[]; idToken: string },
  kind: "app" | "admin",
): Promise<{ handoffCode: string } | { error: string }> {
  const [gone, blocked, existing] = await env.DB.batch([
    env.DB.prepare("SELECT 1 AS x FROM identity_deletions WHERE user_id = ?").bind(identity.sub),
    env.DB.prepare("SELECT 1 AS x FROM user_deletions WHERE user_id = ?").bind(identity.sub),
    env.DB.prepare("SELECT created_at FROM users WHERE id = ?").bind(identity.sub),
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
  const { handoffCode } = await createPendingSession(env.DB, { userId: user.id, kind, request, idToken: identity.idToken, nowMs: now });
  return { handoffCode };
}

export async function handleAuthExchange(request: Request, env: AuthRouteEnv): Promise<Response> {
  const body = await request.json<{ code?: unknown }>().catch(() => null);
  const code = typeof body?.code === "string" ? body.code : "";
  const token = await redeemHandoff(env, code, "app");
  if (!token) return Response.json({ ok: false, error: "invalid_code" }, { status: 400 });
  return okResponse({ token });
}

export async function handleAuthLogout(request: Request, env: AuthRouteEnv): Promise<Response> {
  const cfg = appOidcConfig(env);
  const authHeader = request.headers.get("Authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const { idToken } = token ? await revokeSessionByToken(env, token, "app") : { idToken: null };
  const logoutUrl = cfg ? await buildLogoutUrl(cfg, idToken) : `${appOrigin(env)}/`;
  return okResponse({ logoutUrl });
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
