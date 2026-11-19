import { errorResponse, Errors, type Session } from "../lib";
import { authenticate } from "../auth";
import type { Env } from "../index";

// The per-route session check the account routes (routes/me/*) were written
// against in the old auth worker: an authenticated docs-app session, or the
// Response to return (401, or 403 for a disabled/suspended/blocked account).
export async function requireAuthenticatedSession(request: Request, env: Env): Promise<Session | Response> {
  const result = await authenticate(request, env);
  if (result === null) return errorResponse(Errors.UNAUTHORIZED);
  return result;
}
