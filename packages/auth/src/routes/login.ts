import { okResponse, errorResponse, Errors, normalizeEmail } from "../lib";
import { verifyPassword, hashPassword, needsRehash, DUMMY_PASSWORD_HASH } from "../password";
import { signJwt } from "../jwt";
import { verifyTurnstile } from "../turnstile";
import { validateAndConsumeBackupCode, verifyAndConsumeTotp } from "../mfa";
import { createSession, SESSION_TTL_MS } from "../sessions";
import type { Env } from "../index";

export async function handleLogin(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{
    email: string;
    password: string;
    turnstileToken: string;
    totpCode?: string;
    backupCode?: string;
  }>();

  if (!body.email || !body.password) return errorResponse(Errors.BAD_REQUEST);

  const turnstileValid = await verifyTurnstile(body.turnstileToken, env.TURNSTILE_SECRET);
  if (!turnstileValid) return errorResponse(Errors.BAD_REQUEST);

  const row = await env.DB.prepare(
    "SELECT id, email, name, password_hash, created_at, moderation, totp_secret, force_password_change, is_admin, email_verified FROM users WHERE email = ?",
  ).bind(normalizeEmail(body.email)).first<{
    id: string; email: string; name: string; password_hash: string; created_at: string; moderation: number; totp_secret: string | null; force_password_change: number; is_admin: number; email_verified: number;
  }>();

  // Always run a PBKDF2 derivation, even when the account doesn't exist, so the
  // response time can't be used to enumerate registered emails. The dummy hash
  // never matches, so the missing-user branch still returns UNAUTHORIZED.
  const valid = await verifyPassword(body.password, row?.password_hash ?? DUMMY_PASSWORD_HASH);
  if (!row || !valid) return errorResponse(Errors.UNAUTHORIZED);

  const moderationResponse = checkModeration(row.moderation);
  if (moderationResponse) return moderationResponse;

  // Only an unverified account can be gated, so skip the flag lookup entirely
  // for verified users. Default off: when the flag (or its binding) is absent,
  // verification isn't enforced and login proceeds.
  if (!row.email_verified) {
    const requireVerification = env.FLAGS
      ? await env.FLAGS.getBooleanValue("email-verification", false, { userId: row.id })
      : false;
    if (requireVerification) {
      return Response.json({ ok: false, error: "email_not_verified" }, { status: 403 });
    }
  }

  // Existence check only — stop at the first row instead of counting every
  // credential. Backed by idx_webauthn_credentials_user (migration 0027).
  const webauthnResult = await env.DB.prepare(
    "SELECT 1 FROM webauthn_credentials WHERE user_id = ? LIMIT 1",
  ).bind(row.id).first<{ 1: number }>();
  const hasWebauthn = webauthnResult !== null;
  const hasTOTP = !!row.totp_secret;

  if (hasWebauthn && hasTOTP) {
    // Both methods available: if totpCode or backupCode supplied the user chose TOTP, otherwise prompt for choice
    if (!body.totpCode && !body.backupCode) {
      return Response.json(
        { ok: false, error: "two_factor_required", methods: ["totp", "webauthn"], userId: row.id },
        { status: 200 },
      );
    }
    const totpError = await verifyTotpOrBackup(env, row.id, row.totp_secret!, body.totpCode, body.backupCode);
    if (totpError) return totpError;
  } else if (hasWebauthn) {
    return Response.json({ ok: false, error: "webauthn_required", userId: row.id }, { status: 200 });
  } else if (hasTOTP) {
    if (!body.totpCode && !body.backupCode) {
      return Response.json({ ok: false, error: "totp_required" }, { status: 200 });
    }
    const totpError = await verifyTotpOrBackup(env, row.id, row.totp_secret!, body.totpCode, body.backupCode);
    if (totpError) return totpError;
  }

  // Authentication succeeded — opportunistically migrate hashes that were
  // written with an older iteration count.
  if (needsRehash(row.password_hash)) {
    const newHash = await hashPassword(body.password);
    await env.DB.prepare("UPDATE users SET password_hash = ? WHERE id = ?")
      .bind(newHash, row.id).run();
  }

  if (row.force_password_change) {
    // Pre-session token: short-lived, no `sid`. Only valid against
    // /force-change-password, which checks `forcePasswordChange` explicitly.
    // The `cti` nonce is mirrored on the user row; re-issuing it here
    // overwrites any prior unused token, killing it before its 15-min
    // expiry kicks in.
    const cti = crypto.randomUUID();
    await env.DB.prepare("UPDATE users SET change_token_id = ? WHERE id = ?")
      .bind(cti, row.id).run();
    const changeToken = await signJwt(
      { userId: row.id, email: row.email, expiresAt: Date.now() + 15 * 60 * 1000, isAdmin: Boolean(row.is_admin), forcePasswordChange: true, cti },
      env.JWT_SECRET,
    );
    return Response.json({ ok: false, error: "password_change_required", changeToken }, { status: 200 });
  }

  const expiresAt = Date.now() + SESSION_TTL_MS;
  const sid = await createSession(env, row.id, request, expiresAt);
  const token = await signJwt(
    { userId: row.id, email: row.email, expiresAt, isAdmin: Boolean(row.is_admin), sid },
    env.JWT_SECRET,
  );

  return okResponse({ token, user: { id: row.id, email: row.email, name: row.name, createdAt: row.created_at } });
}

async function verifyTotpOrBackup(
  env: Env,
  userId: string,
  totpSecret: string,
  totpCode?: string,
  backupCode?: string,
): Promise<Response | null> {
  if (!totpCode && !backupCode) return null;

  // Same per-user budget as requireMFA (`mfa:<userId>`): the password is
  // already verified by this point, so key the throttle on the account — a
  // distributed attacker can rotate source IPs, but not this key.
  const { success } = await env.RATE_LIMITER_AUTH.limit({ key: `mfa:${userId}` });
  if (!success) return errorResponse(Errors.RATE_LIMITED);

  if (totpCode) {
    const valid = await verifyAndConsumeTotp(env, userId, totpSecret, totpCode);
    if (!valid) return Response.json({ ok: false, error: "invalid_totp" }, { status: 401 });
    return null;
  }
  const valid = await validateAndConsumeBackupCode(env, userId, backupCode!);
  if (!valid) return Response.json({ ok: false, error: "invalid_backup_code" }, { status: 401 });
  return null;
}

// Returns a 403 response if the account is restricted, or null if active.
// moderation: 0 = active, -1 = disabled, >0 = suspended until unix timestamp (seconds)
export function checkModeration(moderation: number): Response | null {
  if (moderation === 0) return null;
  if (moderation === -1) return Response.json({ ok: false, error: "account_disabled" }, { status: 403 });
  if (moderation > 0) {
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (nowSeconds < moderation) {
      return Response.json({ ok: false, error: "account_suspended", until: moderation }, { status: 403 });
    }
  }
  return null; // suspension has expired
}
