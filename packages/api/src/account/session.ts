// Annex's own sessions, stored in cubedocs-main `sessions` and created from a
// verified OIDC id_token (routes/auth.ts). The JWT in the Authorization
// header is only proof that Annex minted the session; everything that can
// change (revocation, expiry, account standing, admin flag, plan, prefs) is
// re-read here on every request.
//
// Shared with the admin worker, which imports this file cross-package for its
// own 'admin' sessions.

import { verifyJwt, signJwt, sha256b64url, randomToken } from "./jwt";
import { resolvePersonalPlan } from "./plan";
import { accountStanding, type IdentityEnv, type MirrorUser } from "./identity";

export type SessionKind = "app" | "admin";

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// Admin-panel sessions are the highest-privilege token in the product - keep
// them to a working day.
export const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
// How long the SPA has to redeem the single-use code from /auth/callback.
export const HANDOFF_TTL_MS = 60 * 1000;
// How stale last_used_at may get before a refresh write.
const LAST_USED_REFRESH_MS = 10 * 60 * 1000;

export interface SessionEnv extends IdentityEnv {
  JWT_SECRET: string;
}

export interface LoadedSession {
  userId: string;
  email: string;
  name: string;
  expiresAt: number;
  isAdmin: boolean;
  sid: string;
  personalPlan: "free" | "ink";
  personalPlanSince: number | null;
  personalPlanStatus: string | null;
  personalPlanCancelAt: number | null;
  personalPlanStyle: string | null;
  personalPresenceColor: string | null;
  personalCritSparkles: boolean;
  readingFont: string | null;
  editingFont: string | null;
  uiFont: string | null;
  themeMode: string | null;
  themeCustomColor: string | null;
}

export type SessionLoadResult =
  | { kind: "ok"; session: LoadedSession }
  | { kind: "disabled" }
  | { kind: "suspended"; until: number }
  | { kind: "invalid" };

interface SessionUserRow extends MirrorUser {
  pending_deletion: string | null;
  personal_plan: string | null;
  personal_plan_status: string | null;
  personal_plan_started_at: number | null;
  personal_plan_cancel_at: number | null;
  personal_plan_style: string | null;
  personal_presence_color: string | null;
  personal_crit_sparkles: number | null;
  granted_plan: string | null;
  granted_plan_expires_at: number | null;
  granted_plan_started_at: number | null;
  reading_font: string | null;
  editing_font: string | null;
  ui_font: string | null;
  theme_mode: string | null;
  theme_custom_color: string | null;
}

interface SessionStateRow {
  id: string;
  kind: string;
  expires_at: number;
  revoked_at: number | null;
  last_used_at: number;
  handoff_hash: string | null;
}

