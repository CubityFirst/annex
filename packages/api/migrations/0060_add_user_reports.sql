-- Abuse reports against a user, filed from the user profile card. Unlike
-- site_reports (public, optionally anonymous), filing a user report requires
-- a signed-in session, so reporter_user_id is always set. User ids reference
-- the auth DB's users table - cross-DB, so no FK on either user column; a
-- deleted account leaves the id in place and the admin UI renders it bare.
-- Same triage lifecycle as site_reports: open -> acknowledged -> resolved/dismissed.
CREATE TABLE user_reports (
  id                TEXT PRIMARY KEY,
  reported_user_id  TEXT NOT NULL,
  reporter_user_id  TEXT NOT NULL,
  -- Edge-observed client IP, kept for abuse triage.
  reporter_ip       TEXT,
  -- The reporter's free-text justification. Required at the API layer.
  note              TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open', 'acknowledged', 'resolved', 'dismissed')),
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  -- Set (with the acting admin's user id) on every status change.
  status_changed_at TEXT,
  status_changed_by TEXT
);

-- Per-user report history, newest first.
CREATE INDEX idx_user_reports_reported ON user_reports(reported_user_id, created_at DESC);
-- The global "current reports" queue filters on status.
CREATE INDEX idx_user_reports_status ON user_reports(status, created_at DESC);
