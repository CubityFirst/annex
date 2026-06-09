import { clientIp } from "./lib";
import type { Env } from "./index";

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type DeviceKind = "phone" | "tablet" | "laptop" | "desktop";

export interface SessionRow {
  id: string;
  user_id: string;
  created_at: number;
  expires_at: number;
  last_used_at: number;
  device_kind: DeviceKind | null;
  client_label: string | null;
  ip: string | null;
  revoked_at: number | null;
}

// Derive a coarse device kind and friendly client label from the User-Agent
// at session-creation time. We store only these derived values so we don't
// retain the full UA fingerprint.
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

  const clientLabel = os ? `${browser} on ${os}` : browser;
  return { deviceKind, clientLabel };
}

// Creates a new session row and returns the id (used as the JWT's `sid` claim).
// Captures UA/IP at creation time only — there's no per-request write.
export async function createSession(
  env: Env,
  userId: string,
  request: Request,
  expiresAt: number,
): Promise<string> {
  const id = crypto.randomUUID();
  const now = Date.now();
  const { deviceKind, clientLabel } = parseUserAgent(request.headers.get("User-Agent"));
  const ip = clientIp(request);

  // Opportunistic GC: drop expired/revoked rows for this user so the table
  // doesn't grow unbounded for users who never log out properly.
  await env.DB.prepare(
    "DELETE FROM sessions WHERE user_id = ? AND (expires_at <= ? OR revoked_at IS NOT NULL)",
  ).bind(userId, now).run();

  await env.DB.prepare(
    `INSERT INTO sessions (id, user_id, created_at, expires_at, last_used_at, device_kind, client_label, ip)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, userId, now, expiresAt, now, deviceKind, clientLabel, ip).run();

  return id;
}

// Marks a single session as revoked. Returns true if a row was actually
// updated (i.e. the session existed and belonged to this user and wasn't
// already revoked).
export async function revokeSession(
  env: Env,
  sessionId: string,
  userId: string,
): Promise<boolean> {
  const result = await env.DB.prepare(
    "UPDATE sessions SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL",
  ).bind(Date.now(), sessionId, userId).run();
  return (result.meta.changes ?? 0) > 0;
}

// Revokes every active session for a user, optionally keeping one alive
// (the caller's current session). Used by change-password (keep current),
// force-change-password (keep none), and admin disable flows.
export async function revokeAllSessions(
  env: Env,
  userId: string,
  exceptSessionId?: string,
): Promise<void> {
  const now = Date.now();
  if (exceptSessionId) {
    await env.DB.prepare(
      "UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id != ? AND revoked_at IS NULL",
    ).bind(now, userId, exceptSessionId).run();
  } else {
    await env.DB.prepare(
      "UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL",
    ).bind(now, userId).run();
  }
}

export interface ActiveSessionView {
  id: string;
  createdAt: number;
  lastUsedAt: number;
  expiresAt: number;
  deviceKind: DeviceKind | null;
  clientLabel: string | null;
  ip: string | null;
  current: boolean;
}

export async function listActiveSessions(
  env: Env,
  userId: string,
  currentSessionId: string | undefined,
): Promise<ActiveSessionView[]> {
  const now = Date.now();
  const rows = await env.DB.prepare(
    `SELECT id, created_at, last_used_at, expires_at, device_kind, client_label, ip
     FROM sessions
     WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
     ORDER BY last_used_at DESC`,
  ).bind(userId, now).all<{
    id: string;
    created_at: number;
    last_used_at: number;
    expires_at: number;
    device_kind: DeviceKind | null;
    client_label: string | null;
    ip: string | null;
  }>();

  return rows.results.map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    expiresAt: r.expires_at,
    deviceKind: r.device_kind,
    clientLabel: r.client_label,
    ip: r.ip,
    current: r.id === currentSessionId,
  }));
}