// Loads, validates and re-derives a session: one D1 batch for the mirror row
// (+ billing, prefs, pending admin deletion) and the session row, then the
// identity service for live standing (cached, see account/identity.ts).
export async function loadCurrentSession(
  token: string,
  env: SessionEnv,
  kind: SessionKind,
  ctx?: { waitUntil(p: Promise<unknown>): void },
): Promise<SessionLoadResult> {
  const claims = await verifyJwt(token, env.JWT_SECRET);
  if (!claims?.sid) return { kind: "invalid" };

  const db = env.DB;
  const [userResult, sessionResult] = await db.batch([
    db.prepare(
      `SELECT u.id, u.email, u.name, u.email_verified, u.is_admin, u.status, u.suspended_until, u.created_at,
              d.id AS pending_deletion,
              p.personal_plan_style, p.personal_presence_color, p.personal_crit_sparkles,
              p.reading_font, p.editing_font, p.ui_font,
              p.theme_mode, p.theme_custom_color,
              b.personal_plan, b.personal_plan_status, b.personal_plan_started_at,
              b.personal_plan_cancel_at,
              b.granted_plan, b.granted_plan_expires_at, b.granted_plan_started_at
       FROM users u
       LEFT JOIN user_billing b ON b.user_id = u.id
       LEFT JOIN user_preferences p ON p.user_id = u.id
       LEFT JOIN user_deletions d ON d.user_id = u.id
       WHERE u.id = ?`,
    ).bind(claims.userId),
    db.prepare(
      "SELECT id, kind, expires_at, revoked_at, last_used_at, handoff_hash FROM sessions WHERE id = ? AND user_id = ?",
    ).bind(claims.sid, claims.userId),
  ]);

  const user = (userResult.results as SessionUserRow[])[0];
  const row = (sessionResult.results as SessionStateRow[])[0];
  const now = Date.now();

  if (!user || !row) return { kind: "invalid" };
  if (row.kind !== kind) return { kind: "invalid" };
  if (row.revoked_at !== null || row.expires_at <= now) return { kind: "invalid" };
  // A session whose handoff code was never redeemed has no legitimate token.
  if (row.handoff_hash !== null) return { kind: "invalid" };

  // An admin-scheduled deletion of the user's Annex data blocks Annex at once
  // and for as long as the schedule exists (pending or completed).
  if (user.pending_deletion) return { kind: "disabled" };

  const standing = await accountStanding(env, user, now, ctx);
  if (!standing.ok) {
    if (standing.reason === "disabled") return { kind: "disabled" };
    if (standing.reason === "suspended") return { kind: "suspended", until: standing.until };
    return { kind: "invalid" };
  }

  if (now - row.last_used_at > LAST_USED_REFRESH_MS) {
    const touch = db.prepare("UPDATE sessions SET last_used_at = ? WHERE id = ?").bind(now, row.id).run()
      .catch(err => console.error("[session] last_used_at refresh failed", String(err)));
    // Bounded to one write per session per ~10 min, so awaiting it when
    // there's no ExecutionContext costs little.
    if (ctx) ctx.waitUntil(touch);
    else await touch;
  }

  const resolved = resolvePersonalPlan({
    granted_plan: user.granted_plan,
    granted_plan_expires_at: user.granted_plan_expires_at,
    granted_plan_started_at: user.granted_plan_started_at,
    personal_plan: user.personal_plan,
    personal_plan_status: user.personal_plan_status,
    personal_plan_started_at: user.personal_plan_started_at,
    personal_plan_cancel_at: user.personal_plan_cancel_at,
    personal_plan_style: user.personal_plan_style,
    personal_presence_color: user.personal_presence_color,
    personal_crit_sparkles: user.personal_crit_sparkles,
  }, now);

  return {
    kind: "ok",
    session: {
      userId: user.id,
      email: user.email,
      name: user.name,
      expiresAt: row.expires_at,
      isAdmin: standing.isAdmin,
      sid: row.id,
      personalPlan: resolved.plan,
      personalPlanSince: resolved.since,
      personalPlanStatus: resolved.status,
      personalPlanCancelAt: resolved.cancelAt,
      personalPlanStyle: resolved.style,
      personalPresenceColor: resolved.presenceColor,
      personalCritSparkles: resolved.critSparkles,
      readingFont: user.reading_font,
      editingFont: user.editing_font,
      uiFont: user.ui_font,
      themeMode: user.theme_mode,
      themeCustomColor: user.theme_custom_color,
    },
  };
}

export function sessionResultToResponse(result: Exclude<SessionLoadResult, { kind: "ok" }>): Response {
  if (result.kind === "disabled") {
    return Response.json({ ok: false, error: "account_disabled" }, { status: 403 });
  }
  if (result.kind === "suspended") {
    return Response.json({ ok: false, error: "account_suspended", until: result.until }, { status: 403 });
  }
  return Response.json({ ok: false, error: "Unauthorized", status: 401 }, { status: 401 });
}

export type DeviceKind = "phone" | "tablet" | "laptop" | "desktop";

// Coarse device kind + friendly client label from the User-Agent at session
// creation. Only the derived values are stored, never the raw UA.
export function parseUserAgent(ua: string | null): { deviceKind: DeviceKind | null; clientLabel: string | null } {
  if (!ua) return { deviceKind: null, clientLabel: null };
  const deviceKind: DeviceKind =
    /iPad/.test(ua) || (/Android/.test(ua) && !/Mobile/.test(ua)) ? "tablet" :
    /iPhone|Android.*Mobile|Mobile.*Firefox|Windows Phone/.test(ua) ? "phone" :
    /Macintosh|Mac OS X/.test(ua) ? "laptop" :
    "desktop";
  const browser =
    /Edg\//.test(ua) ? "Edge" :
    /Firefox\//.test(ua) ? "Firefox" :
    /Chrome\//.test(ua) ? "Chrome" :
    /Safari\//.test(ua) ? "Safari" :
    "Browser";
  const os =
    /Windows/.test(ua) ? "Windows" :
    /Mac OS X/.test(ua) ? "macOS" :
    /Android/.test(ua) ? "Android" :
    /iPhone|iPad|iOS/.test(ua) ? "iOS" :
    /Linux/.test(ua) ? "Linux" :
    "";
  return { deviceKind, clientLabel: os ? `${browser} on ${os}` : browser };
}

export function clientIp(request: Request): string | null {
  return request.headers.get("CF-Connecting-IP") ?? request.headers.get("X-Client-IP");
}

