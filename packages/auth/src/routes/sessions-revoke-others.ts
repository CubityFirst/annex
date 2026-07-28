import { requireAuthenticatedSession } from "../auth-session";
import { okResponse, rateLimitUser } from "../lib";
import { revokeAllSessions } from "../sessions";
import type { Env } from "../index";

export async function handleSessionsRevokeOthers(request: Request, env: Env): Promise<Response> {
  const session = await requireAuthenticatedSession(request, env);
  if (session instanceof Response) return session;

  const limited = await rateLimitUser(env.RATE_LIMITER_AUTH, `sessions:${session.userId}`);
  if (limited) return limited;

  await revokeAllSessions(env, session.userId, session.sid);
  return okResponse({});
}
