import { requireAuthenticatedSession } from "../auth-session";
import { okResponse } from "../lib";
import { createVerificationToken } from "../verification";
import { sendEmailChangeConfirmEmail } from "../email";
import type { Env } from "../index";

// Re-send the confirm link for the caller's own pending email change with a
// fresh 24h TTL. No anti-enumeration dance needed - authenticated and scoped
// to the caller.
export async function handleChangeEmailResend(request: Request, env: Env): Promise<Response> {
  const session = await requireAuthenticatedSession(request, env);
  if (session instanceof Response) return session;

  const pending = await env.DB.prepare(
    "SELECT email FROM email_verification_tokens WHERE user_id = ? AND email IS NOT NULL AND consumed_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 1",
  ).bind(session.userId, Date.now()).first<{ email: string }>();

  if (!pending) {
    return Response.json({ ok: false, error: "no_pending_change" }, { status: 400 });
  }

  await env.DB.prepare(
    "DELETE FROM email_verification_tokens WHERE user_id = ? AND email IS NOT NULL",
  ).bind(session.userId).run();

  const token = await createVerificationToken(env, session.userId, pending.email);
  const verifyUrl = `${env.APP_ORIGIN}/verify-email?token=${token}`;
  await sendEmailChangeConfirmEmail(env, pending.email, verifyUrl);

  return okResponse({ sent: true, pendingEmail: pending.email });
}
