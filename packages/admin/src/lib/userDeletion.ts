import { adminAuditStatement, writeAdminAudit } from "../audit";
import type { AdminSession } from "../auth";
import { deleteProjectCascade } from "./projectDelete";
import type { Env } from "../index";

// Delayed account deletion (auth migration 0034_add_user_deletions.sql).
//
// The Users page never deletes an account outright: it SCHEDULES the delete
// (routes/users.ts POST /:id/deletion), which disables the account at once,
// and the admin worker's hourly cron (index.ts scheduled -> runDueUserDeletions)
// performs it once the grace window has passed. Any admin can cancel in the
// meantime. The window is the recovery path for a mis-click or a compromised
// admin session.
//
// Concurrency: the cron CLAIMS a schedule by (user_id, id) with a short lease
// before executing, and cancel refuses while a lease is live or once
// execution has started (started_at) - so a cancel can't race a running
// delete, and a cancel + reschedule can't be executed on the old consent.

export const USER_DELETION_GRACE_SECONDS = 7 * 24 * 60 * 60;

// Longer than a cron invocation can run (15 min wall clock), so a live lease
// always means "a run may still be working on this"; an expired one means the
// run died and the row is up for grabs again.
export const USER_DELETION_LEASE_SECONDS = 30 * 60;

// Accounts processed per cron run. Each can mean several site cascades (R2
// sweeps + D1 batches), so keep one invocation well inside the Worker's
// subrequest/time budget; anything left over runs on the next hourly tick.
const DUE_DELETIONS_PER_RUN = 5;

// Ids per IN (...) list - D1 caps a statement at 100 bound parameters.
const ID_CHUNK = 50;

