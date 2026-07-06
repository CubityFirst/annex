import { okResponse, errorResponse, Errors, normalizeEmail } from "../lib";
import { verifyPassword, hashPassword, needsRehash, DUMMY_PASSWORD_HASH } from "../password";
import { signJwt, verifyJwt } from "../jwt";
import { verifyTurnstile } from "../turnstile";
import { validateAndConsumeBackupCode, verifyAndConsumeTotp } from "../mfa";
import { createSession, SESSION_TTL_MS } from "../sessions";
import type { Session } from "../lib";
import type { Env } from "../index";

// Shared column list so the password path and the pre-auth continuation load
// the exact same user shape.
const USER_SELECT =
  "SELECT id, email, name, password_hash, created_at, moderation, totp_secret, force_password_change, is_admin, email_verified FROM users";

type LoginUserRow = {
  id: string; email: string; name: string; password_hash: string; created_at: string; moderation: number; totp_secret: string | null; force_password_change: number; is_admin: number; email_verified: number;
};

// Claims carried by the short-lived pre-auth token. Identity only, plus the
// `pre2fa` marker that gates redemption - a session token or change-token
// signed with the same secret lacks it and can't be redeemed for 2FA.
type PreAuthClaims = Session & { pre2fa?: boolean };

export async function handleLogin(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{
    email?: string;
    password?: string;
    turnstileToken?: string;
    totpCode?: string;
    backupCode?: string;
    preAuthToken?: string;
  }>();

  // Continuation path: a prior attempt already cleared password + Turnstile and
  // returned `totp_required` / `two_factor_required` with a short-lived pre-auth
  // token. The client now returns just that token plus a 2FA code, so skip
  // Turnstile and the email/password check entirely. Identity rides in the
  // token, but nothing beyond `userId` is trusted - the user row is reloaded and
  // every gate re-run on redemption.
  if (body.preAuthToken) return handlePreAuthContinuation(request, env, body);

  if (!body.email || !body.password) return errorResponse(Errors.BAD_REQUEST);

  const turnstileValid = await verifyTurnstile(body.turnstileToken ?? "", env.TURNSTILE_SECRET);
  if (!turnstileValid) return errorResponse(Errors.BAD_REQUEST);

  const row = await env.DB.prepare(USER_SELECT + " WHERE email = ?")
    .bind(normalizeEmail(body.email)).first<LoginUserRow>();

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

  // Existence check only - stop at the first row instead of counting every
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
        {
          ok: false,
          error: "two_factor_required",
          methods: ["totp", "webauthn"],
          userId: row.id,
          preAuthToken: await signPreAuthToken(env, row.id, row.email),
        },
        { status: 200 },
      );
    }
    const totpError = await verifyTotpOrBackup(env, row.id, row.totp_secret!, body.totpCode, body.backupCode);
    if (totpError) return totpError;
  } else if (hasWebauthn) {
    return Response.json({ ok: false, error: "webauthn_required", userId: row.id }, { status: 200 });
  } else if (hasTOTP) {
    if (!body.totpCode && !body.backupCode) {
      return Response.json(
        { ok: false, error: "totp_required", preAuthToken: await signPreAuthToken(env, row.id, row.email) },
        { status: 200 },
      );
    }
    const totpError = await verifyTotpOrBackup(env, row.id, row.totp_secret!, body.totpCode, body.backupCode);
    if (totpError) return totpError;
  }

  // Authentication succeeded - opportunistically migrate hashes that were
  // written with an older iteration count. (Continuation path has no password
  // in hand, so it skips this and relies on the original login having done it.)
  if (needsRehash(row.password_hash)) {
    const newHash = await hashPassword(body.password);
    await env.DB.prepare("UPDATE users SET password_hash = ? WHERE id = ?")
      .bind(newHash, row.id).run();
  }

  return issueSessionOrForceChange(request, env, row);
}

// Redeems a pre-auth token for the 2FA step of a login that already cleared
// password + Turnstile. Trusts nothing beyond identity: reloads the user row,
// re-runs moderation, and re-verifies the 2FA code under the same per-user
// `mfa:<userId>` throttle as the password path.
async function handlePreAuthContinuation(
  request: Request,
  env: Env,
  body: { preAuthToken?: string; totpCode?: string; backupCode?: string },
): Promise<Response> {
  // verifyJwt already checks the signature and generic expiry, but re-assert
  // the `pre2fa` claim and the expiry here explicitly so a session token or a
  // change-token signed with the same secret can never be redeemed for 2FA.
  const claims = (await verifyJwt(body.preAuthToken!, env.JWT_SECRET)) as PreAuthClaims | null;
  if (!claims || claims.pre2fa !== true || claims.expiresAt <= Date.now()) {
    return Response.json({ ok: false, error: "pre_auth_expired" }, { status: 401 });
  }

  const row = await env.DB.prepare(USER_SELECT + " WHERE id = ?")
    .bind(claims.userId).first<LoginUserRow>();
  if (!row) return Response.json({ ok: false, error: "pre_auth_expired" }, { status: 401 });

  const moderationResponse = checkModeration(row.moderation);
  if (moderationResponse) return moderationResponse;

  // TOTP was disabled between issuing the token and redeeming it - a weird
  // state; refuse rather than issue a session with the 2FA step skipped.
  if (!row.totp_secret) return errorResponse(Errors.UNAUTHORIZED);

  if (!body.totpCode && !body.backupCode) return errorResponse(Errors.BAD_REQUEST);

  const totpError = await verifyTotpOrBackup(env, row.id, row.totp_secret, body.totpCode, body.backupCode);
  if (totpError) return totpError;

  return issueSessionOrForceChange(request, env, row);
}

// Post-2FA tail shared by the password path and the pre-auth continuation:
// force-change branch, otherwise issue a session. Assumes the caller has
// already verified credentials (password or pre-auth token) and any 2FA.
async function issueSessionOrForceChange(
  request: Request,
  env: Env,
  row: LoginUserRow,
): Promise<Response> {
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

// Mints the short-lived pre-auth token handed back with the 2FA prompt so the
// client needn't re-send password + Turnstile on each 2FA attempt. Carries
// identity only; redemption reloads the user and re-checks everything.
async function signPreAuthToken(env: Env, userId: string, email: string): Promise<string> {
  const payload: PreAuthClaims = { userId, email, expiresAt: Date.now() + 5 * 60 * 1000, pre2fa: true };
  return signJwt(payload, env.JWT_SECRET);
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
  // already verified by this point, so key the throttle on the account - a
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
