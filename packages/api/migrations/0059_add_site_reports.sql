-- Abuse reports filed from the published (public) site via the "Report Site"
-- button. Anyone can file one (no account required); reporter_user_id is set
-- only when the submitter presented a valid session token. Triage happens in
-- the admin panel: open -> acknowledged -> resolved/dismissed.
CREATE TABLE site_reports (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- Auth-DB users.id when the reporter was signed in; NULL for anonymous.
  -- No FK: users live in the auth DB, not this one.
  reporter_user_id  TEXT,
  -- Edge-observed client IP, kept for abuse triage (spotting one source
  -- mass-filing reports). NULL when the edge didn't supply one.
  reporter_ip       TEXT,
  -- The doc (page) the reporter was viewing when they clicked Report, so a
  -- reviewer can jump straight to the offending page on a large site. NULL
  -- for anonymous-of-page reports and after the doc is deleted.
  doc_id            TEXT REFERENCES docs(id) ON DELETE SET NULL,
  -- The reporter's free-text justification. Required at the API layer.
  note              TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open', 'acknowledged', 'resolved', 'dismissed')),
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  -- Set (with the acting admin's user id) on every status change.
  status_changed_at TEXT,
  status_changed_by TEXT
);

-- Per-site report history, newest first (admin "Reports" view on a site).
CREATE INDEX idx_site_reports_project ON site_reports(project_id, created_at DESC);
-- The global "current reports" queue filters on status.
CREATE INDEX idx_site_reports_status ON site_reports(status, created_at DESC);
