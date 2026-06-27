import type { Env } from "./index";
import { loadCurrentSession, sessionResultToResponse } from "../../auth/src/session";

export interface AdminSession {
  userId: string;
  email: string;
  expiresAt: number;
  isAdmin: boolean;
}

// Verifies the JWT and re-derives the session against the auth DB inline
// via the AUTH_DB binding (one D1 batch), mirroring the API worker
// (packages/api/src/auth.ts) instead of round-tripping the auth worker's
// /verify route - that doubled the billable Worker invocations on every
// admin request and contradicted the documented verification boundary.
//
// Returns:
//   AdminSession - token valid; account in good standing.
//   Response     - token valid but the account is disabled / suspended.
//                  Pass this straight back to the client.
//   null         - no/malformed Authorization header, or the token itself
//                  was invalid/expired (incl. force-password-change).
export async function verifySession(
  request: Request,
  env: Env,
): Promise<AdminSession | Response | null> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;

  const result = await loadCurrentSession(authHeader.slice(7), env.AUTH_DB, env.JWT_SECRET);
  if (result.kind === "ok") {
    return {
      userId: result.session.userId,
      email: result.session.email,
      expiresAt: result.session.expiresAt,
      isAdmin: result.session.isAdmin ?? false,
    };
  }
  if (result.kind === "invalid") return null;
  return sessionResultToResponse(result);
}

export async function requireAdminSession(
  request: Request,
  env: Env,
): Promise<AdminSession | Response> {
  const session = await verifySession(request, env);

  if (session === null) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  if (session instanceof Response) {
    return session;
  }
  if (!session.isAdmin) {
    return Response.json({ ok: false, error: "Forbidden" }, { status: 403 });
  }
  return session;
}
