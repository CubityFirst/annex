import type { Env } from "./index";

const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// The `email-verification` Flagship flag, with a dev bypass. The dashboard
// flag state is shared with production and wrangler dev serves it verbatim,
// so flipping the flag on in prod must not start gating local login/register
// (it silently kills every login-dependent e2e/integration suite). Local
// deployments - detected by a localhost APP_ORIGIN, the same signal
// dev-quick-login trusts - therefore never enforce verification unless
// DEV_EMAIL_VERIFICATION=true is set in .dev.vars to opt back in for testing
// the verification flow itself.
export async function isEmailVerificationEnabled(env: Env, userId: string): Promise<boolean> {
  const isLocalDeploy = /\blocalhost\b|127\.0\.0\.1/.test(env.APP_ORIGIN ?? "");
  if (isLocalDeploy && env.DEV_EMAIL_VERIFICATION !== "true") return false;
  return env.FLAGS
    ? env.FLAGS.getBooleanValue("email-verification", false, { userId })
    : false;
}

// `email` is the pending NEW address for an email-change request; NULL means
// the token verifies the account's current email (signup flow).
export async function createVerificationToken(env: Env, userId: string, email?: string): Promise<string> {
  const now = Date.now();

  // Lazy GC: remove expired and already-consumed tokens for this user
  await env.DB.prepare(
    "DELETE FROM email_verification_tokens WHERE user_id = ? AND (expires_at <= ? OR consumed_at IS NOT NULL)",
  ).bind(userId, now).run();

  const token = crypto.randomUUID();
  const expiresAt = now + VERIFICATION_TTL_MS;

  await env.DB.prepare(
    "INSERT INTO email_verification_tokens (id, user_id, created_at, expires_at, consumed_at, email) VALUES (?, ?, ?, ?, NULL, ?)",
  ).bind(token, userId, now, expiresAt, email ?? null).run();

  return token;
}

// Returns { userId, email } on success (email = pending new address, or null
// for a plain signup-verification token), null if the token is
// invalid/expired/already-consumed.
export async function consumeVerificationToken(
  env: Env,
  token: string,
): Promise<{ userId: string; email: string | null } | null> {
  const now = Date.now();

  const result = await env.DB.prepare(
    "UPDATE email_verification_tokens SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL AND expires_at > ? RETURNING user_id, email",
  ).bind(now, token, now).first<{ user_id: string; email: string | null }>();

  return result ? { userId: result.user_id, email: result.email } : null;
}
