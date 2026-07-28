import { requireAuthenticatedSession } from "../auth-session";
import { okResponse } from "../lib";
import { revokeAllSessions } from "../sessions";
import type { Env } from "../index";

export async function handleSessionsRevokeOthers(request: Request, env: Env): Promise<Response> {
  const session = await requireAuthenticatedSession(request, env);
  if (session instanceof Response) return session;

  // Deliberately NOT rate limited. This is the panic button for a compromised
  // account: a fail-closed per-user limit would let an attacker holding a
  // stolen session keep the bucket exhausted and block the victim from revoking
  // them. Spamming it buys an attacker nothing (it only revokes sessions), and
  // the handler is a single cheap D1 statement.
  await revokeAllSessions(env, session.userId, session.sid);
  return okResponse({});
}
