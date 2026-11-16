import { errorResponse, Errors } from "../lib";
import { verifyDiscoverableAssertion } from "../webauthn";
import { checkModeration, issueSessionOrForceChange } from "./login";
import { isEmailVerificationEnabled } from "../verification";
import type { Env } from "../index";

// Completes a usernameless passkey sign-in. A user-verifying passkey is a
// complete login on its own (possession + PIN/biometric), the same standing it
// already has as the second step of password login, so no TOTP is asked for.
//
// Unlike /webauthn/auth/finish, the account is only known once the assertion
// verifies, so the account gates run after the challenge is consumed. That's
// deliberate: checking them first would let anyone holding a credential id
// learn its account's moderation / verification state without the passkey.
// The user just retries the ceremony - there's nothing to retype.
export async function handlePasskeyAuthFinish(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{ challengeId?: string; response?: Record<string, unknown> }>();
  if (!body.challengeId || !body.response || typeof body.response !== "object") {
    return errorResponse(Errors.BAD_REQUEST);
  }

  const result = await verifyDiscoverableAssertion(env, body.challengeId, body.response);
  if (result instanceof Response) return result;

  const user = await env.DB.prepare(
    "SELECT id, email, name, created_at, moderation, force_password_change, is_admin, email_verified FROM users WHERE id = ?",
  )
    .bind(result.userId)
    .first<{ id: string; email: string; name: string; created_at: string; moderation: number; force_password_change: number; is_admin: number; email_verified: number }>();
  if (!user) return errorResponse(Errors.UNAUTHORIZED);

  const moderationResponse = checkModeration(user.moderation);
  if (moderationResponse) return moderationResponse;

  if (!user.email_verified && await isEmailVerificationEnabled(env, user.id)) {
    // The caller proved control of the account, and the client never typed an
    // email on this path, so hand it back for the "resend verification" button.
    return Response.json({ ok: false, error: "email_not_verified", email: user.email }, { status: 403 });
  }

  return issueSessionOrForceChange(request, env, user);
}
