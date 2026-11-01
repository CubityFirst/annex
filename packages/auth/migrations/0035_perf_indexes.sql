-- Additive performance indexes (no column changes, no drops). None of these
-- touch columns read by loadCurrentSession, so no auth -> api -> admin
-- redeploy ordering is needed.

-- Retention cleanup by age (DELETE ... WHERE processed_at / expires_at < ?).
CREATE INDEX IF NOT EXISTS idx_webhook_events_processed ON webhook_events(processed_at);
CREATE INDEX IF NOT EXISTS idx_email_verification_tokens_expires ON email_verification_tokens(expires_at);

-- Admin audit log filtered by action (keyset ORDER BY created_at DESC, id DESC),
-- and SELECT DISTINCT action for the filter dropdown (covering index scan).
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_action_created
  ON admin_audit_log(action, created_at DESC, id DESC);

-- Admin user list "disabled" filter (`u.moderation = -1`). Partial on exactly
-- that predicate: SQLite only uses a partial index when the query's WHERE
-- contains the index's WHERE term, so a `moderation <> 0` partial would not be
-- picked for `= -1` / `> ?`; and a full (moderation, ...) index makes the
-- "active" filter read and sort every active user via MULTI-INDEX OR.
CREATE INDEX IF NOT EXISTS idx_users_disabled_created
  ON users(created_at DESC, id DESC) WHERE moderation = -1;

-- Case-insensitive email lookup (`WHERE LOWER(email) = LOWER(?)`, routes/lookup.ts).
CREATE INDEX IF NOT EXISTS idx_users_email_lower ON users(lower(email));
