import { requireAuthenticatedSession } from "../auth-session";
import { okResponse } from "../lib";
import type { Env } from "../index";

// Drop the caller's pending email change (all unconsumed change tokens).
// Idempotent - cancelling with nothing pending is a no-op success.
export async function handleChangeEmailCancel(request: Request, env: Env): Promise<Response> {
  const session = await requireAuthenticatedSession(request, env);
  if (session instanceof Response) return session;

  await env.DB.prepare(
    "DELETE FROM email_verification_tokens WHERE user_id = ? AND email IS NOT NULL",
  ).bind(session.userId).run();

  return okResponse({});
}
