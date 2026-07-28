import { requireAuthenticatedSession } from "../auth-session";
import { okResponse, errorResponse, Errors, rateLimitUser } from "../lib";
import { revokeSession } from "../sessions";
import type { Env } from "../index";

export async function handleSessionsRevoke(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{ sessionId?: string }>();
  if (!body.sessionId) return errorResponse(Errors.BAD_REQUEST);

  const session = await requireAuthenticatedSession(request, env);
  if (session instanceof Response) return session;

  const limited = await rateLimitUser(env.RATE_LIMITER_AUTH, `sessions:${session.userId}`);
  if (limited) return limited;

  const ok = await revokeSession(env, body.sessionId, session.userId);
  if (!ok) return errorResponse(Errors.NOT_FOUND);

  return okResponse({});
}
