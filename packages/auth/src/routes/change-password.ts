import zxcvbn from "zxcvbn";
import { requireAuthenticatedSession } from "../auth-session";
import { okResponse, errorResponse, Errors } from "../lib";
import { verifyPassword, hashPassword } from "../password";
import { requireMFA } from "../mfa";
import { revokeAllSessions } from "../sessions";
import type { Env } from "../index";

export async function handleChangePassword(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{
    currentPassword: string;
    newPassword: string;
    totpCode?: string;
    challengeId?: string;
    webauthnResponse?: unknown;
  }>();

  if (!body.currentPassword || !body.newPassword) {
    return errorResponse(Errors.BAD_REQUEST);
  }

  const session = await requireAuthenticatedSession(request, env);
  if (session instanceof Response) return session;

  if (zxcvbn(body.newPassword).score < 3) {
    return Response.json({ ok: false, error: "password_too_weak" }, { status: 400 });
  }

  const user = await env.DB.prepare(
    "SELECT password_hash FROM users WHERE id = ?",
  ).bind(session.userId).first<{ password_hash: string }>();
  if (!user) return errorResponse(Errors.NOT_FOUND);

  const valid = await verifyPassword(body.currentPassword, user.password_hash);
  if (!valid) return errorResponse(Errors.UNAUTHORIZED);

  const mfaError = await requireMFA(env, session.userId, {
    totpCode: body.totpCode,
    challengeId: body.challengeId,
    webauthnResponse: body.webauthnResponse,
  });
  if (mfaError) return mfaError;

  const newHash = await hashPassword(body.newPassword);
  await env.DB.prepare("UPDATE users SET password_hash = ? WHERE id = ?")
    .bind(newHash, session.userId)
    .run();

  // Kill every other device's session - anyone with a stolen JWT loses
  // access on their next request. Current session stays alive so the user
  // doesn't get bounced out of the page they just changed the password on.
  await revokeAllSessions(env, session.userId, session.sid);

  return okResponse({});
}
