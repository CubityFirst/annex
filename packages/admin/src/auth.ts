import type { Env } from "./index";
import { loadCurrentSession, sessionResultToResponse } from "../../api/src/account/session";
import { oidcConfigFor, type AuthFlow } from "../../api/src/routes/auth";

export interface AdminSession {
  userId: string;
  email: string;
  expiresAt: number;
  isAdmin: boolean;
}

// The admin panel is its own first-party OIDC client of auth.cubityfir.st
// (scopes `openid profile email roles`); sign-in requires the `admin` role.
// It runs the same login/callback/exchange/logout handlers as the docs app
// (packages/api/src/routes/auth.ts) with its own client and an 'admin'
// session kind, so a docs-app token is refused here and vice versa.
export function adminAuthFlow(env: Env): AuthFlow {
  const appOrigin = (env.APP_ORIGIN ?? "https://admin.cubityfir.st").replace(/\/+$/, "");
  return { kind: "admin", oidc: oidcConfigFor(env, appOrigin), appOrigin };
}

// Verifies the admin session JWT and re-derives it from cubedocs-main (the
// same loader the API worker uses), with live standing + admin flag from the
// identity service (cached ~60s).
//
// Returns:
//   AdminSession - token valid; account in good standing.
//   Response     - token valid but the account is disabled / suspended.
//   null         - no/malformed Authorization header, or the token/session
//                  is invalid, revoked, expired or not an admin session.
export async function verifySession(
  request: Request,
  env: Env,
  ctx?: ExecutionContext,
): Promise<AdminSession | Response | null> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;

  const result = await loadCurrentSession(authHeader.slice(7), env, "admin", ctx);
  if (result.kind === "ok") {
    return {
      userId: result.session.userId,
      email: result.session.email,
      expiresAt: result.session.expiresAt,
      isAdmin: result.session.isAdmin,
    };
  }
  if (result.kind === "invalid") return null;
  return sessionResultToResponse(result);
}

export async function requireAdminSession(
  request: Request,
  env: Env,
  ctx?: ExecutionContext,
): Promise<AdminSession | Response> {
  const session = await verifySession(request, env, ctx);

  if (session === null) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  if (session instanceof Response) {
    return session;
  }
  // The admin role is re-checked live (identity service, ~60s cache), not
  // just at sign-in: removing it on auth.cubityfir.st locks the panel.
  if (!session.isAdmin) {
    return Response.json({ ok: false, error: "Forbidden" }, { status: 403 });
  }
  return session;
}
