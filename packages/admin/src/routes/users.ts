import { Hono } from "hono";
import { zipSync, strToU8 } from "fflate";
import { resolvePersonalPlan, type PersonalPlan } from "../../../api/src/account/plan";
import { ALL_BADGE_BITS } from "../../../api/src/account/badges";
import { normalizeHandle, handleProblem, HANDLE_MIN_LENGTH, HANDLE_MAX_LENGTH } from "../../../api/src/account/handle";
import { writeAdminAudit } from "../audit";
import { type KeysetCursor, encodeCursor, decodeCursor, keysetClause } from "../lib/cursor";
import { escapeLike, LIKE_ESCAPE_CLAUSE } from "../lib/sql";
import { USER_DELETION_GRACE_SECONDS, checkOwnership, placeholders } from "../lib/userDeletion";
import { refreshMirror } from "../../../api/src/account/identity";
import type { AppEnv, Env } from "../index";

const usersRouter = new Hono<AppEnv>();

const USER_PAGE_SIZE = 25;

// Bound for raw Stripe error bodies before they land in a response, a log
// line, or an audit detail - they can carry request echoes and grow large.
function truncateStripeError(body: string, max = 300): string {
  return body.length > max ? `${body.slice(0, max)}… (truncated)` : body;
}

type ModerationAction = "disabled" | "suspended" | "re_enabled";

interface UserRow {
  id: string;
  email: string;
  name: string;
  created_at: string;
  moderation: number;
  force_password_change: number;
  email_verified: number;
  deletion_execute_after?: number | null;
  deletion_requested_by_email?: string | null;
  deletion_error?: string | null;
  deletion_started_at?: number | null;
  deletion_completed_at?: number | null;
  badges?: number | null;
  handle?: string | null;
  handle_locked?: number | null;
  latest_moderation_action: ModerationAction | null;
  latest_moderation_reason: string | null;
  latest_moderation_created_at: string | null;
}

interface ModerationEventRow {
  id: string;
  user_id: string;
  action: ModerationAction;
  moderation_value: number;
  reason: string | null;
  created_at: string;
  actor_user_id: string | null;
  actor_email: string | null;
}

type CurrentStatus = "active" | "disabled" | "suspended";

interface BillingDetails {
  resolved_plan: PersonalPlan;
  via: "free" | "paid" | "granted";
  status: string | null;
  started_at: number | null;
  cancel_at: number | null;
  granted: {
    plan: string;
    expires_at: number | null;
    reason: string | null;
  } | null;
  stripe: {
    customer_id: string | null;
    subscription_id: string | null;
  };
}

interface UserDetails {
  profile: {
    id: string;
    email: string;
    display_name: string;
    account_created_at: string;
    account_status: CurrentStatus;
    account_suspended_until?: number;
    force_password_change: boolean;
    email_verified: boolean;
    badges: number;
    handle: string | null;
    handle_locked: boolean;
  };
  moderation: {
    current_status: CurrentStatus;
    current_moderation_value: number;
    current_reason: string | null;
    history: Array<{
      action: ModerationAction;
      moderation_value: number;
      reason: string | null;
      created_at: string;
      actor_user_id: string | null;
      actor_email: string | null;
    }>;
  };
  // Sign-in methods, sessions and moderation are managed on the identity
  // service; the panel links there.
  identity: {
    manage_url: string;
    // True when standing came live from the identity service, false when it's
    // the users mirror's last known value (service unreachable).
    live: boolean;
    is_admin: boolean;
  };
  projects: {
    owned_projects: Array<{
      id: string;
      name: string;
      created_at: string;
    }>;
    project_memberships: Array<{
      project_id: string;
      project_name: string;
      role: string;
      joined_at: string;
    }>;
  };
  billing: BillingDetails;
}

// Account standing lives on the identity service now (moderated at
// auth.cubityfir.st/admin/users). The users mirror keeps its last known
// value as status + suspended_until; this expression re-encodes it as the
// legacy `moderation` number (0 active, -1 disabled, >0 suspended-until unix
// seconds) the panel's list/details shapes are built on.
export const MODERATION_SQL = "CASE u.status WHEN 'disabled' THEN -1 WHEN 'suspended' THEN COALESCE(u.suspended_until, 0) ELSE 0 END";

export function getModerationAction(moderation: number): ModerationAction {
  if (moderation === 0) return "re_enabled";
  if (moderation === -1) return "disabled";
  return "suspended";
}

export function getCurrentStatus(moderation: number): CurrentStatus {
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (moderation === -1) return "disabled";
  if (moderation > 0 && nowSeconds < moderation) return "suspended";
  return "active";
}

// Builds the optional account-status WHERE fragment for the user search.
// `status` accepts exactly "active" | "disabled" | "suspended" |
// "pending_deletion" (needs the search's `user_deletions d` join, which
// buildUserSearchQuery makes the driving table for that status); anything
// else (absent, empty, unknown) yields an empty clause => no status filter
// (all accounts). Pure so it can be unit-tested in isolation, mirroring
// buildAuditListQuery. `binds` are positional, in SQL order, to be spliced
// into the handler's bind list (after the email/id binds).
export function buildUserStatusClause(
  status: string | null,
  nowSeconds: number,
): { sql: string; binds: number[] } {
  switch (status) {
    case "active":
      return { sql: "(u.status = 'active' OR (u.status = 'suspended' AND COALESCE(u.suspended_until, 0) <= ?))", binds: [nowSeconds] };
    // The `u.status <> 'active'` term lets SQLite use the partial
    // idx_users_not_active index (api 0065) for the two rare statuses.
    case "disabled":
      return { sql: "u.status <> 'active' AND u.status = 'disabled'", binds: [] };
    case "suspended":
      return { sql: "u.status <> 'active' AND u.status = 'suspended' AND u.suspended_until > ?", binds: [nowSeconds] };
    case "pending_deletion":
      return { sql: "d.user_id IS NOT NULL", binds: [] };
    default:
      return { sql: "", binds: [] };
  }
}

