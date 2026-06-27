-- Scoped API keys for the public /v1 API.
--
-- A key authenticates as its owning user but is hard-bound to ONE site
-- (project_id) and a capability ceiling (scope read|readwrite + the can_invite
-- flag). The key is never more powerful than its owner: every /v1 request
-- independently re-checks the owner's live project_members role, so revoking a
-- member instantly neuters their keys, and a read-only key can never write even
-- if the owner is an admin/owner of the site.
--
-- Lives in the API DB (cubedocs-main), NOT the auth DB, because:
--   * project_id needs a real FK + ON DELETE CASCADE to projects (deleting a
--     site wipes its keys automatically);
--   * key management is a pure API-worker write (the auth DB is read-only from
--     the API worker by convention), avoiding a new auth-worker write path and
--     the cross-package redeploy coupling that auth-table schema changes carry.
-- user_id is stored as a bare string with no cross-DB FK, exactly like
-- project_members.user_id already is.
--
-- The secret itself is NEVER stored. We keep only key_hash = SHA-256(secret)
-- (hex). Keys are high-entropy random tokens, so a single fast SHA-256 is the
-- correct primitive (the GitHub-PAT pattern) - a slow KDF like password.ts's
-- PBKDF2 would add latency to every authenticated API call for no security
-- gain. Lookup is by exact hash match against a UNIQUE index, so the raw
-- secret never participates in a timing-sensitive comparison.
CREATE TABLE api_keys (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  key_hash     TEXT NOT NULL,
  key_prefix   TEXT NOT NULL,
  scope        TEXT NOT NULL CHECK(scope IN ('read', 'readwrite')),
  can_invite   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  expires_at   TEXT,
  revoked_at   TEXT
);

-- Every /v1 request looks a key up by its hash; UNIQUE both enforces no
-- collisions and provides the lookup index.
CREATE UNIQUE INDEX idx_api_keys_hash ON api_keys(key_hash);
-- "list my keys for this site" (settings UI) and "all keys for this site".
CREATE INDEX idx_api_keys_project_user ON api_keys(project_id, user_id);
CREATE INDEX idx_api_keys_user ON api_keys(user_id);
