// The identity service (auth.cubityfir.st, worker `cubityfirst-auth`) as seen
// from Annex: the IdentityService RPC binding, the local `users` mirror, and
// account standing.
//
// Bound as { binding: IDENTITY, service: cubityfirst-auth, entrypoint:
// IdentityService } (see cloudflare.config.ts). RPC entrypoints aren't
// reachable over HTTP, so the binding is the access control.

export interface IdentityUser {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  isAdmin: boolean;
  status: "active" | "disabled" | "suspended";
  // Unix seconds, set when status is "suspended".
  suspendedUntil: number | null;
  createdAt: string;
}

export interface IdentityService {
  getUser(id: string): Promise<IdentityUser | null>;
  getUsers(ids: string[]): Promise<IdentityUser[]>;
  findUserByEmail(email: string): Promise<IdentityUser | null>;
  listDeletedUsers(sinceMs: number, limit?: number): Promise<Array<{ userId: string; deletedAt: number; deletedBy: string }>>;
}

import { syncStripeCustomerEmail, type StripeEnv } from "./stripe-client";

// What every consumer of this module needs from its worker's Env.
export interface IdentityEnv {
  DB: D1Database;
  IDENTITY?: IdentityService;
  // Keeps a linked Stripe customer's receipt address in step when the
  // identity email changes (see refreshMirror).
  STRIPE_SECRET_KEY?: string;
  // Local-dev quick login: dev-* users exist only in the mirror (see
  // routes/auth.ts handleDevQuickLogin), so standing checks skip the RPC.
  DEV_QUICK_LOGIN?: string;
  APP_ORIGIN?: string;
}

export interface MirrorUser {
  id: string;
  email: string;
  name: string;
  email_verified: number;
  is_admin: number;
  status: string;
  suspended_until: number | null;
  created_at: string;
  // Set by callers that join identity_deletions: the identity service has
  // reported this account deleted (cleanup may still be pending).
  identity_deleted?: number | null;
}

// SQL fragment for readers of the users mirror (alias `u`): whether the
// deletion sync has recorded the account as deleted.
export const IDENTITY_DELETED_SQL = "EXISTS (SELECT 1 FROM identity_deletions x WHERE x.user_id = u.id) AS identity_deleted";

export type Standing =
  | { ok: true; isAdmin: boolean }
  | { ok: false; reason: "disabled" }
  | { ok: false; reason: "suspended"; until: number }
  | { ok: false; reason: "deleted" };

export const DEV_USER_PREFIX = "dev-";

export function isLocalDeploy(env: { APP_ORIGIN?: string }): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(env.APP_ORIGIN ?? "");
}

export function isLocalDevUser(env: IdentityEnv, userId: string): boolean {
  return env.DEV_QUICK_LOGIN === "true" && isLocalDeploy(env) && userId.startsWith(DEV_USER_PREFIX);
}

// ---------------------------------------------------------------------------
// Standing cache
// ---------------------------------------------------------------------------
//
// Account standing is owned by the identity service. Asking it on every
// request would add an RPC per API call, so each isolate remembers the answer
// for STANDING_TTL_MS. A user disabled on auth.cubityfir.st is therefore
// locked out of Annex within about a minute, not when their Annex session
// expires.

export const STANDING_TTL_MS = 60_000;
const CACHE_MAX = 5_000;

interface CacheEntry { user: IdentityUser | null; at: number }
const cache = new Map<string, CacheEntry>();

export function clearIdentityCache(): void {
  cache.clear();
}

function remember(id: string, user: IdentityUser | null, now: number): void {
  if (cache.size >= CACHE_MAX) {
    // Map iterates in insertion order: drop the oldest tenth.
    let n = Math.ceil(CACHE_MAX / 10);
    for (const k of cache.keys()) {
      cache.delete(k);
      if (--n <= 0) break;
    }
  }
  cache.delete(id);
  cache.set(id, { user, at: now });
}

export function standingFromIdentity(user: IdentityUser | null, nowMs: number): Standing {
  if (!user) return { ok: false, reason: "deleted" };
  if (user.status === "disabled") return { ok: false, reason: "disabled" };
  if (user.status === "suspended" && user.suspendedUntil && Math.floor(nowMs / 1000) < user.suspendedUntil) {
    return { ok: false, reason: "suspended", until: user.suspendedUntil };
  }
  return { ok: true, isAdmin: user.isAdmin };
}

