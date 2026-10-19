-- Delayed account deletion, scheduled from the admin panel's Users page.
--
-- Scheduling disables the account immediately (users.moderation = -1) and
-- records a row here; the admin worker's hourly cron performs the permanent
-- delete once execute_after has passed. Any admin can cancel before then,
-- which restores previous_moderation. The grace window is what makes a
-- mistaken (or malicious) delete recoverable.
--
-- id identifies THIS schedule: the cron claims a row by (user_id, id), so a
-- cancel + reschedule can never be executed on the old schedule's consent.
-- lease_until is the cron's short claim (cancel is refused while it is
-- live); started_at is set once execution passes its first irreversible step
-- (Stripe), after which the deletion can only be finished, not cancelled.
--
-- confirm_site_ids / confirm_org_ids are the JSON arrays of sites/orgs the
-- operator explicitly agreed to delete along with the account. The cron
-- refuses to run (recording last_error) if the account owns anything outside
-- them.
--
-- Written only by the admin worker (AUTH_DB binding). The row disappears with
-- the user (ON DELETE CASCADE); admin_audit_log keeps the history.
CREATE TABLE user_deletions (
  user_id             TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  id                  TEXT NOT NULL,
  requested_by        TEXT NOT NULL,
  requested_by_email  TEXT NOT NULL,
  requested_at        TEXT NOT NULL DEFAULT (datetime('now')),
  execute_after       INTEGER NOT NULL,
  confirm_site_ids    TEXT NOT NULL DEFAULT '[]',
  confirm_org_ids     TEXT NOT NULL DEFAULT '[]',
  previous_moderation INTEGER NOT NULL DEFAULT 0,
  lease_until         INTEGER,
  started_at          INTEGER,
  last_error          TEXT,
  last_attempt_at     TEXT
);

CREATE INDEX idx_user_deletions_execute_after ON user_deletions(execute_after);
