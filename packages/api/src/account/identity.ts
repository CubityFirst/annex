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

// What every consumer of this module needs from its worker's Env.
export interface IdentityEnv {
  DB: D1Database;
  IDENTITY?: IdentityService;
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
}

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
  if (user && mirrorDiffers(mirror, user)) {
    const write = refreshMirror(env.DB, user, nowMs).catch(err =>
      console.error("[identity] mirror refresh failed", { userId: user.id, err: String(err) }),
    );
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
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         email = excluded.email,
         name = excluded.name,
         email_verified = excluded.email_verified,
         is_admin = excluded.is_admin,
         status = excluded.status,
         suspended_until = excluded.suspended_until,
         created_at = excluded.created_at,
         last_login_at = COALESCE(excluded.last_login_at, users.last_login_at),
         synced_at = excluded.synced_at`,
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
    db.prepare("UPDATE project_members SET name = ?, email = ? WHERE user_id = ? AND (name <> ? OR email <> ?)")
      .bind(user.name, user.email, user.id, user.name, user.email),
    db.prepare("UPDATE organization_members SET name = ?, email = ? WHERE user_id = ? AND (name <> ? OR email <> ?)")
      .bind(user.name, user.email, user.id, user.name, user.email),
  ];
}

// Returns how many member-row snapshots were out of date (and fixed).
export async function refreshMirror(
  db: D1Database,
  user: IdentityUser,
  nowMs: number,
  opts: { login?: boolean } = {},
): Promise<{ project_members: number; organization_members: number }> {
  const [, projects, orgs] = await db.batch(mirrorUpsertStatements(db, user, nowMs, opts));
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
      reached = false;
      console.error("[identity] findUserByEmail failed; using mirror", { err: String(err) });
    }
    if (reached) {
      if (!user) return null;
      // Never resurrect an account Annex has already processed as deleted.
      const gone = await env.DB.prepare("SELECT 1 AS x FROM identity_deletions WHERE user_id = ?").bind(user.id).first();
      if (gone) return null;
      await refreshMirror(env.DB, user, nowMs);
      return { id: user.id, email: user.email, name: user.name };
    }
  }
  const row = await env.DB.prepare("SELECT id, email, name FROM users WHERE lower(email) = ? LIMIT 1")
    .bind(normalized).first<{ id: string; email: string; name: string }>();
  return row ?? null;
}
