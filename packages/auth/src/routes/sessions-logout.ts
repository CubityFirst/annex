import { requireAuthenticatedSession } from "../auth-session";
import { okResponse } from "../lib";
import { revokeSession } from "../sessions";
import type { Env } from "../index";

export async function handleSessionsLogout(request: Request, env: Env): Promise<Response> {
  const session = await requireAuthenticatedSession(request, env);
  if (session instanceof Response) return session;

  // Deliberately NOT rate limited. Logout is self-limiting - a successful call
  // revokes the very session that authenticated it, so replays fail auth - and
  // the client fires it best-effort and ignores the result, so a 429 here would
  // silently leave the server-side session alive: the exact outcome this
  // endpoint exists to prevent.
  if (session.sid) await revokeSession(env, session.sid, session.userId);
  return okResponse({});
}
