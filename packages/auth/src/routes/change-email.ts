import { requireAuthenticatedSession } from "../auth-session";
import { okResponse, errorResponse, Errors, normalizeEmail, isUniqueConstraintError } from "../lib";
import { verifyPassword } from "../password";
import { requireMFA } from "../mfa";
import { createVerificationToken, isEmailVerificationEnabled } from "../verification";
import { sendEmailChangeConfirmEmail, sendEmailChangedNotice } from "../email";
import { syncStripeCustomerEmail } from "../stripe-client";
import type { Env } from "../index";

// Change the account email. Gated like change-password: current password +
// MFA when enrolled. Behavior depends on the `email-verification` flag:
// - flag OFF: apply immediately with email_verified = 0 (mirrors signup).
// - flag ON: confirm-first - users.email is untouched until the link sent to
//   the NEW address is clicked (unverified users are blocked at login while
//   the flag is on, so an immediate change with a typo'd address would lock
//   the user out).
export async function handleChangeEmail(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{
    newEmail?: string;
    currentPassword?: string;
    totpCode?: string;
    challengeId?: string;
    webauthnResponse?: unknown;
    backupCode?: string;
  }>();

  if (!body.newEmail || typeof body.newEmail !== "string" || !body.currentPassword) {
    return errorResponse(Errors.BAD_REQUEST);
  }

  const session = await requireAuthenticatedSession(request, env);
  if (session instanceof Response) return session;

  // Per-user throttle on top of the router's per-IP one: the pending address
  // is caller-chosen with no ownership proof, so an IP-rotating attacker must
  // not be able to fan unsolicited confirm emails at a victim address (and
  // this also caps per-account password-guess attempts on this route).
  const { success } = await env.RATE_LIMITER_EMAIL_VERIFY.limit({ key: `change-email:${session.userId}` });
  if (!success) return errorResponse(Errors.RATE_LIMITED);

  const email = normalizeEmail(body.newEmail);
  if (!email || !email.includes("@")) return errorResponse(Errors.BAD_REQUEST);

  const user = await env.DB.prepare(
    "SELECT email, password_hash FROM users WHERE id = ?",
  ).bind(session.userId).first<{ email: string; password_hash: string }>();
  if (!user) return errorResponse(Errors.NOT_FOUND);

  if (email === user.email) {
    return Response.json({ ok: false, error: "same_email" }, { status: 400 });
  }

  const valid = await verifyPassword(body.currentPassword, user.password_hash);
  if (!valid) return errorResponse(Errors.UNAUTHORIZED);

  const mfaError = await requireMFA(env, session.userId, {
    totpCode: body.totpCode,
    challengeId: body.challengeId,
    webauthnResponse: body.webauthnResponse,
    backupCode: body.backupCode,
  });
  if (mfaError) return mfaError;

  const taken = await env.DB.prepare(
    "SELECT id FROM users WHERE email = ?",
  ).bind(email).first<{ id: string }>();
  if (taken) return errorResponse(Errors.CONFLICT);

  // Invalidate any earlier pending change so a stale confirm link can't apply
  // an old address later (matters especially across flag flips).
  await env.DB.prepare(
    "DELETE FROM email_verification_tokens WHERE user_id = ? AND email IS NOT NULL",
  ).bind(session.userId).run();

  const requireVerification = await isEmailVerificationEnabled(env, session.userId);

  if (!requireVerification) {
    try {
      await env.DB.prepare(
        "UPDATE users SET email = ?, email_verified = 0, email_verified_at = NULL WHERE id = ?",
      ).bind(email, session.userId).run();
    } catch (err) {
      // UNIQUE constraint race past the pre-check above; anything else is a
      // real failure and must not masquerade as "email taken."
      if (isUniqueConstraintError(err)) return errorResponse(Errors.CONFLICT);
      throw err;
    }
    await sendEmailChangedNotice(env, user.email, email);
    await syncStripeCustomerEmail(env, session.userId, email);
    return okResponse({ applied: true, email });
  }

  const token = await createVerificationToken(env, session.userId, email);
  const verifyUrl = `${env.APP_ORIGIN}/verify-email?token=${token}`;
  const sent = await sendEmailChangeConfirmEmail(env, email, verifyUrl);
  if (!sent) {
    // The confirm email IS the mechanism in this mode - a swallowed send
    // failure would leave a phantom pending change the user waits on forever.
    await env.DB.prepare("DELETE FROM email_verification_tokens WHERE id = ?").bind(token).run();
    return Response.json({ ok: false, error: "send_failed" }, { status: 500 });
  }
  return okResponse({ applied: false, pendingEmail: email });
}
