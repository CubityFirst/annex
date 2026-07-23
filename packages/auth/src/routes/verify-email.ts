import { okResponse, errorResponse, Errors } from "../lib";
import { consumeVerificationToken } from "../verification";
import { signJwt } from "../jwt";
import { createSession, SESSION_TTL_MS } from "../sessions";
import { sendEmailChangedNotice } from "../email";
import { syncStripeCustomerEmail } from "../stripe-client";
import type { Env } from "../index";

export async function handleVerifyEmail(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{ token?: string }>();
  if (!body.token) return errorResponse(Errors.BAD_REQUEST);

  const consumed = await consumeVerificationToken(env, body.token);
  if (!consumed) {
    return Response.json({ ok: false, error: "invalid_or_expired_token" }, { status: 400 });
  }
  const { userId, email: pendingEmail } = consumed;

  // Change-confirm token: apply the pending new address. Deliberately does NOT
  // mint a session - the link lands in a mailbox never before tied to the
  // account, and a session here would let bare mailbox access bypass the
  // password+MFA gate that protected the change request.
  if (pendingEmail !== null) {
    const user = await env.DB.prepare(
      "SELECT email FROM users WHERE id = ?",
    ).bind(userId).first<{ email: string }>();
    if (!user) return errorResponse(Errors.NOT_FOUND);

    try {
      await env.DB.prepare(
        "UPDATE users SET email = ?, email_verified = 1, email_verified_at = ? WHERE id = ?",
      ).bind(pendingEmail, new Date().toISOString(), userId).run();
    } catch {
      // Another account claimed the address between request and confirm. The
      // token is already consumed - the user re-requests from settings.
      return Response.json({ ok: false, error: "email_taken" }, { status: 409 });
    }

    await sendEmailChangedNotice(env, user.email, pendingEmail);
    await syncStripeCustomerEmail(env, userId, pendingEmail);

    return okResponse({ verified: true, emailChanged: true, userId, email: pendingEmail });
  }

  await env.DB.prepare(
    "UPDATE users SET email_verified = 1, email_verified_at = ? WHERE id = ?",
  ).bind(new Date().toISOString(), userId).run();

  const row = await env.DB.prepare(
    "SELECT id, email, name, created_at FROM users WHERE id = ?",
  ).bind(userId).first<{ id: string; email: string; name: string; created_at: string }>();

  if (!row) return errorResponse(Errors.NOT_FOUND);

  const expiresAt = Date.now() + SESSION_TTL_MS;
  const sid = await createSession(env, row.id, request, expiresAt);
  const token = await signJwt(
    { userId: row.id, email: row.email, expiresAt, isAdmin: false, sid },
    env.JWT_SECRET,
  );

  return okResponse({
    verified: true,
    token,
    user: { id: row.id, email: row.email, name: row.name, createdAt: row.created_at },
  });
}
