import { requireAuthenticatedSession } from "../auth-session";
import { okResponse, errorResponse, Errors } from "../lib";
import { requireMFA } from "../mfa";
import type { Env } from "../index";

export async function handleTotpDisable(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{
    totpCode?: string;
    challengeId?: string;
    webauthnResponse?: unknown;
  }>();
  const session = await requireAuthenticatedSession(request, env);
  if (session instanceof Response) return session;

  const user = await env.DB.prepare(
    "SELECT totp_secret FROM users WHERE id = ?",
  ).bind(session.userId).first<{ totp_secret: string | null }>();
  if (!user) return errorResponse(Errors.NOT_FOUND);
  if (!user.totp_secret) return errorResponse(Errors.BAD_REQUEST);

  const mfaError = await requireMFA(env, session.userId, {
    totpCode: body.totpCode,
    challengeId: body.challengeId,
    webauthnResponse: body.webauthnResponse,
  });
  if (mfaError) return mfaError;

  // Clear the replay guard with the secret: a future re-enrollment must be
  // able to accept a code from the current time step.
  await env.DB.prepare("UPDATE users SET totp_secret = NULL, totp_last_used_step = NULL WHERE id = ?")
    .bind(session.userId)
    .run();

  return okResponse({});
}