// Creates a session that can't be used until its handoff code is redeemed
// (redeemHandoff). Returns the code to hand the browser.
export async function createPendingSession(
  db: D1Database,
  opts: { userId: string; kind: SessionKind; request: Request; idToken: string | null; nowMs?: number },
): Promise<{ sessionId: string; handoffCode: string }> {
  const now = opts.nowMs ?? Date.now();
  const id = crypto.randomUUID();
  const code = randomToken(32);
  const ttl = opts.kind === "admin" ? ADMIN_SESSION_TTL_MS : SESSION_TTL_MS;
  const { deviceKind, clientLabel } = parseUserAgent(opts.request.headers.get("User-Agent"));
  await db.batch([
    // Opportunistic GC of this user's dead rows (expired, revoked, or
    // abandoned before their handoff was redeemed).
    db.prepare(
      `DELETE FROM sessions WHERE user_id = ? AND (expires_at <= ? OR revoked_at IS NOT NULL
         OR (handoff_hash IS NOT NULL AND handoff_expires_at <= ?))`,
    ).bind(opts.userId, now, now),
    db.prepare(
      `INSERT INTO sessions (id, user_id, kind, created_at, expires_at, last_used_at, device_kind, client_label, ip, id_token, handoff_hash, handoff_expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, opts.userId, opts.kind, now, now + ttl, now, deviceKind, clientLabel, clientIp(opts.request), opts.idToken,
      await sha256b64url(code), now + HANDOFF_TTL_MS),
  ]);
  return { sessionId: id, handoffCode: code };
}

// Redeems a single-use handoff code for the session JWT. Exactly one caller
// can win the UPDATE; a replay, an expired code or a code for the other kind
// of session gets null.
export async function redeemHandoff(env: SessionEnv, code: string, kind: SessionKind, nowMs: number = Date.now()): Promise<string | null> {
  if (typeof code !== "string" || code.length < 16 || code.length > 128) return null;
  const hash = await sha256b64url(code);
  const row = await env.DB.prepare(
    `UPDATE sessions SET handoff_hash = NULL, handoff_expires_at = NULL
     WHERE handoff_hash = ? AND kind = ? AND handoff_expires_at > ? AND revoked_at IS NULL
     RETURNING id, user_id, expires_at`,
  ).bind(hash, kind, nowMs).first<{ id: string; user_id: string; expires_at: number }>();
  if (!row) return null;
  const user = await env.DB.prepare("SELECT email, is_admin FROM users WHERE id = ?")
    .bind(row.user_id).first<{ email: string; is_admin: number }>();
  if (!user) return null;
  return signJwt({ userId: row.user_id, email: user.email, expiresAt: row.expires_at, isAdmin: Boolean(user.is_admin), sid: row.id }, env.JWT_SECRET);
}

// Mints a ready-to-use session directly (local-dev quick login only).
export async function createSessionToken(
  env: SessionEnv,
  opts: { userId: string; email: string; isAdmin: boolean; kind: SessionKind; request: Request },
): Promise<string> {
  const { sessionId, handoffCode } = await createPendingSession(env.DB, { ...opts, idToken: null });
  void sessionId;
  const token = await redeemHandoff(env, handoffCode, opts.kind);
  if (!token) throw new Error("session handoff failed");
  return token;
}

// Revokes the session a token points at and returns the id_token kept for
// RP-initiated logout. Only the signature/expiry of the token is checked, not
// account standing: a disabled user must still be able to sign out.
export async function revokeSessionByToken(
  env: SessionEnv,
  token: string,
  kind: SessionKind,
): Promise<{ revoked: boolean; idToken: string | null }> {
  const claims = await verifyJwt(token, env.JWT_SECRET);
  if (!claims?.sid) return { revoked: false, idToken: null };
  const row = await env.DB.prepare(
    "UPDATE sessions SET revoked_at = ? WHERE id = ? AND user_id = ? AND kind = ? AND revoked_at IS NULL RETURNING id_token",
  ).bind(Date.now(), claims.sid, claims.userId, kind).first<{ id_token: string | null }>();
  return { revoked: !!row, idToken: row?.id_token ?? null };
}

// Weekly-style sweep of dead session rows, run from the daily cron.
export const SESSION_SWEEP_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export async function sweepSessions(db: D1Database, nowMs: number = Date.now()): Promise<void> {
  const cutoff = nowMs - SESSION_SWEEP_RETENTION_MS;
  await db.prepare(
    `DELETE FROM sessions WHERE expires_at <= ? AND (expires_at <= ? OR (revoked_at IS NOT NULL AND revoked_at < ?))`,
  ).bind(cutoff + SESSION_TTL_MS, cutoff, cutoff).run();
  await db.prepare("DELETE FROM sessions WHERE handoff_hash IS NOT NULL AND handoff_expires_at <= ?").bind(nowMs).run();
  await db.prepare("DELETE FROM webhook_events WHERE processed_at < ?").bind(cutoff).run();
}
