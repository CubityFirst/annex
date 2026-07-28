import { requireAuthenticatedSession } from "../auth-session";
import { okResponse, rateLimitUser } from "../lib";
import { revokeSession } from "../sessions";
import type { Env } from "../index";

export async function handleSessionsLogout(request: Request, env: Env): Promise<Response> {
  const session = await requireAuthenticatedSession(request, env);
  if (session instanceof Response) return session;

  const limited = await rateLimitUser(env.RATE_LIMITER_AUTH, `sessions:${session.userId}`);
  if (limited) return limited;

  if (session.sid) await revokeSession(env, session.sid, session.userId);
  return okResponse({});
}
