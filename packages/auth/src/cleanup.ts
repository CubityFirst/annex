import { deleteExpiredWebauthnChallenges } from "./webauthn";
import { SESSION_TTL_MS } from "./sessions";
import type { Env } from "./index";

// Dead rows are kept this long before the weekly sweep removes them - an
// audit cushion for sessions, a replay window far beyond Stripe's ~3-day
// webhook retry schedule, and long enough that a stale email-change link
// still gets verify-email's specific "change_link_expired" answer (that
// lookup needs the expired row to still exist).
export const SWEEP_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

// Weekly sweep (the `scheduled` cron). Request paths only do per-user
// opportunistic GC, so inactive accounts and global tables are cleaned here.
// Each DELETE is a range predicate on one column so it can be index-backed.
export async function sweepExpiredRows(env: Env, now: number = Date.now()): Promise<void> {
  const cutoff = now - SWEEP_RETENTION_MS;
  await Promise.all([
    // Expired before the cutoff, or revoked before it. `expires_at` is written
    // once at INSERT (createSession: now + at most SESSION_TTL_MS) and never
    // extended - the only UPDATEs touch `revoked_at` / `last_used_at` - and
    // `revoked_at` >= created_at, so a row revoked before the cutoff has
    // `expires_at <= cutoff + SESSION_TTL_MS`. The leading range bound is
    // therefore redundant for matching but lets idx_sessions_expires_at
    // drive the delete instead of a full SCAN.
    env.DB.prepare(
      "DELETE FROM sessions WHERE expires_at <= ? AND (expires_at <= ? OR (revoked_at IS NOT NULL AND revoked_at < ?))",
    ).bind(cutoff + SESSION_TTL_MS, cutoff, cutoff).run(),
    // Stripe idempotency markers (`processed_at` = Date.now() ms).
    env.DB.prepare("DELETE FROM webhook_events WHERE processed_at < ?").bind(cutoff).run(),
    // Every reader of a token requires `expires_at > now`, so long-expired
    // rows are inert (consumed rows expire within VERIFICATION_TTL_MS too).
    env.DB.prepare("DELETE FROM email_verification_tokens WHERE expires_at <= ?").bind(cutoff).run(),
    deleteExpiredWebauthnChallenges(env, now),
  ]);
}
