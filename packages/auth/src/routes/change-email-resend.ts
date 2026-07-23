import { requireAuthenticatedSession } from "../auth-session";
import { okResponse, errorResponse, Errors } from "../lib";
import { createVerificationToken } from "../verification";
import { sendEmailChangeConfirmEmail } from "../email";
import type { Env } from "../index";

// Floor between resends. The pending address is caller-chosen with no
// ownership proof, so resend is an unsolicited-email lever pointed at an
// arbitrary mailbox - the per-IP/per-user limiters cap bursts, this caps the
// sustained rate per pending change.
const RESEND_MIN_AGE_MS = 5 * 60 * 1000;

// Re-send the confirm link for the caller's own pending email change with a
// fresh 24h TTL. No anti-enumeration dance needed - authenticated and scoped
// to the caller.
export async function handleChangeEmailResend(request: Request, env: Env): Promise<Response> {
  const session = await requireAuthenticatedSession(request, env);
  if (session instanceof Response) return session;

  // Per-user throttle on top of the router's per-IP one (see change-email.ts).
  const { success } = await env.RATE_LIMITER_EMAIL_VERIFY.limit({ key: `change-email:${session.userId}` });
  if (!success) return errorResponse(Errors.RATE_LIMITED);

  const pending = await env.DB.prepare(
    "SELECT email, created_at FROM email_verification_tokens WHERE user_id = ? AND email IS NOT NULL AND consumed_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 1",
  ).bind(session.userId, Date.now()).first<{ email: string; created_at: number }>();

  if (!pending) {
    return Response.json({ ok: false, error: "no_pending_change" }, { status: 400 });
  }

  if (Date.now() - pending.created_at < RESEND_MIN_AGE_MS) {
    return Response.json({ ok: false, error: "too_soon" }, { status: 429 });
  }

  await env.DB.prepare(
    "DELETE FROM email_verification_tokens WHERE user_id = ? AND email IS NOT NULL",
  ).bind(session.userId).run();

  const token = await createVerificationToken(env, session.userId, pending.email);
  const verifyUrl = `${env.APP_ORIGIN}/verify-email?token=${token}`;
  const sent = await sendEmailChangeConfirmEmail(env, pending.email, verifyUrl);
  if (!sent) {
    // Keep the rotated token so the pending state survives; the min-age gate
    // above naturally spaces out the retry.
    return Response.json({ ok: false, error: "send_failed" }, { status: 500 });
  }

  return okResponse({ sent: true, pendingEmail: pending.email });
}
