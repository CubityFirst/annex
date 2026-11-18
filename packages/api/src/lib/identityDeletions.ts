// Deletion sync: accounts deleted on the identity service (auth.cubityfir.st)
// stop existing there; this removes what Annex holds about them.
//
// Hourly cron (src/index.ts scheduled): IdentityService.listDeletedUsers is
// polled from the newest deleted_at already recorded in identity_deletions
// (api migration 0065), new deletions are recorded, then pending ones are
// processed a few at a time:
//   - their Stripe customer is deleted (cancels any Ink subscription), so a
//     deleted account is never billed again;
//   - memberships, API keys, doc shares, favourites and avatars go, and the
//     users mirror row is deleted (cascading sessions, billing, preferences,
//     moderation history and any admin-scheduled deletion);
//   - sites and organizations they OWNED are kept, with their owner rows
//     (name/email snapshots scrubbed to "Deleted account"), and
//     recorded on the identity_deletions row for an operator to delete or
//     reassign from the admin panel. Owned sites usually have other members,
//     and the identity service gave the person no warning about them.
// A failure (e.g. Stripe) leaves the row pending with last_error and it is
// retried on the next run.

import { deleteAllAvatarVariants } from "../avatar";
import { getStripe } from "../account/stripe-client";
import type { IdentityService } from "../account/identity";

export interface DeletionSyncEnv {
  DB: D1Database;
  ASSETS: R2Bucket;
  IDENTITY?: IdentityService;
  STRIPE_SECRET_KEY?: string;
}

// Must match the hourly trigger in cloudflare.config.ts. Lives here, not in
// src/index.ts: every named export of the worker's main module is loaded as
// an entrypoint, and a non-handler export stops the worker from starting.
export const DELETION_SYNC_CRON = "23 * * * *";

const PAGE_SIZE = 100;
// IdentityService.listDeletedUsers' maximum page size.
const MAX_PAGE_SIZE = 500;
const MAX_PAGES_PER_RUN = 10;
const PROCESS_PER_RUN = 20;

// Pulls new deletions from the identity service into identity_deletions.
// Every request re-reads the newest millisecond seen so far (`deleted_at >
// cursor - 1`), so deletions sharing it that a full page cut off aren't
// skipped; INSERT OR IGNORE dedupes the overlap.
export async function recordIdentityDeletions(env: DeletionSyncEnv): Promise<number> {
  if (!env.IDENTITY) return 0;
  const row = await env.DB.prepare("SELECT MAX(deleted_at) AS cursor FROM identity_deletions")
    .first<{ cursor: number | null }>();
  let since = row?.cursor != null ? row.cursor - 1 : 0;
  let recorded = 0;
  let limit = PAGE_SIZE;
  for (let page = 0; page < MAX_PAGES_PER_RUN; page++) {
    const deleted = await env.IDENTITY.listDeletedUsers(since, limit);
    if (deleted.length === 0) break;
    const results = await env.DB.batch(deleted.map(d =>
      env.DB.prepare("INSERT OR IGNORE INTO identity_deletions (user_id, deleted_at, deleted_by) VALUES (?, ?, ?)")
        .bind(d.userId, d.deletedAt, d.deletedBy ?? "unknown"),
    ));
    recorded += results.reduce((n, r) => n + (r.meta?.changes ?? 0), 0);
    if (deleted.length < limit) break;
    const next = deleted[deleted.length - 1].deletedAt - 1;
    if (next <= since) {
      // A whole page within one millisecond can't advance the cursor: read
      // it again at the RPC's maximum page size.
      if (limit < MAX_PAGE_SIZE) {
        limit = MAX_PAGE_SIZE;
        continue;
      }
      console.error(`[deletion-sync] more than ${MAX_PAGE_SIZE} deletions share deleted_at ${since + 1}; reconcile by hand`);
      break;
    }
    since = next;
    limit = PAGE_SIZE;
  }
  return recorded;
}

