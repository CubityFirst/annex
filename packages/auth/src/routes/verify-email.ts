import { okResponse, errorResponse, Errors, isUniqueConstraintError } from "../lib";
import { consumeVerificationToken } from "../verification";
import { sendEmailChangedNotice } from "../email";
import { syncStripeCustomerEmail } from "../stripe-client";
import type { Env } from "../index";

export async function handleVerifyEmail(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{ token?: string }>();
  if (!body.token) return errorResponse(Errors.BAD_REQUEST);

  const consumed = await consumeVerificationToken(env, body.token);
  if (!consumed) {
    // Dead change links (expired or already consumed - rows persist until the
    // lazy GC) get a distinct error so the frontend can point the user back to
    // Settings instead of offering the signup resend form, which can't help.
    const dead = await env.DB.prepare(
      "SELECT email FROM email_verification_tokens WHERE id = ?",
    ).bind(body.token).first<{ email: string | null }>();
    if (dead && dead.email !== null) {
      return Response.json({ ok: false, error: "change_link_expired" }, { status: 400 });
    }
    return Response.json({ ok: false, error: "invalid_or_expired_token" }, { status: 400 });
  }
  const { userId, email: pendingEmail } = consumed;

  // Change-confirm token: apply the pending new address. Deliberately does NOT
  // mint a session - the link lands in a mailbox never before tied to the
  // account, and a session here would let bare mailbox access bypass the
  // password+MFA gate that protected the change request.
  if (pendingEmail !== null) {
    const user = await env.DB.prepare(
      "SELECT email, moderation FROM users WHERE id = ?",
    ).bind(userId).first<{ email: string; moderation: number }>();
    if (!user) return errorResponse(Errors.NOT_FOUND);

    // The request path was session-gated, but the account can have been
    // moderated between request and confirm - don't let a disabled/suspended
    // account keep mutating its identity via a pre-issued link.
    if (user.moderation === -1) {
      return Response.json({ ok: false, error: "account_disabled" }, { status: 403 });
    }
    if (user.moderation > 0 && Math.floor(Date.now() / 1000) < user.moderation) {
      return Response.json({ ok: false, error: "account_suspended" }, { status: 403 });
    }

    try {
      await env.DB.prepare(
        "UPDATE users SET email = ?, email_verified = 1, email_verified_at = ? WHERE id = ?",
      ).bind(pendingEmail, new Date().toISOString(), userId).run();
    } catch (err) {
      // Another account claimed the address between request and confirm. The
      // token is already consumed - the user re-requests from settings. Any
      // other error is a real failure, not "email taken."
      if (!isUniqueConstraintError(err)) throw err;
      return Response.json({ ok: false, error: "email_taken" }, { status: 409 });
    }

    await sendEmailChangedNotice(env, user.email, pendingEmail);
    await syncStripeCustomerEmail(env, userId, pendingEmail);

    return okResponse({ verified: true, emailChanged: true, userId, email: pendingEmail });
  }

  // Signup-verify token. Like the change-confirm branch this deliberately does
  // NOT mint a session: /verify-email/resend hands a fresh link to anyone who
  // asks for an unverified address, so a session here would turn bare mailbox
  // access into a login that skips the password and any TOTP/WebAuthn factor.
  // The user signs in normally afterwards (the frontend shows "Go to sign in").
  const verified = await env.DB.prepare(
    "UPDATE users SET email_verified = 1, email_verified_at = ? WHERE id = ? RETURNING id",
  ).bind(new Date().toISOString(), userId).first<{ id: string }>();
  if (!verified) return errorResponse(Errors.NOT_FOUND);

  // Retire any other outstanding signup links for this account.
  await env.DB.prepare(
    "DELETE FROM email_verification_tokens WHERE user_id = ? AND email IS NULL",
  ).bind(userId).run();

  return okResponse({ verified: true });
}
