import { verifyWebauthnAssertion } from "./webauthn";
import { matchTotpStep, verifyTOTP } from "./totp";
import { errorResponse, Errors } from "./lib";
import type { Env } from "./index";

export type MFAVerification = {
  totpCode?: string;
  challengeId?: string;
  webauthnResponse?: unknown;
  backupCode?: string;
};

/**
 * Enforces MFA for a given user.
 *
 * - If the user has no MFA configured, returns null (allow through).
 * - If the user has MFA and a valid verification is provided, returns null.
 * - Otherwise returns an error Response.
 *
 * Priority: WebAuthn assertion (if provided) is accepted regardless of
 * whether TOTP is also enabled. Falls back to TOTP if no assertion given.
 * Backup codes are accepted in place of a TOTP code.
 */
export async function requireMFA(
  env: Env,
  userId: string,
  verification: MFAVerification,
): Promise<Response | null> {
  const user = await env.DB.prepare(
    "SELECT totp_secret FROM users WHERE id = ?",
  ).bind(userId).first<{ totp_secret: string | null }>();
  if (!user) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const hasTOTP = !!user.totp_secret;
  const existingKey = await env.DB.prepare(
    "SELECT id FROM webauthn_credentials WHERE user_id = ? LIMIT 1",
  ).bind(userId).first<{ id: string }>();
  const hasWebauthn = !!existingKey;

  if (!hasTOTP && !hasWebauthn) return null;

  // Throttle real verification attempts per-user so a stolen/live session
  // can't brute-force the 6-digit TOTP or a backup code to strip MFA. Keyed
  // on userId rather than IP so the budget holds even against a distributed
  // attacker rotating source addresses. Only counted when a code/assertion is
  // actually supplied; the "mfa_required" prompt path below is a normal flow
  // and not throttled.
  const attempting = !!(
    verification.totpCode ||
    verification.backupCode ||
    (verification.challengeId && verification.webauthnResponse)
  );
  if (attempting) {
    const { success } = await env.RATE_LIMITER_AUTH.limit({ key: `mfa:${userId}` });
    if (!success) return errorResponse(Errors.RATE_LIMITED);
  }

  if (verification.challengeId && verification.webauthnResponse) {
    return verifyWebauthnAssertion(
      env,
      userId,
      verification.challengeId,
      verification.webauthnResponse as Record<string, unknown>,
      "mfa",
    );
  }

  if (hasTOTP) {
    if (verification.totpCode) {
      // Plain verify, no step consume: these are authenticated re-confirmations
      // (change password, disable TOTP, delete account), and a user legitimately
      // confirms several of them within one 30s code window. Replay protection
      // lives on the unauthenticated login path (verifyAndConsumeTotp), where a
      // captured code is actually dangerous. Brute force is covered by the
      // per-user throttle above.
      const valid = await verifyTOTP(user.totp_secret!, verification.totpCode);
      if (!valid) {
        return Response.json({ ok: false, error: "invalid_totp" }, { status: 401 });
      }
      return null;
    }
    if (verification.backupCode) {
      const backupResult = await validateAndConsumeBackupCode(env, userId, verification.backupCode);
      if (!backupResult) {
        return Response.json({ ok: false, error: "invalid_backup_code" }, { status: 401 });
      }
      return null;
    }
    return Response.json({ ok: false, error: "mfa_required" }, { status: 200 });
  }

  // Has WebAuthn only, no assertion provided
  return Response.json({ ok: false, error: "mfa_required" }, { status: 200 });
}

// Verifies a TOTP code AND consumes its time step, so a captured code can't be
// replayed to LOG IN within its ±1-step validity window. The conditional
// UPDATE is the consume: it only succeeds for a step strictly later than the
// last accepted one, and concurrent requests race on the row so exactly one
// wins. Only the unauthenticated login path consumes - enroll and the
// authenticated requireMFA confirmations deliberately don't, so enabling TOTP
// and signing in (or confirming several settings actions) within one code
// window keeps working.
export async function verifyAndConsumeTotp(
  env: Env,
  userId: string,
  secret: string,
  code: string,
): Promise<boolean> {
  const step = await matchTotpStep(secret, code);
  if (step === null) return false;
  const result = await env.DB.prepare(
    "UPDATE users SET totp_last_used_step = ? WHERE id = ? AND (totp_last_used_step IS NULL OR totp_last_used_step < ?)",
  ).bind(step, userId, step).run();
  return (result.meta.changes ?? 0) === 1;
}

export async function validateAndConsumeBackupCode(env: Env, userId: string, code: string): Promise<boolean> {
  const hash = await hashCode(code.toUpperCase());
  const rows = await env.DB.prepare(
    "SELECT id, code_hash FROM backup_codes WHERE user_id = ? AND used_at IS NULL",
  ).bind(userId).all<{ id: string; code_hash: string }>();

  for (const row of rows.results) {
    if (row.code_hash === hash) {
      await env.DB.prepare(
        "UPDATE backup_codes SET used_at = datetime('now') WHERE id = ?",
      ).bind(row.id).run();
      return true;
    }
  }
  return false;
}

export async function hashCode(code: string): Promise<string> {
  const buf = new TextEncoder().encode(code);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
}
