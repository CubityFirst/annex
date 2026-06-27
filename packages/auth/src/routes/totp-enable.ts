import { requireAuthenticatedSession } from "../auth-session";
import { okResponse, errorResponse, Errors } from "../lib";
import { verifyTOTP } from "../totp";
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

  // Plain verify - the enrollment code's step is deliberately NOT consumed, so
  // the user can enable TOTP and sign in within the same 30s code window. The
  // login path's replay guard starts consuming from the first login onward.
  const valid = await verifyTOTP(body.secret, body.code);
  if (!valid) return errorResponse(Errors.UNAUTHORIZED);

  await env.DB.prepare("UPDATE users SET totp_secret = ?, totp_last_used_step = NULL WHERE id = ?")
    .bind(body.secret, session.userId)
    .run();

  return okResponse({});
}