// The user's latest moderation event as one correlated lookup returning
// json_array(action, reason, created_at) (NULL when there's none), instead of
// three identical subqueries; withLatestModeration unpacks it.
const LATEST_MODERATION_SQL = `(
          SELECT json_array(e.action, e.reason, e.created_at) FROM user_moderation_events e
          WHERE e.user_id = u.id ORDER BY e.created_at DESC, e.rowid DESC LIMIT 1
        ) AS latest_moderation`;

export type UserSearchRaw = Omit<
  UserRow,
  "latest_moderation_action" | "latest_moderation_reason" | "latest_moderation_created_at"
> & { latest_moderation: string | null };

export function withLatestModeration(row: UserSearchRaw): UserRow {
  const { latest_moderation, ...rest } = row;
  const [action, reason, createdAt] = latest_moderation
    ? (JSON.parse(latest_moderation) as [ModerationAction, string | null, string])
    : [null, null, null];
  return {
    ...rest,
    latest_moderation_action: action,
    latest_moderation_reason: reason,
    latest_moderation_created_at: createdAt,
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// How the search text is matched. A UUID-shaped query is looked up by id and
// a full email address by email (both unique-index seeks); anything else is
// the email substring search, which has to scan. The handler falls back to
// "substring" when an exact lookup finds nothing, so a partial or
// differently-cased address still finds what the substring search would.
export type UserSearchMatch = "id" | "email" | "substring";

export function exactUserMatch(q: string): UserSearchMatch {
  const t = q.trim();
  if (UUID_RE.test(t)) return "id";
  if (EMAIL_RE.test(t)) return "email";
  return "substring";
}

// The user-search list query. Search, status, and keyset cursor are AND-ed
// WHERE clauses; binds are positional in SQL order, excluding the trailing
// LIMIT bind (the caller appends it). Pure so it can run against real SQLite
// in tests.
export function buildUserSearchQuery(opts: {
  q: string;
  match: UserSearchMatch;
  status: string | null;
  cursor: KeysetCursor | null;
  nowSeconds: number;
}): { sql: string; binds: unknown[] } {
  const where: string[] = [];
  const binds: unknown[] = [];
  if (opts.match === "id") {
    where.push("u.id = ?");
    binds.push(opts.q.trim());
  } else if (opts.match === "email") {
    // The identity service stores addresses normalized (trimmed, lowercased).
    where.push("lower(u.email) = ?");
    binds.push(opts.q.trim().toLowerCase());
  } else if (opts.q) {
    // The handle match is exact on the normalized form, so `@Name` finds the
    // user whose profile link is /@name.
    where.push(`(u.email LIKE ? ${LIKE_ESCAPE_CLAUSE} OR u.id = ? OR p.handle = ?)`);
    binds.push(`%${escapeLike(opts.q)}%`, opts.q, normalizeHandle(opts.q));
  }
  const statusClause = buildUserStatusClause(opts.status, opts.nowSeconds);
  if (statusClause.sql) {
    where.push(statusClause.sql);
    binds.push(...statusClause.binds);
  }
  const keyset = keysetClause(opts.cursor, "u.created_at", "u.id");
  if (keyset.sql) {
    where.push(keyset.sql);
    binds.push(...keyset.binds);
  }
  // Pending deletions are few, so that filter is driven from user_deletions
  // (CROSS JOIN pins it as the outer loop) and sorted, instead of walking
  // every user in created_at order looking for the scheduled ones.
  const from = opts.status === "pending_deletion"
    ? "FROM user_deletions d CROSS JOIN users u ON u.id = d.user_id LEFT JOIN user_preferences p ON p.user_id = u.id"
    : "FROM users u LEFT JOIN user_deletions d ON d.user_id = u.id LEFT JOIN user_preferences p ON p.user_id = u.id";
  const sql = `
      SELECT
        u.id,
        u.email,
        u.name,
        u.created_at,
        ${MODERATION_SQL} AS moderation,
        0 AS force_password_change,
        u.email_verified,
        d.execute_after AS deletion_execute_after,
        d.completed_at AS deletion_completed_at,
        d.requested_by_email AS deletion_requested_by_email,
        d.last_error AS deletion_error,
        d.started_at AS deletion_started_at,
        p.handle,
        ${LATEST_MODERATION_SQL}
      ${from}
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY u.created_at DESC, u.id DESC
      LIMIT ?
    `;
  return { sql, binds };
}

export interface BillingRow {
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
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
  granted_plan_reason: string | null;
}

export function buildBillingDetails(row: BillingRow): BillingDetails {
  const resolved = resolvePersonalPlan({
    granted_plan: row.granted_plan,
    granted_plan_expires_at: row.granted_plan_expires_at,
    granted_plan_started_at: row.granted_plan_started_at,
    personal_plan: row.personal_plan,
    personal_plan_status: row.personal_plan_status,
    personal_plan_started_at: row.personal_plan_started_at,
    personal_plan_cancel_at: row.personal_plan_cancel_at,
    personal_plan_style: row.personal_plan_style,
    personal_presence_color: row.personal_presence_color,
    personal_crit_sparkles: row.personal_crit_sparkles,
  });
  return {
    resolved_plan: resolved.plan,
    via: resolved.via,
    status: resolved.status,
    started_at: resolved.since,
    cancel_at: resolved.cancelAt,
    granted: row.granted_plan
      ? { plan: row.granted_plan, expires_at: row.granted_plan_expires_at, reason: row.granted_plan_reason }
      : null,
    stripe: {
      customer_id: row.stripe_customer_id,
      subscription_id: row.stripe_subscription_id,
    },
  };
}

type ProfileRow = BillingRow & {
  id: string;
  email: string;
  name: string;
  created_at: string;
  moderation: number;
  force_password_change: number;
  email_verified: number;
  is_admin: number;
  badges: number | null;
  handle: string | null;
  handle_locked: number | null;
};

export function identityAdminUrl(env: Pick<Env, "OIDC_ISSUER">, userId: string): string {
  const issuer = (env.OIDC_ISSUER ?? "https://auth.cubityfir.st").replace(/\/+$/, "");
  return `${issuer}/admin/users/${encodeURIComponent(userId)}`;
}

async function loadUserDetails(env: Env, id: string): Promise<UserDetails | null> {
  // Live standing from the identity service first, so the mirror (and the
  // profile read below) reflects it; the mirror is the fallback.
  let live = false;
  if (env.IDENTITY) {
    try {
      const user = await env.IDENTITY.getUser(id);
      if (user) {
        await refreshMirror(env.DB, user, Date.now());
        live = true;
      }
    } catch (err) {
      console.error("[admin] identity getUser failed; showing mirror standing", String(err));
    }
  }

  const [profile, moderationHistory, ownedProjects, memberships] = await Promise.all([
    env.DB.prepare(
      `SELECT u.id, u.email, u.name, u.created_at, ${MODERATION_SQL} AS moderation, 0 AS force_password_change,
              u.email_verified, u.is_admin,
              p.badges, p.handle, p.handle_locked,
              p.personal_plan_style, p.personal_presence_color, p.personal_crit_sparkles,
              b.stripe_customer_id, b.stripe_subscription_id,
              b.personal_plan, b.personal_plan_status, b.personal_plan_started_at,
              b.personal_plan_cancel_at,
              b.granted_plan, b.granted_plan_expires_at, b.granted_plan_started_at,
              b.granted_plan_reason
       FROM users u
       LEFT JOIN user_preferences p ON p.user_id = u.id
       LEFT JOIN user_billing b ON b.user_id = u.id
       WHERE u.id = ?`,
    ).bind(id).first<ProfileRow>(),
    env.DB.prepare(
      `
        SELECT id, user_id, action, moderation_value, reason, created_at, actor_user_id, actor_email
        FROM user_moderation_events
        WHERE user_id = ?
        ORDER BY created_at DESC, rowid DESC
      `,
    ).bind(id).all<ModerationEventRow>(),
    env.DB.prepare(
      "SELECT id, name, created_at FROM projects WHERE owner_id = ? ORDER BY created_at DESC",
    ).bind(id).all<{ id: string; name: string; created_at: string }>(),
    env.DB.prepare(
      `
        SELECT p.id, p.name, pm.role, pm.created_at
        FROM project_members pm
        JOIN projects p ON pm.project_id = p.id
        WHERE pm.user_id = ?
        ORDER BY pm.created_at DESC
      `,
    ).bind(id).all<{ id: string; name: string; role: string; created_at: string }>(),
  ]);

  if (!profile) return null;

  const currentStatus = getCurrentStatus(profile.moderation);
  // The history is newest-first in the same (created_at DESC, rowid DESC)
  // order as the user list's latest-moderation lookup, so its head is the
  // latest event.
  const currentReason = currentStatus === "active" ? null : (moderationHistory.results[0]?.reason ?? null);

  return {
    profile: {
      id: profile.id,
      email: profile.email,
      display_name: profile.name,
      account_created_at: profile.created_at,
      account_status: currentStatus,
      ...(currentStatus === "suspended" ? { account_suspended_until: profile.moderation } : {}),
      force_password_change: Boolean(profile.force_password_change),
      email_verified: Boolean(profile.email_verified),
      badges: profile.badges ?? 0,
      handle: profile.handle ?? null,
      handle_locked: !!profile.handle_locked,
    },
    moderation: {
      current_status: currentStatus,
      current_moderation_value: profile.moderation,
      current_reason: currentReason,
      history: moderationHistory.results.map(event => ({
        action: event.action,
        moderation_value: event.moderation_value,
        reason: event.reason,
        created_at: event.created_at,
        actor_user_id: event.actor_user_id,
        actor_email: event.actor_email,
      })),
    },
    identity: {
      manage_url: identityAdminUrl(env, profile.id),
      live,
      is_admin: Boolean(profile.is_admin),
    },
    projects: {
      owned_projects: ownedProjects.results.map(p => ({ id: p.id, name: p.name, created_at: p.created_at })),
      project_memberships: memberships.results.map(m => ({ project_id: m.id, project_name: m.name, role: m.role, joined_at: m.created_at })),
    },
    billing: buildBillingDetails(profile),
  };
}

// GET /api/users/search?q=
usersRouter.get("/search", async (c) => {
  const q = c.req.query("q") ?? "";
  const nowSeconds = Math.floor(Date.now() / 1000);
  const status = c.req.query("status") ?? null;

  const rawCursor = c.req.query("cursor");
  let cursor: KeysetCursor | null = null;
  if (rawCursor) {
    cursor = decodeCursor(rawCursor);
    if (!cursor) return c.json({ ok: false, error: "Invalid cursor" }, 400);
  }

  // One extra row tells us whether an older page exists without a count.
  const run = async (match: UserSearchMatch) => {
    const { sql, binds } = buildUserSearchQuery({ q, match, status, cursor, nowSeconds });
    return (await c.env.DB.prepare(sql).bind(...binds, USER_PAGE_SIZE + 1).all<UserSearchRaw>()).results;
  };
  const match = exactUserMatch(q);
  let results = await run(match);
  // An exact lookup that misses falls back to the substring search. Every
  // request in a paging sequence takes the same path: an exact hit is at
  // most one row (so it never yields a cursor), and a miss stays a miss.
  if (results.length === 0 && match !== "substring") results = await run("substring");

  const hasMore = results.length > USER_PAGE_SIZE;
  const users = (hasMore ? results.slice(0, USER_PAGE_SIZE) : results).map(withLatestModeration);
  const last = users[users.length - 1];
  const nextCursor =
    hasMore && last ? encodeCursor({ ts: last.created_at, id: last.id }) : null;

  return c.json({ ok: true, data: { users, nextCursor } });
});

// PATCH /api/users/:id/badges - { badges: number } (bitmask)
usersRouter.patch("/:id/badges", async (c) => {
  const session = c.get("session");

  const id = c.req.param("id");
  const body = await c.req.json<{ badges: number }>().catch(() => ({} as { badges?: number }));
  const badges = body.badges;
  // The upper bound matters beyond readability: the bitwise mask coerces via
  // ToInt32, so e.g. 2^32 + <allowed> would slip through a mask-only check.
  if (!Number.isInteger(badges) || badges! < 0 || badges! > ALL_BADGE_BITS || (badges! & ~ALL_BADGE_BITS) !== 0) {
    return c.json({ ok: false, error: "Invalid badges value" }, 400);
  }

  // Verify the user exists; we used to infer 404 from changes=0, but a fresh
  // user with no preferences row would now also produce changes=0 even though
  // they exist (the upsert creates the row).
  const userRow = await c.env.DB.prepare("SELECT 1 FROM users WHERE id = ?")
    .bind(id).first<{ "1": number }>();
  if (!userRow) return c.json({ ok: false, error: "User not found" }, 404);

  await c.env.DB.prepare(
    `INSERT INTO user_preferences (user_id, badges) VALUES (?, ?)
     ON CONFLICT(user_id) DO UPDATE SET badges = excluded.badges`,
  ).bind(id, badges).run();
  await writeAdminAudit(c.env, session, "user.badges.update", "user", id, { badges });
  return c.json({ ok: true });
});

// PATCH /api/users/:id/handle - { handle?: string | null, locked?: boolean }
// Moderates the opt-in `/@<handle>` profile link. `handle` sets/renames (null
// or "" clears and releases it); `locked` stops the user changing it from
// their own settings (auth /update-handle refuses while locked). Admins may
// assign reserved names (e.g. an official account) but not malformed ones.
// Only the provided fields are written, so toggling the lock never races a
// concurrent user rename back to a stale value.
usersRouter.patch("/:id/handle", async (c) => {
  const session = c.get("session");
  const id = c.req.param("id");
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body || typeof body !== "object") return c.json({ ok: false, error: "Invalid body" }, 400);
  const hasHandle = "handle" in body;
  const hasLocked = "locked" in body;
  if (!hasHandle && !hasLocked) return c.json({ ok: false, error: "Nothing to update" }, 400);

  let handle: string | null = null;
  if (hasHandle) {
    if (body.handle !== null && typeof body.handle !== "string") {
      return c.json({ ok: false, error: "Invalid handle" }, 400);
    }
    const normalized = typeof body.handle === "string" ? normalizeHandle(body.handle) : "";
    if (normalized) {
      const problem = handleProblem(normalized);
      if (problem === "length") return c.json({ ok: false, error: `Username must be ${HANDLE_MIN_LENGTH}-${HANDLE_MAX_LENGTH} characters` }, 400);
      if (problem === "characters") {
        return c.json({ ok: false, error: "Username may only use a-z, 0-9, - and _, starting and ending with a letter or number" }, 400);
      }
      // "reserved" is deliberately allowed for admins.
      handle = normalized;
    }
  }
  if (hasLocked && typeof body.locked !== "boolean") return c.json({ ok: false, error: "Invalid locked value" }, 400);
  const locked = body.locked === true;

  const current = await c.env.DB.prepare(
    `SELECT u.id, p.handle, p.handle_locked
     FROM users u LEFT JOIN user_preferences p ON p.user_id = u.id
     WHERE u.id = ?`,
  ).bind(id).first<{ id: string; handle: string | null; handle_locked: number | null }>();
  if (!current) return c.json({ ok: false, error: "User not found" }, 404);

  const sets: string[] = [];
  if (hasHandle) sets.push("handle = excluded.handle");
  if (hasLocked) sets.push("handle_locked = excluded.handle_locked");
  try {
    await c.env.DB.prepare(
      `INSERT INTO user_preferences (user_id, handle, handle_locked) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET ${sets.join(", ")}`,
    ).bind(id, hasHandle ? handle : null, hasLocked && locked ? 1 : 0).run();
  } catch (err) {
    if (err instanceof Error && err.message.includes("UNIQUE constraint failed")) {
      return c.json({ ok: false, error: "That username is taken" }, 409);
    }
    throw err;
  }

  const result = {
    handle: hasHandle ? handle : current.handle ?? null,
    handle_locked: hasLocked ? locked : !!current.handle_locked,
  };
  await writeAdminAudit(c.env, session, "user.handle.update", "user", id, {
    ...(hasHandle ? { from: current.handle ?? null, to: handle } : {}),
    ...(hasLocked ? { locked } : {}),
  });
  return c.json({ ok: true, data: result });
});

// POST /api/users/:id/resync-name - refreshes the users mirror from the
// identity service (the source of truth for name/email) and re-copies the
// name over the denormalized snapshots (project_members +
// organization_members). Sign-in and the standing check keep these in sync;
// this repairs rows that captured a wrong snapshot at insert time.
usersRouter.post("/:id/resync-name", async (c) => {
  const session = c.get("session");

  const id = c.req.param("id");
  // The mirror refresh fixes stale name AND email snapshots itself; count
  // what it fixed so the response and audit row report the real total.
  let refreshed = { project_members: 0, organization_members: 0 };
  if (c.env.IDENTITY) {
    try {
      const user = await c.env.IDENTITY.getUser(id);
      if (user) refreshed = await refreshMirror(c.env.DB, user, Date.now());
    } catch (err) {
      console.error("[admin] resync-name: identity getUser failed; using the mirror", String(err));
    }
  }
  const userRow = await c.env.DB.prepare("SELECT name FROM users WHERE id = ?")
    .bind(id).first<{ name: string }>();
  if (!userRow) return c.json({ ok: false, error: "User not found" }, 404);

  // `AND name <> ?` keeps the changes counts meaningful: they report rows
  // that were actually wrong, not every membership the user has.
  const [projectRes, orgRes] = await c.env.DB.batch([
    c.env.DB.prepare("UPDATE project_members SET name = ? WHERE user_id = ? AND name <> ?")
      .bind(userRow.name, id, userRow.name),
    c.env.DB.prepare("UPDATE organization_members SET name = ? WHERE user_id = ? AND name <> ?")
      .bind(userRow.name, id, userRow.name),
  ]);
  const updated = {
    project_members: refreshed.project_members + (projectRes?.meta?.changes ?? 0),
    organization_members: refreshed.organization_members + (orgRes?.meta?.changes ?? 0),
  };

  await writeAdminAudit(c.env, session, "user.name.resync", "user", id, updated);
  return c.json({ ok: true, data: updated });
});

// ---------------------------------------------------------------------------
// Account deletion (bulk "Delete" on the Users page) - DELAYED, see
// lib/userDeletion.ts. The panel never deletes an account outright:
//   1. POST /delete-preview { ids } - read-only. Per account: owned sites
//      (with doc + other-member counts), owned orgs, Stripe state, and
//      whether it can't be scheduled (self / admin / already scheduled).
//   2. POST /:id/deletion { confirm_site_ids, confirm_org_ids } - schedules
//      the deletion of one person's ANNEX data: blocks them from Annex now,
//      deletes after the grace window. Owned sites/orgs go with it ONLY when
//      the caller lists exactly the set the account owns; the cron re-checks
//      the same sets before deleting. The identity account is deleted
//      separately at auth.cubityfir.st.
//   3. DELETE /:id/deletion - cancels, unblocking them.
// ---------------------------------------------------------------------------

// The Users page selects at most a few loaded pages; this bounds the IN (...)
// lists below well under D1's bound-parameter limit.
const DELETE_PREVIEW_MAX_IDS = 50;

export interface DeletePreviewSite {
  id: string;
  name: string;
  docs: number;
  // Members other than the owner (accepted + pending) - people who lose
  // access if the site is deleted.
  other_members: number;
  published: boolean;
}

export interface DeletePreviewOrg {
  id: string;
  name: string;
  // Sites attached to the org. Deleting an org DETACHES them (they survive);
  // members lose the org's trickle-down access.
  sites: number;
  other_members: number;
}

export interface DeletePreviewEntry {
  id: string;
  email: string;
  name: string;
  // Non-null => the account can't be scheduled for deletion.
  blocked: "self" | "admin" | "scheduled" | null;
  owned_sites: DeletePreviewSite[];
  owned_orgs: DeletePreviewOrg[];
  has_stripe_customer: boolean;
  has_subscription: boolean;
}

// POST /api/users/delete-preview - { ids: string[] }. Read-only; not audited.
// Unknown ids are simply absent from the result.
usersRouter.post("/delete-preview", async (c) => {
  const session = c.get("session");
  const body = await c.req.json<{ ids?: unknown }>().catch(() => ({} as { ids?: unknown }));
  const ids = Array.isArray(body.ids)
    ? [...new Set(body.ids.filter((v): v is string => typeof v === "string" && v.length > 0))]
    : [];
  if (ids.length === 0) return c.json({ ok: false, error: "No users selected" }, 400);
  if (ids.length > DELETE_PREVIEW_MAX_IDS) {
    return c.json({ ok: false, error: `Select at most ${DELETE_PREVIEW_MAX_IDS} users at a time` }, 400);
  }
  const ph = placeholders(ids.length);

  const [users, sites, orgs] = await Promise.all([
    c.env.DB.prepare(
      `SELECT u.id, u.email, u.name, u.is_admin, b.stripe_customer_id, b.stripe_subscription_id,
              d.user_id IS NOT NULL AS scheduled
       FROM users u
       LEFT JOIN user_billing b ON b.user_id = u.id
       LEFT JOIN user_deletions d ON d.user_id = u.id
       WHERE u.id IN (${ph})`,
    ).bind(...ids).all<{
      id: string; email: string; name: string; is_admin: number;
      stripe_customer_id: string | null; stripe_subscription_id: string | null; scheduled: number;
    }>(),
    c.env.DB.prepare(
      `SELECT p.id, p.name, p.owner_id, p.published_at,
              (SELECT COUNT(*) FROM docs d WHERE d.project_id = p.id) AS docs,
              (SELECT COUNT(*) FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id <> p.owner_id) AS other_members
       FROM projects p WHERE p.owner_id IN (${ph})
       ORDER BY p.created_at DESC`,
    ).bind(...ids).all<{
      id: string; name: string; owner_id: string; published_at: string | null; docs: number; other_members: number;
    }>(),
    c.env.DB.prepare(
      `SELECT o.id, o.name, o.owner_id,
              (SELECT COUNT(*) FROM projects p WHERE p.organization_id = o.id) AS sites,
              (SELECT COUNT(*) FROM organization_members om WHERE om.organization_id = o.id AND om.user_id <> o.owner_id) AS other_members
       FROM organizations o WHERE o.owner_id IN (${ph})`,
    ).bind(...ids).all<{ id: string; name: string; owner_id: string; sites: number; other_members: number }>(),
  ]);

  const byId = new Map(users.results.map(u => [u.id, u]));
  // Preserve the caller's selection order.
  const preview: DeletePreviewEntry[] = ids.flatMap(id => {
    const u = byId.get(id);
    if (!u) return [];
    return [{
      id: u.id,
      email: u.email,
      name: u.name,
      blocked: u.id === session.userId ? "self" : u.is_admin ? "admin" : u.scheduled ? "scheduled" : null,
      owned_sites: sites.results
        .filter(s => s.owner_id === id)
        .map(s => ({ id: s.id, name: s.name, docs: s.docs, other_members: s.other_members, published: s.published_at !== null })),
      owned_orgs: orgs.results
        .filter(o => o.owner_id === id)
        .map(o => ({ id: o.id, name: o.name, sites: o.sites, other_members: o.other_members })),
      has_stripe_customer: Boolean(u.stripe_customer_id),
      has_subscription: Boolean(u.stripe_subscription_id),
    }];
  });

  return c.json({ ok: true, data: { users: preview } });
});

// POST /api/users/:id/deletion - { confirm_site_ids?: string[], confirm_org_ids?: string[] }
//
// Schedules the deletion of the person's Annex data after the grace window
// and blocks them from Annex now (the user_deletions row itself is the block -
// see api account/session.ts). Nothing irreversible happens here.
usersRouter.post("/:id/deletion", async (c) => {
  const session = c.get("session");
  const id = c.req.param("id");
  const body = await c.req.json<{ confirm_site_ids?: unknown; confirm_org_ids?: unknown }>()
    .catch(() => ({} as { confirm_site_ids?: unknown; confirm_org_ids?: unknown }));
  const toIds = (v: unknown) => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string"))] : []);
  const confirm = { siteIds: toIds(body.confirm_site_ids), orgIds: toIds(body.confirm_org_ids) };

  if (id === session.userId) {
    return c.json({ ok: false, error: "You can't delete your own account from the admin panel" }, 400);
  }

  const user = await c.env.DB.prepare(
    `SELECT u.id, u.email, u.is_admin, d.user_id IS NOT NULL AS scheduled
     FROM users u LEFT JOIN user_deletions d ON d.user_id = u.id
     WHERE u.id = ?`,
  ).bind(id).first<{ id: string; email: string; is_admin: number; scheduled: number }>();
  if (!user) return c.json({ ok: false, error: "User not found" }, 404);
  if (user.is_admin) {
    return c.json({ ok: false, error: "Admin accounts can't be deleted from the admin panel" }, 409);
  }
  if (user.scheduled) {
    return c.json({ ok: false, error: `${user.email} is already scheduled for deletion` }, 409);
  }

  const ownership = await checkOwnership(c.env, id, user.email, confirm);
  if (ownership.error) return c.json({ ok: false, error: ownership.error }, 409);

  const executeAfter = Math.floor(Date.now() / 1000) + USER_DELETION_GRACE_SECONDS;
  const inserted = await c.env.DB.prepare(
    `INSERT INTO user_deletions
       (user_id, id, requested_by, requested_by_email, execute_after, confirm_site_ids, confirm_org_ids)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id, crypto.randomUUID(), session.userId, session.email, executeAfter,
    JSON.stringify(ownership.sites.map(s => s.id)), JSON.stringify(ownership.orgs.map(o => o.id)),
  ).run().then(
    () => true,
    // Another admin scheduling the same account at the same moment loses on
    // the user_deletions primary key - report that as the clean 409 the
    // pre-check would have given.
    async (err: unknown) => {
      const raced = await c.env.DB.prepare("SELECT 1 AS x FROM user_deletions WHERE user_id = ?").bind(id).first();
      if (raced) return false;
      throw err;
    },
  );
  if (!inserted) return c.json({ ok: false, error: `${user.email} is already scheduled for deletion` }, 409);

  await writeAdminAudit(c.env, session, "user.delete.schedule", "user", id, {
    email: user.email,
    execute_after: executeAfter,
    sites: ownership.sites,
    orgs: ownership.orgs,
  });

  return c.json({ ok: true, data: { execute_after: executeAfter } });
});

// DELETE /api/users/:id/deletion - cancel a scheduled deletion, which also
// lifts the Annex block. Refused once the cron has started executing it
// (started_at) or while a cron run holds its lease - a half-run deletion can
// only be finished, never rolled back.
usersRouter.delete("/:id/deletion", async (c) => {
  const session = c.get("session");
  const id = c.req.param("id");
  const nowSeconds = Math.floor(Date.now() / 1000);

  const row = await c.env.DB.prepare(
    "SELECT id, started_at, lease_until FROM user_deletions WHERE user_id = ?",
  ).bind(id).first<{ id: string; started_at: number | null; lease_until: number | null }>();
  if (!row) return c.json({ ok: false, error: "No deletion is scheduled for this account" }, 404);
  const inProgress = "This deletion has already started and can't be cancelled";
  if (row.started_at !== null) return c.json({ ok: false, error: inProgress }, 409);
  if (row.lease_until !== null && row.lease_until >= nowSeconds) {
    return c.json({ ok: false, error: "This deletion is being processed right now - try again in a few minutes" }, 409);
  }

  // Conditioned on THIS schedule (by id) still existing and being
  // cancellable, so a cron claim or another admin's cancel landing in between
  // turns the cancel into a no-op.
  const removed = await c.env.DB.prepare(
    `DELETE FROM user_deletions
     WHERE user_id = ? AND id = ? AND started_at IS NULL AND (lease_until IS NULL OR lease_until < ?)`,
  ).bind(id, row.id, nowSeconds).run();
  if ((removed?.meta?.changes ?? 0) === 0) {
    return c.json({ ok: false, error: "This deletion is being processed right now - try again in a few minutes" }, 409);
  }

  await writeAdminAudit(c.env, session, "user.delete.cancel", "user", id);
  return c.json({ ok: true });
});


// GET /api/users/:id
usersRouter.get("/:id", async (c) => {
  const id = c.req.param("id");
  const details = await loadUserDetails(c.env, id);

  if (!details) return c.json({ ok: false, error: "User not found" }, 404);

  return c.json({ ok: true, data: details });
});

// DELETE /api/users/:id/avatar
usersRouter.delete("/:id/avatar", async (c) => {
  const session = c.get("session");

  const id = c.req.param("id");
  // Confirm the user exists so we don't log an audit row + report success
  // for a no-op delete against a nonexistent id.
  const userRow = await c.env.DB.prepare("SELECT 1 FROM users WHERE id = ?")
    .bind(id).first<{ "1": number }>();
  if (!userRow) return c.json({ ok: false, error: "User not found" }, 404);

  // Remove both variants and any legacy object.
  await c.env.ASSETS.delete([`avatars/${id}-dark`, `avatars/${id}-light`, `avatars/${id}`]);
  await writeAdminAudit(c.env, session, "user.avatar.delete", "user", id);
  return c.json({ ok: true });
});

// POST /api/users/:id/grant-ink - {
//   reason?: string,
//   expires_at?: number | null,
//   cancel_existing_paid_sub?: boolean,
// }
//
// Manually grants an Annex Ink supporter subscription to the user. The
// grant takes precedence over any Stripe-managed plan in the resolver.
// expires_at is a Unix-ms timestamp; null = forever. When
// cancel_existing_paid_sub is true and the user has a Stripe sub, we
// also flip Stripe's cancel_at_period_end so they stop being billed
// after the current cycle. The grant keeps them on Ink either way.
usersRouter.post("/:id/grant-ink", async (c) => {
  const session = c.get("session");

  const id = c.req.param("id");
  const body = await c.req.json<{ reason?: string; expires_at?: number | null; cancel_existing_paid_sub?: boolean }>()
    .catch(() => ({} as { reason?: string; expires_at?: number | null; cancel_existing_paid_sub?: boolean }));
  const reason = body.reason?.trim() || `granted by ${session.email}`;
  const expiresAt = body.expires_at ?? null;
  const cancelExisting = body.cancel_existing_paid_sub === true;

  if (expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt <= Date.now())) {
    return c.json({ ok: false, error: "expires_at must be a future Unix-ms timestamp or null" }, 400);
  }

  // If admin asked to cancel the existing paid sub, look it up and call
  // Stripe before writing the grant. Failing to cancel is non-fatal -
  // log it and still apply the grant; admin can retry the cancel later.
  let cancelStripeWarning: string | null = null;
  if (cancelExisting) {
    if (!c.env.STRIPE_SECRET_KEY) {
      cancelStripeWarning = "STRIPE_SECRET_KEY is unset on the admin worker; paid sub was not cancelled";
    } else {
      const subRow = await c.env.DB.prepare(
        "SELECT stripe_subscription_id FROM user_billing WHERE user_id = ?",
      ).bind(id).first<{ stripe_subscription_id: string | null }>();
      const subId = subRow?.stripe_subscription_id;
      if (subId) {
        const res = await fetch(`https://api.stripe.com/v1/subscriptions/${subId}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${c.env.STRIPE_SECRET_KEY}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: "cancel_at_period_end=true",
        });
        if (!res.ok) {
          const errBody = await res.text().catch(() => "(unreadable)");
          cancelStripeWarning = `Stripe cancel returned ${res.status}: ${truncateStripeError(errBody)}`;
          console.error("admin cancel-on-grant failed:", cancelStripeWarning);
        }
      }
    }
  }

  // Verify the user exists before upserting - UPSERT into user_billing
  // would otherwise silently create a row for a non-existent id (well,
  // the FK would reject it, but a cleaner error is nicer).
  const userRow = await c.env.DB.prepare("SELECT 1 FROM users WHERE id = ?")
    .bind(id).first<{ "1": number }>();
  if (!userRow) return c.json({ ok: false, error: "User not found" }, 404);

  // Preserve granted_plan_started_at across re-grants (admin re-grants
  // the same user shouldn't reset their "supporter since" date).
  await c.env.DB.prepare(
    `INSERT INTO user_billing (user_id, granted_plan, granted_plan_expires_at, granted_plan_reason, granted_plan_started_at)
     VALUES (?, 'ink', ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       granted_plan = 'ink',
       granted_plan_expires_at = excluded.granted_plan_expires_at,
       granted_plan_reason = excluded.granted_plan_reason,
       granted_plan_started_at = COALESCE(user_billing.granted_plan_started_at, excluded.granted_plan_started_at)`,
  ).bind(id, expiresAt, reason, Date.now()).run();

  await writeAdminAudit(c.env, session, "user.ink.grant", "user", id, {
    expiresAt,
    reason,
    cancelExisting,
    cancelStripeWarning,
  });

  return c.json({ ok: true, data: cancelStripeWarning ? { cancelStripeWarning } : undefined });
});