export function standingFromMirror(row: Pick<MirrorUser, "status" | "suspended_until" | "is_admin">, nowMs: number): Standing {
  if (row.status === "deleted") return { ok: false, reason: "deleted" };
  if (row.status === "disabled") return { ok: false, reason: "disabled" };
  if (row.status === "suspended" && row.suspended_until && Math.floor(nowMs / 1000) < row.suspended_until) {
    return { ok: false, reason: "suspended", until: row.suspended_until };
  }
  return { ok: true, isAdmin: Boolean(row.is_admin) };
}

// Live standing for a user Annex already has a mirror row for. Uses the
// isolate cache, then the IDENTITY RPC; when the identity service can't be
// reached it falls back to the mirror's last known standing rather than
// locking everyone out of Annex. A changed answer is written back to the
// mirror (and to the member-row name/email snapshots).
export async function accountStanding(
  env: IdentityEnv,
  mirror: MirrorUser,
  nowMs: number = Date.now(),
  ctx?: { waitUntil(p: Promise<unknown>): void },
): Promise<Standing> {
  // A deletion Annex already knows about wins over any cached or fallback
  // answer (cleanup by the deletion sync may not have run yet).
  if (mirror.identity_deleted || mirror.status === "deleted") return { ok: false, reason: "deleted" };
  if (isLocalDevUser(env, mirror.id)) return standingFromMirror(mirror, nowMs);

  const hit = cache.get(mirror.id);
  if (hit && nowMs - hit.at < STANDING_TTL_MS) return standingFromIdentity(hit.user, nowMs);

  if (!env.IDENTITY) return standingFromMirror(mirror, nowMs);

  let user: IdentityUser | null;
  try {
    user = await env.IDENTITY.getUser(mirror.id);
  } catch (err) {
    console.error("[identity] getUser failed; using mirror standing", { userId: mirror.id, err: String(err) });
    return standingFromMirror(mirror, nowMs);
  }
  remember(mirror.id, user, nowMs);
  if (!user) {
    // Authoritative "no such account": persist it, so an identity outage
    // later can't fall back to a mirror row that still says active.
    const write = env.DB.prepare("UPDATE users SET status = 'deleted', synced_at = ? WHERE id = ?").bind(nowMs, mirror.id).run()
      .catch(err => console.error("[identity] marking deleted user failed", { userId: mirror.id, err: String(err) }));
    if (ctx) ctx.waitUntil(write);
    else await write;
  } else if (mirrorDiffers(mirror, user)) {
    const write = refreshMirror(env, user, nowMs)
      .catch(err => console.error("[identity] mirror refresh failed", { userId: user.id, err: String(err) }));
    if (ctx) ctx.waitUntil(write);
    else await write;
  }
  return standingFromIdentity(user, nowMs);
}

function mirrorDiffers(m: MirrorUser, u: IdentityUser): boolean {
  return (
    m.email !== u.email ||
    m.name !== u.name ||
    Boolean(m.email_verified) !== u.emailVerified ||
    Boolean(m.is_admin) !== u.isAdmin ||
    m.status !== u.status ||
    (m.suspended_until ?? null) !== (u.suspendedUntil ?? null)
  );
}