// Removes one deleted account's Annex data. Throws on a failure that must be
// retried (the caller records it).
export async function processIdentityDeletion(env: DeletionSyncEnv, userId: string, nowMs: number = Date.now()): Promise<void> {
  const [sites, orgs, billing] = await env.DB.batch([
    env.DB.prepare("SELECT id FROM projects WHERE owner_id = ? ORDER BY created_at").bind(userId),
    env.DB.prepare("SELECT id FROM organizations WHERE owner_id = ? ORDER BY created_at").bind(userId),
    env.DB.prepare("SELECT stripe_customer_id FROM user_billing WHERE user_id = ?").bind(userId),
  ]);
  const ownedSiteIds = (sites.results as { id: string }[]).map(r => r.id);
  const ownedOrgIds = (orgs.results as { id: string }[]).map(r => r.id);
  const customerId = (billing.results as { stripe_customer_id: string | null }[])[0]?.stripe_customer_id ?? null;

  // Stripe first and fatal: a gone account must not keep being billed.
  // Deleting the customer cancels its subscriptions; one already deleted is
  // fine.
  if (customerId) {
    if (!env.STRIPE_SECRET_KEY) throw new Error("STRIPE_SECRET_KEY is unset; can't remove this account's Stripe customer");
    try {
      await getStripe(env.STRIPE_SECRET_KEY).customers.del(customerId);
    } catch (err) {
      const code = (err as { code?: string; statusCode?: number }) ?? {};
      if (code.code !== "resource_missing" && code.statusCode !== 404) throw err;
    }
  }

  // Memberships on sites/orgs they owned stay (the owner row anchors the
  // site for the operator); everything else of theirs goes. One batch, so a
  // retry re-applies it cleanly.
  await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM project_members WHERE user_id = ? AND project_id NOT IN (SELECT id FROM projects WHERE owner_id = ?)",
    ).bind(userId, userId),
    env.DB.prepare(
      "DELETE FROM organization_members WHERE user_id = ? AND organization_id NOT IN (SELECT id FROM organizations WHERE owner_id = ?)",
    ).bind(userId, userId),
    env.DB.prepare("DELETE FROM api_keys WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM doc_shares WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM user_favourite_projects WHERE user_id = ?").bind(userId),
    // The kept owner rows mustn't go on showing the person's name and email.
    env.DB.prepare("UPDATE project_members SET name = 'Deleted account', email = '' WHERE user_id = ?").bind(userId),
    env.DB.prepare("UPDATE organization_members SET name = 'Deleted account', email = '' WHERE user_id = ?").bind(userId),
  ]);
  await deleteAllAvatarVariants(env.ASSETS, userId);

  await env.DB.batch([
    // Cascades sessions, user_billing, user_preferences, user_deletions and
    // user_moderation_events.
    env.DB.prepare("DELETE FROM users WHERE id = ?").bind(userId),
    env.DB.prepare(
      `UPDATE identity_deletions SET processed_at = ?, owned_site_ids = ?, owned_org_ids = ?, last_error = NULL
       WHERE user_id = ?`,
    ).bind(nowMs, JSON.stringify(ownedSiteIds), JSON.stringify(ownedOrgIds), userId),
  ]);
}

export async function syncIdentityDeletions(env: DeletionSyncEnv, nowMs: number = Date.now()): Promise<{ recorded: number; processed: number; failed: number }> {
  const recorded = await recordIdentityDeletions(env);
  const pending = await env.DB.prepare(
    "SELECT user_id FROM identity_deletions WHERE processed_at IS NULL ORDER BY deleted_at LIMIT ?",
  ).bind(PROCESS_PER_RUN).all<{ user_id: string }>();
  let processed = 0;
  let failed = 0;
  for (const { user_id } of pending.results) {
    try {
      await processIdentityDeletion(env, user_id, nowMs);
      processed++;
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[deletion-sync] ${user_id} failed:`, message);
      await env.DB.prepare("UPDATE identity_deletions SET last_error = ? WHERE user_id = ?")
        .bind(message.slice(0, 500), user_id).run();
    }
  }
  return { recorded, processed, failed };
}
