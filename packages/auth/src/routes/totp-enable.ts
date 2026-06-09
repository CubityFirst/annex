import { requireAuthenticatedSession } from "../auth-session";
import { okResponse, errorResponse, Errors } from "../lib";
import { matchTotpStep } from "../totp";
import { requireMFA } from "../mfa";
import type { Env } from "../index";

export async function handleTotpEnable(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{
    secret: string;
    code: string;
    totpCode?: string;
    challengeId?: string;
    webauthnResponse?: unknown;
  }>();
  if (!body.secret || !body.code) return errorResponse(Errors.BAD_REQUEST);

  const session = await requireAuthenticatedSession(request, env);
  if (session instanceof Response) return session;

  const existing = await env.DB.prepare(
    "SELECT totp_secret FROM users WHERE id = ?",
  ).bind(session.userId).first<{ totp_secret: string | null }>();
  if (!existing) return errorResponse(Errors.NOT_FOUND);

  if (existing.totp_secret) {
    return Response.json({ ok: false, error: "totp_already_enabled" }, { status: 400 });
  }

  const mfaError = await requireMFA(env, session.userId, {
    totpCode: body.totpCode,
    challengeId: body.challengeId,
    webauthnResponse: body.webauthnResponse,
  });
  if (mfaError) return mfaError;

  // Store the enrollment code's time step alongside the secret so the same
  // code can't be replayed at login — verification only accepts later steps.
  const step = await matchTotpStep(body.secret, body.code);
  if (step === null) return errorResponse(Errors.UNAUTHORIZED);

  await env.DB.prepare("UPDATE users SET totp_secret = ?, totp_last_used_step = ? WHERE id = ?")
    .bind(body.secret, step, session.userId)
    .run();

  return okResponse({});
}