// POST /api/users/:id/gift-month - credits the user's Stripe customer
// balance with one month of their current sub price. Stripe applies the
// credit to the next invoice automatically; sub status stays `active`,
// user sees a "$X.00 credit applied" line on their invoice. Skip
// granting Ink - they're already paying, this just gifts them a month
// off the bill.
//
// Doesn't work for cancel-at-period-end subs (no future invoice to
// apply credit to) or for users without a paid sub.
usersRouter.post("/:id/gift-month", async (c) => {
  const session = c.get("session");

  if (!c.env.STRIPE_SECRET_KEY) {
    return c.json({ ok: false, error: "STRIPE_SECRET_KEY is unset on the admin worker" }, 500);
  }

  const id = c.req.param("id");
  const row = await c.env.DB.prepare(
    "SELECT stripe_customer_id, stripe_subscription_id FROM user_billing WHERE user_id = ?",
  ).bind(id).first<{ stripe_customer_id: string | null; stripe_subscription_id: string | null }>();
  if (!row?.stripe_customer_id || !row.stripe_subscription_id) {
    return c.json({ ok: false, error: "User has no Stripe customer or subscription" }, 400);
  }

  // Fetch the sub to get its current per-cycle price. Avoids hardcoding
  // $5 - works correctly if Ink ever moves to a different price tier.
  const subRes = await fetch(`https://api.stripe.com/v1/subscriptions/${row.stripe_subscription_id}`, {
    headers: { Authorization: `Bearer ${c.env.STRIPE_SECRET_KEY}` },
  });
  if (!subRes.ok) {
    const errText = await subRes.text().catch(() => "(unreadable)");
    console.error("admin gift-month: sub fetch failed:", subRes.status, truncateStripeError(errText));
    return c.json({ ok: false, error: `Stripe returned ${subRes.status} fetching sub` }, 502);
  }
  const sub = await subRes.json<{
    cancel_at_period_end?: boolean;
    current_period_end?: number;
    items: { data: Array<{ price: { unit_amount: number | null; currency: string } }> };
  }>();
  if (sub.cancel_at_period_end) {
    return c.json({ ok: false, error: "Subscription is already pending cancellation" }, 400);
  }
  const item = sub.items.data[0];
  const amount = item?.price?.unit_amount;
  const currency = item?.price?.currency;
  if (!amount || !currency) {
    return c.json({ ok: false, error: "Could not determine subscription price" }, 502);
  }

  // Idempotency key scoped to (admin, user, billing period): a double-click,
  // a retry after a network error, or a "credit succeeded but our 500 made
  // the operator retry" all replay as the SAME Stripe request instead of
  // stacking a second credit. A different admin (or the next billing period)
  // gets a fresh key, so deliberate repeat gifts still work.
  const idempotencyKey = `gift-month:${session.userId}:${id}:${sub.current_period_end ?? "na"}`;
  const balanceRes = await fetch(
    `https://api.stripe.com/v1/customers/${row.stripe_customer_id}/balance_transactions`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${c.env.STRIPE_SECRET_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "Idempotency-Key": idempotencyKey,
      },
      body: new URLSearchParams({
        amount: String(-amount),
        currency,
        description: `Free month gifted by ${session.email}`,
      }).toString(),
    },
  );
  if (!balanceRes.ok) {
    const errText = await balanceRes.text().catch(() => "(unreadable)");
    console.error("admin gift-month: balance transaction failed:", balanceRes.status, truncateStripeError(errText));
    return c.json({ ok: false, error: `Stripe returned ${balanceRes.status} creating credit` }, 502);
  }

  await writeAdminAudit(c.env, session, "user.gift_month", "user", id, { amount, currency });

  return c.json({ ok: true, data: { amount, currency } });
});

