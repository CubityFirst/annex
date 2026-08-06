import { requireAuthenticatedSession } from "../auth-session";
import { okResponse, errorResponse, Errors } from "../lib";
import { requireMFA } from "../mfa";
import type { Env } from "../index";

export async function handleWebauthnCredentialsDelete(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{
    credentialId: string;
    totpCode?: string;
    challengeId?: string;
    webauthnResponse?: unknown;
    backupCode?: string;
  }>();
  if (!body.credentialId) return errorResponse(Errors.BAD_REQUEST);

  const session = await requireAuthenticatedSession(request, env);
  if (session instanceof Response) return session;

  const mfaError = await requireMFA(env, session.userId, {
    totpCode: body.totpCode,
    challengeId: body.challengeId,
    webauthnResponse: body.webauthnResponse,
    backupCode: body.backupCode,
  });
  if (mfaError) return mfaError;

  const result = await env.DB.prepare(
    "DELETE FROM webauthn_credentials WHERE id = ? AND user_id = ?",
  ).bind(body.credentialId, session.userId).run();

  if (!result.meta.changes || result.meta.changes === 0) return errorResponse(Errors.NOT_FOUND);

  return okResponse({});
}