// Writes the identity service's view of a user into the mirror. Name and
// email are also denormalized onto site/org member rows; keep those in step
// (the <> guards make the statements no-ops when nothing changed).
export function mirrorUpsertStatements(db: D1Database, user: IdentityUser, nowMs: number, opts: { login?: boolean } = {}): D1PreparedStatement[] {
  return [
    db.prepare(
      `INSERT INTO users (id, email, name, email_verified, is_admin, status, suspended_until, created_at, first_seen_at, last_login_at, synced_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11
       WHERE NOT EXISTS (SELECT 1 FROM identity_deletions x WHERE x.user_id = ?1)
       ON CONFLICT(id) DO UPDATE SET
         email = excluded.email,
         name = excluded.name,
         email_verified = excluded.email_verified,
         is_admin = excluded.is_admin,
         status = excluded.status,
         suspended_until = excluded.suspended_until,
         created_at = excluded.created_at,
         last_login_at = COALESCE(excluded.last_login_at, users.last_login_at),
         synced_at = excluded.synced_at
       -- A deletion (recorded by the sync, or a null getUser) is final: an
       -- in-flight refresh that read the account earlier must not revive it.
       WHERE users.status <> 'deleted' AND NOT EXISTS (SELECT 1 FROM identity_deletions x WHERE x.user_id = excluded.id)`,
    ).bind(
      user.id,
      user.email,
      user.name,
      user.emailVerified ? 1 : 0,
      user.isAdmin ? 1 : 0,
      user.status,
      user.suspendedUntil ?? null,
      user.createdAt,
      nowMs,
      opts.login ? nowMs : null,
      nowMs,
    ),
    db.prepare(`UPDATE project_members SET name = ?, email = ? WHERE user_id = ? AND (name <> ? OR email <> ?) AND NOT EXISTS (SELECT 1 FROM identity_deletions x WHERE x.user_id = ?)`)
      .bind(user.name, user.email, user.id, user.name, user.email, user.id),
    db.prepare(`UPDATE organization_members SET name = ?, email = ? WHERE user_id = ? AND (name <> ? OR email <> ?) AND NOT EXISTS (SELECT 1 FROM identity_deletions x WHERE x.user_id = ?)`)
      .bind(user.name, user.email, user.id, user.name, user.email, user.id),
  ];
}

// Returns how many member-row snapshots were out of date (and fixed).
//
// Every mirror write goes through here, so this is also where a changed
// email reaches the linked Stripe customer's receipt address: whichever
// refresh (sign-in, standing check, invite lookup, admin) first writes the
// new address is the one that sees the change. The leading SELECT runs in the
// same batch, so it reads the address the upsert replaces.
export async function refreshMirror(
  env: StripeEnv,
  user: IdentityUser,
  nowMs: number,
  opts: { login?: boolean } = {},
): Promise<{ project_members: number; organization_members: number }> {
  const [before, upsert, projects, orgs] = await env.DB.batch([
    env.DB.prepare("SELECT email FROM users WHERE id = ?").bind(user.id),
    ...mirrorUpsertStatements(env.DB, user, nowMs, opts),
  ]);
  const previous = (before?.results?.[0] as { email?: string } | undefined)?.email;
  if (previous && previous !== user.email && (upsert?.meta?.changes ?? 0) > 0) {
    await syncStripeCustomerEmail(env, user.id, user.email);
  }
  return { project_members: projects?.meta?.changes ?? 0, organization_members: orgs?.meta?.changes ?? 0 };
}

// Finds a person by email for "invite by email". Annex's mirror only knows
// people who have used Annex, so ask the identity service first and mirror
// whoever it returns (so member rows and joins have a users row to point at).
// Without the binding (unit tests, or the identity service unreachable) the
// mirror is the fallback.
export async function findUserByEmail(env: IdentityEnv, email: string, nowMs: number = Date.now()): Promise<{ id: string; email: string; name: string } | null> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return null;
  if (env.IDENTITY) {
    let user: IdentityUser | null = null;
    let reached = true;
    try {
      user = await env.IDENTITY.findUserByEmail(normalized);
    } catch (err) {
      // The mirror can hold a stale address (it isn't unique), so outside
      // local dev an outage must not resolve an invite to the wrong person.
      if (!isLocalDeploy(env)) throw err;
      reached = false;
      console.error("[identity] findUserByEmail failed; using mirror (local dev)", { err: String(err) });
    }
    if (reached) {
      if (!user) return null;
      // Never resurrect an account Annex has already processed as deleted.
      const gone = await env.DB.prepare("SELECT 1 AS x FROM identity_deletions WHERE user_id = ?").bind(user.id).first();
      if (gone) return null;
      await refreshMirror(env, user, nowMs);
      return { id: user.id, email: user.email, name: user.name };
    }
  }
  const row = await env.DB.prepare("SELECT id, email, name FROM users WHERE lower(email) = ? LIMIT 1")
    .bind(normalized).first<{ id: string; email: string; name: string }>();
  return row ?? null;
}