// POST /api/users/:id/cancel-subscription - { immediate?: boolean }
//
// Cancels the user's Stripe subscription directly. By default schedules
// cancel-at-period-end so they keep access through the end of the
// billing cycle they paid for. Pass immediate=true for chargebacks /
// TOS violations where you want access cut off right now. The webhook
// (subscription.deleted for immediate, subscription.updated for
// scheduled) fires asynchronously and updates the user row via the
// existing handler - no direct DB write here.
usersRouter.post("/:id/cancel-subscription", async (c) => {
  const session = c.get("session");

  if (!c.env.STRIPE_SECRET_KEY) {
    return c.json({ ok: false, error: "STRIPE_SECRET_KEY is unset on the admin worker" }, 500);
  }

  const id = c.req.param("id");
  const body = await c.req.json<{ immediate?: boolean }>()
    .catch(() => ({} as { immediate?: boolean }));
  const immediate = body.immediate === true;

  const subRow = await c.env.DB.prepare(
    "SELECT stripe_subscription_id FROM user_billing WHERE user_id = ?",
  ).bind(id).first<{ stripe_subscription_id: string | null }>();
  const subId = subRow?.stripe_subscription_id;
  if (!subId) return c.json({ ok: false, error: "User has no active Stripe subscription" }, 400);

  const url = `https://api.stripe.com/v1/subscriptions/${subId}`;
  const fetchOptions: RequestInit = immediate
    ? {
        method: "DELETE",
        headers: { Authorization: `Bearer ${c.env.STRIPE_SECRET_KEY}` },
      }
    : {
        method: "POST",
        headers: {
          Authorization: `Bearer ${c.env.STRIPE_SECRET_KEY}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "cancel_at_period_end=true",
      };

  const res = await fetch(url, fetchOptions);
  if (!res.ok) {
    const errBody = await res.text().catch(() => "(unreadable)");
    console.error(`admin cancel-subscription ${immediate ? "immediate" : "period-end"} failed:`, res.status, truncateStripeError(errBody));
    return c.json({ ok: false, error: `Stripe returned ${res.status}` }, 502);
  }

  await writeAdminAudit(c.env, session, "user.subscription.cancel", "user", id, { immediate });

  return c.json({ ok: true, data: { immediate } });
});

// DELETE /api/users/:id/grant-ink - clears the manual grant. Doesn't
// touch Stripe-managed columns (so a paid sub stays intact).
usersRouter.delete("/:id/grant-ink", async (c) => {
  const session = c.get("session");

  const id = c.req.param("id");
  // Verify the user exists; we used to infer 404 from changes=0 on the
  // UPDATE, but a user without any billing row legitimately has nothing
  // to clear, which is now changes=0 as well.
  const userRow = await c.env.DB.prepare("SELECT 1 FROM users WHERE id = ?")
    .bind(id).first<{ "1": number }>();
  if (!userRow) return c.json({ ok: false, error: "User not found" }, 404);

  // We clear granted_plan_started_at too, so the next grant gets a
  // fresh "supporter since" date - revoke is a hard reset of the
  // grant relationship, not just a pause.
  await c.env.DB.prepare(
    `UPDATE user_billing
     SET granted_plan = NULL,
         granted_plan_expires_at = NULL,
         granted_plan_started_at = NULL,
         granted_plan_reason = NULL
     WHERE user_id = ?`,
  ).bind(id).run();
  await writeAdminAudit(c.env, session, "user.ink.revoke", "user", id);
  return c.json({ ok: true });
});

// GET /api/users/:id/export - GDPR-style data export as .zip
usersRouter.get("/:id/export", async (c) => {
  const session = c.get("session");

  const id = c.req.param("id");
  const details = await loadUserDetails(c.env, id);

  if (!details) return c.json({ ok: false, error: "User not found" }, 404);

  const zip = zipSync({
    "profile.json": strToU8(JSON.stringify(details.profile, null, 2)),
    "moderation.json": strToU8(JSON.stringify(details.moderation, null, 2)),
    "projects.json": strToU8(JSON.stringify(details.projects, null, 2)),
    "billing.json": strToU8(JSON.stringify(details.billing, null, 2)),
  });
  const zipBuffer = Uint8Array.from(zip).buffer;

  // Audit AFTER the zip is built (audit-after-success doctrine): if the
  // build throws, no export happened and no row should claim one did.
  await writeAdminAudit(c.env, session, "user.data.export", "user", id);

  const safeEmail = details.profile.email.replace(/[^a-z0-9]/gi, "_");
  const date = new Date().toISOString().slice(0, 10);
  return new Response(zipBuffer, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="userdata_${safeEmail}_${date}.zip"`,
    },
  });
});

export { usersRouter };