// True when `confirmed` names exactly the ids in `actual` (order-insensitive,
// duplicates ignored). Scheduling requires consent to the precise current set
// - never a superset, subset, or someone else's ids.
export function sameIdSet(actual: string[], confirmed: string[]): boolean {
  const a = new Set(actual);
  const b = new Set(confirmed);
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

export function placeholders(n: number): string {
  return Array.from({ length: n }, () => "?").join(",");
}

function chunks<T>(items: T[], size = ID_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// Parses a stored JSON id array; anything malformed yields [] (which then
// fails the ownership check for an account that owns something - fail closed).
export function parseIdList(raw: string | null | undefined): string[] {
  try {
    const v: unknown = JSON.parse(raw ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

type Owned = Array<{ id: string; name: string }>;

async function loadOwned(env: Env, userId: string): Promise<{ sites: Owned; orgs: Owned }> {
  const [sites, orgs] = await Promise.all([
    env.DB.prepare("SELECT id, name FROM projects WHERE owner_id = ?").bind(userId).all<{ id: string; name: string }>(),
    env.DB.prepare("SELECT id, name FROM organizations WHERE owner_id = ?").bind(userId).all<{ id: string; name: string }>(),
  ]);
  return { sites: sites.results, orgs: orgs.results };
}

// SCHEDULING check: what the account owns must equal the confirmed sets
// exactly. error = null on a match.
export async function checkOwnership(
  env: Env,
  userId: string,
  email: string,
  confirm: { siteIds: string[]; orgIds: string[] },
): Promise<{ sites: Owned; orgs: Owned; error: string | null }> {
  const { sites, orgs } = await loadOwned(env, userId);
  let error: string | null = null;
  if (!sameIdSet(sites.map(s => s.id), confirm.siteIds)) {
    error = sites.length > 0
      ? `${email} owns ${sites.length} site(s) that weren't confirmed for deletion`
      : `${email} no longer owns the confirmed site(s) - review again`;
  } else if (!sameIdSet(orgs.map(o => o.id), confirm.orgIds)) {
    error = orgs.length > 0
      ? `${email} owns ${orgs.length} organization(s) that weren't confirmed for deletion`
      : `${email} no longer owns the confirmed organization(s) - review again`;
  }
  return { sites, orgs, error };
}

async function existingIds(env: Env, table: "projects" | "organizations", ids: string[]): Promise<string[]> {
  const found: string[] = [];
  for (const chunk of chunks(ids)) {
    const rows = await env.DB.prepare(`SELECT id FROM ${table} WHERE id IN (${placeholders(chunk.length)})`)
      .bind(...chunk).all<{ id: string }>();
    found.push(...rows.results.map(r => r.id));
  }
  return found;
}

// EXECUTION check. Stricter on what's owned, tolerant of progress:
//   - owning anything outside the confirmed sets fails (never delete what
//     the operator didn't see);
//   - a confirmed site/org that no longer exists at all counts as done - an
//     earlier attempt (or someone else) already deleted it. Ids are never
//     reused and neither sites nor orgs can change owner, so "gone" can only
//     mean deleted. One that still exists under another owner fails closed.
// Returns the owned sites/orgs still to delete.
export async function checkExecutionOwnership(
  env: Env,
  userId: string,
  email: string,
  confirm: { siteIds: string[]; orgIds: string[] },
): Promise<{ sites: Owned; orgs: Owned; alreadyGone: { sites: string[]; orgs: string[] }; error: string | null }> {
  const { sites, orgs } = await loadOwned(env, userId);
  const alreadyGone = { sites: [] as string[], orgs: [] as string[] };
  const fail = (error: string) => ({ sites, orgs, alreadyGone, error });

  const confirmedSites = new Set(confirm.siteIds);
  const confirmedOrgs = new Set(confirm.orgIds);
  const unconfirmedSites = sites.filter(s => !confirmedSites.has(s.id));
  if (unconfirmedSites.length > 0) {
    return fail(`${email} owns ${unconfirmedSites.length} site(s) that weren't confirmed for deletion`);
  }
  const unconfirmedOrgs = orgs.filter(o => !confirmedOrgs.has(o.id));
  if (unconfirmedOrgs.length > 0) {
    return fail(`${email} owns ${unconfirmedOrgs.length} organization(s) that weren't confirmed for deletion`);
  }

  const missingSites = confirm.siteIds.filter(id => !sites.some(s => s.id === id));
  if (missingSites.length > 0 && (await existingIds(env, "projects", missingSites)).length > 0) {
    return fail(`a confirmed site of ${email} now belongs to someone else`);
  }
  const missingOrgs = confirm.orgIds.filter(id => !orgs.some(o => o.id === id));
  if (missingOrgs.length > 0 && (await existingIds(env, "organizations", missingOrgs)).length > 0) {
    return fail(`a confirmed organization of ${email} now belongs to someone else`);
  }
  alreadyGone.sites = missingSites;
  alreadyGone.orgs = missingOrgs;
  return { sites, orgs, alreadyGone, error: null };
}

// Bound for raw Stripe error bodies before they land in a log line.
function truncate(body: string, max = 300): string {
  return body.length > max ? `${body.slice(0, max)}… (truncated)` : body;
}

export type ExecuteResult =
  | { ok: true; sites_deleted: number; orgs_deleted: number }
  | { ok: false; error: string };

export interface DeletionSchedule {
  userId: string;
  // The schedule's id: execution is tied to this exact schedule.
  scheduleId: string;
  confirm: { siteIds: string[]; orgIds: string[] };
}

// Permanently deletes one account for a schedule the caller has CLAIMED.
// Order is chosen so a failure part-way leaves the user row (and its schedule)
// in place and the next run can carry on where this one stopped:
//   ownership check -> mark started (point of no return) -> Stripe customer
//   (cancels subs; "already deleted" is fine) -> re-freeze + re-check ->
//   owned sites -> owned orgs (attached sites detach, not deleted) ->
//   memberships + API keys -> avatar -> users row + its audit row in ONE
//   auth batch (the delete cascades sessions, passkeys, TOTP, billing,
//   preferences, moderation history and the schedule).
//
// `actor` is the admin who scheduled it; audit rows carry `auditExtra` so the
// trail shows it ran from the scheduler.
export async function executeUserDeletion(
  env: Env,
  actor: AdminSession,
  schedule: DeletionSchedule,
  auditExtra: Record<string, unknown> = {},
): Promise<ExecuteResult> {
  const { userId, scheduleId, confirm } = schedule;
  const user = await env.AUTH_DB.prepare(
    `SELECT u.id, u.email, u.is_admin, b.stripe_customer_id
     FROM users u LEFT JOIN user_billing b ON b.user_id = u.id
     WHERE u.id = ?`,
  ).bind(userId).first<{ id: string; email: string; is_admin: number; stripe_customer_id: string | null }>();
  if (!user) return { ok: false, error: "User not found" };
  // Re-checked here, not just at scheduling: the account may have been made
  // an admin during the grace window.
  if (user.is_admin) return { ok: false, error: "Admin accounts can't be deleted from the admin panel" };

  const before = await checkExecutionOwnership(env, userId, user.email, confirm);
  if (before.error) return { ok: false, error: before.error };
  // Locally-detectable blockers go before the point of no return, so they
  // leave the schedule cancellable.
  let stripeAlreadyDeleted = false;
  if (user.stripe_customer_id) {
    if (!env.STRIPE_SECRET_KEY) {
      return { ok: false, error: "STRIPE_SECRET_KEY is unset on the admin worker; can't remove this user's Stripe customer" };
    }
    // Read-only preflight: confirm this worker's key can see the customer. A
    // key for a different Stripe account or test/live mode 404s here, while
    // the schedule is still cancellable, instead of after the point of no
    // return. A customer an earlier attempt already deleted reads back as
    // 200 { deleted: true }.
    const pre = await fetch(`https://api.stripe.com/v1/customers/${user.stripe_customer_id}`, {
      headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
    });
    if (!pre.ok) {
      return {
        ok: false,
        error: pre.status === 404
          ? `Stripe can't find customer ${user.stripe_customer_id} with the admin worker's key (wrong account or test/live mode?)`
          : `Stripe returned ${pre.status} looking up the customer`,
      };
    }
    stripeAlreadyDeleted = (await pre.json<{ deleted?: boolean }>().catch(() => ({} as { deleted?: boolean }))).deleted === true;
  }

  // Point of no return: from here the deletion can only be finished, not
  // cancelled. Tied to this schedule id, so it no-ops if the schedule was
  // replaced (the claim normally prevents that already).
  const started = await env.AUTH_DB.prepare(
    "UPDATE user_deletions SET started_at = COALESCE(started_at, ?) WHERE user_id = ? AND id = ?",
  ).bind(Math.floor(Date.now() / 1000), userId, scheduleId).run();
  if ((started.meta?.changes ?? 0) !== 1) {
    return { ok: false, error: "The schedule was cancelled or replaced; nothing was deleted" };
  }

  // Stripe first, and fatal on failure: a deleted account with a live
  // customer would keep being billed with no way to reach it. Deleting the
  // customer cancels every subscription on it.
  let stripeCustomerDeleted = false;
  if (user.stripe_customer_id && !stripeAlreadyDeleted) {
    const res = await fetch(`https://api.stripe.com/v1/customers/${user.stripe_customer_id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
    });
    if (res.status === 404) {
      // The preflight just saw it, so this is a narrow race - still, only
      // "already deleted" is safe to continue past; anything else could
      // orphan a customer that keeps billing.
      const check = await fetch(`https://api.stripe.com/v1/customers/${user.stripe_customer_id}`, {
        headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
      });
      const body = check.ok ? await check.json<{ deleted?: boolean }>().catch(() => ({} as { deleted?: boolean })) : {};
      if (!body.deleted) {
        return {
          ok: false,
          error: `Stripe can't find customer ${user.stripe_customer_id} with the admin worker's key (wrong account or test/live mode?)`,
        };
      }
    } else if (!res.ok) {
      const errBody = await res.text().catch(() => "(unreadable)");
      console.error("admin user delete: Stripe customer delete failed:", res.status, truncate(errBody));
      return { ok: false, error: `Stripe returned ${res.status} deleting the customer` };
    }
    stripeCustomerDeleted = res.ok;
  }

  // Re-freeze before the deletes: a disabled account is refused on every
  // authenticated request, so it can't create a site/org mid-delete that
  // would be left owned by a vanished user. (Scheduling disabled it and
  // PATCH refuses changes while scheduled; this is belt and braces.)
  await env.AUTH_DB.prepare("UPDATE users SET moderation = -1 WHERE id = ?").bind(userId).run();
  const after = await checkExecutionOwnership(env, userId, user.email, confirm);
  if (after.error) {
    return { ok: false, error: `${after.error} (changed during deletion; the account stays disabled)` };
  }

  const deletedSites: Array<{ id: string; name: string; docs: number; files: number }> = [];
  for (const site of after.sites) {
    const counts = await deleteProjectCascade(env, site.id);
    deletedSites.push({ id: site.id, name: site.name, ...counts });
    // Per-site row too, so the site's own audit trail shows how it went.
    await writeAdminAudit(env, actor, "project.delete", "project", site.id, {
      ...counts, via: "user.delete", user_id: userId, ...auditExtra,
    });
  }

  // Orgs in bounded chunks (D1's 100-parameter cap), each still pinned to
  // this owner. Attached sites survive: projects.organization_id is
  // ON DELETE SET NULL.
  for (const chunk of chunks(after.orgs.map(o => o.id))) {
    await env.DB.prepare(`DELETE FROM organizations WHERE owner_id = ? AND id IN (${placeholders(chunk.length)})`)
      .bind(userId, ...chunk).run();
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM project_members WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM organization_members WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM api_keys WHERE user_id = ?").bind(userId),
  ]);

  await env.ASSETS.delete([`avatars/${userId}-dark`, `avatars/${userId}-light`, `avatars/${userId}`]);

  // The account row and its audit record commit together: if either fails,
  // neither lands, the schedule survives (it cascades with the user), and
  // the next run retries.
  await env.AUTH_DB.batch([
    adminAuditStatement(env, actor, "user.delete", "user", userId, {
      email: user.email,
      sites: deletedSites,
      orgs: after.orgs,
      already_deleted: after.alreadyGone,
      stripe_customer_deleted: stripeCustomerDeleted,
      ...auditExtra,
    }),
    env.AUTH_DB.prepare("DELETE FROM users WHERE id = ?").bind(userId),
  ]);

  return { ok: true, sites_deleted: deletedSites.length, orgs_deleted: after.orgs.length };
}

interface UserDeletionRow {
  user_id: string;
  id: string;
  requested_by: string;
  requested_by_email: string;
  requested_at: string;
  confirm_site_ids: string;
  confirm_org_ids: string;
}

// Cron entry point: performs scheduled deletions whose grace window has
// passed, a bounded number per run. Never-attempted rows go first, then the
// least recently attempted - so a few permanently failing schedules rotate
// to the back instead of starving the queue. Each row is claimed (lease)
// before executing; a failure is recorded on the row (last_error, shown on
// the Users page), the lease released, and the row retried on a later run.
export async function runDueUserDeletions(
  env: Env,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<{ deleted: number; failed: number }> {
  // A lease that expired without being released means the run holding it was
  // killed (time/CPU limit, deploy) before recording an outcome. Say so on
  // the row, so the Users page doesn't show a stale or empty error.
  await env.AUTH_DB.prepare(
    `UPDATE user_deletions
     SET lease_until = NULL, last_error = 'The previous attempt was cut off before finishing; it will be retried'
     WHERE lease_until IS NOT NULL AND lease_until < ?`,
  ).bind(nowSeconds).run();

  const due = await env.AUTH_DB.prepare(
    `SELECT user_id, id, requested_by, requested_by_email, requested_at, confirm_site_ids, confirm_org_ids
     FROM user_deletions
     WHERE execute_after <= ? AND (lease_until IS NULL OR lease_until < ?)
     ORDER BY (last_attempt_at IS NOT NULL), last_attempt_at ASC, execute_after ASC
     LIMIT ?`,
  ).bind(nowSeconds, nowSeconds, DUE_DELETIONS_PER_RUN).all<UserDeletionRow>();

  let deleted = 0;
  let failed = 0;
  for (const row of due.results) {
    // Claim THIS schedule. Fails if it was cancelled/replaced since the
    // SELECT, isn't due, or another run holds a live lease. The attempt is
    // stamped here, not after the outcome: a run that gets killed mid-way
    // must still rotate this row behind the others, or one oversized
    // deletion would starve the queue.
    const claim = await env.AUTH_DB.prepare(
      `UPDATE user_deletions SET lease_until = ?, last_attempt_at = datetime('now')
       WHERE user_id = ? AND id = ? AND execute_after <= ? AND (lease_until IS NULL OR lease_until < ?)`,
    ).bind(nowSeconds + USER_DELETION_LEASE_SECONDS, row.user_id, row.id, nowSeconds, nowSeconds).run();
    if ((claim.meta?.changes ?? 0) !== 1) continue;

    // Audit rows are attributed to the admin who scheduled the deletion.
    const actor: AdminSession = { userId: row.requested_by, email: row.requested_by_email, expiresAt: 0, isAdmin: true };
    let result: ExecuteResult;
    try {
      result = await executeUserDeletion(
        env,
        actor,
        {
          userId: row.user_id,
          scheduleId: row.id,
          confirm: { siteIds: parseIdList(row.confirm_site_ids), orgIds: parseIdList(row.confirm_org_ids) },
        },
        { executed_by: "scheduler", scheduled_at: row.requested_at },
      );
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (result.ok) {
      deleted++;
    } else {
      failed++;
      console.error(`[user-deletion] ${row.user_id} failed:`, result.error);
      await env.AUTH_DB.prepare(
        "UPDATE user_deletions SET last_error = ?, last_attempt_at = datetime('now'), lease_until = NULL WHERE user_id = ? AND id = ?",
      ).bind(result.error.slice(0, 500), row.user_id, row.id).run();
    }
  }
  return { deleted, failed };
}
