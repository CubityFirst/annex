import type { Session } from "./lib";
import type { Env } from "./index";
import { loadCurrentSession, sessionResultToResponse } from "./account/session";

// Verifies the Annex session JWT and re-derives the session from cubedocs-main
// (one D1 batch: users mirror + billing + prefs + session row), with account
// standing from the identity service (cached ~60s, see account/identity.ts).
//
// Returns:
//   Session  - authenticated; account is in good standing.
//   Response - token was valid but the account is disabled / suspended /
//              blocked by a pending admin deletion. Pass it straight back.
//   null     - no/malformed Authorization header, or the token/session is
//              invalid, revoked or expired. Caller maps this to a 401.
export async function authenticate(
  request: Request,
  env: Env,
  ctx?: { waitUntil(p: Promise<unknown>): void },
): Promise<Session | Response | null> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;

  const result = await loadCurrentSession(authHeader.slice(7), env, "app", ctx);
  if (result.kind === "ok") {
    const s = result.session;
    return {
      userId: s.userId,
      email: s.email,
      name: s.name,
      expiresAt: s.expiresAt,
      personalPlan: s.personalPlan,
      personalPlanSince: s.personalPlanSince,
      personalPlanStatus: s.personalPlanStatus,
      personalPlanCancelAt: s.personalPlanCancelAt,
      personalPlanStyle: s.personalPlanStyle,
      personalPresenceColor: s.personalPresenceColor,
      personalCritSparkles: s.personalCritSparkles,
      readingFont: s.readingFont,
      editingFont: s.editingFont,
      uiFont: s.uiFont,
      isAdmin: s.isAdmin,
      sid: s.sid,
      themeMode: s.themeMode,
      themeCustomColor: s.themeCustomColor,
    };
  }
  if (result.kind === "invalid") return null;
  return sessionResultToResponse(result);
}
