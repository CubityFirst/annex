-- Final schema of the retired cubedocs-auth database (packages/auth/migrations
-- 0001-0036, the last before the identity split). Fixture for
-- scripts/lib/auth-import.test.ts; regenerate only if that history changes.
CREATE TABLE admin_audit_log (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT NOT NULL,
  actor_email TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX admin_audit_log_created_at ON admin_audit_log(created_at DESC);
CREATE INDEX admin_audit_log_actor ON admin_audit_log(actor_user_id, created_at DESC);
CREATE INDEX admin_audit_log_target ON admin_audit_log(target_type, target_id, created_at DESC);
CREATE INDEX idx_admin_audit_log_action_created
  ON admin_audit_log(action, created_at DESC, id DESC);
CREATE TABLE admin_handoffs (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  return_to   TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE INDEX idx_admin_handoffs_user_id ON admin_handoffs(user_id);
CREATE INDEX idx_admin_handoffs_expires_at ON admin_handoffs(expires_at);
CREATE TABLE backup_codes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX backup_codes_user_id ON backup_codes(user_id);
CREATE TABLE email_verification_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
, email TEXT);
CREATE INDEX idx_email_verification_tokens_user_id ON email_verification_tokens (user_id);
CREATE INDEX idx_email_verification_tokens_expires ON email_verification_tokens(expires_at);
CREATE TABLE oauth_clients (
  client_id          TEXT PRIMARY KEY,
  client_name        TEXT NOT NULL,
  -- SHA-256 (base64url) of the client secret. NULL => public client (PKCE only).
  client_secret_hash TEXT,
  -- JSON array of exact allowed redirect URIs.
  redirect_uris      TEXT NOT NULL,
  -- Space-separated scopes this client may request (subset of: openid profile email).
  allowed_scopes     TEXT NOT NULL DEFAULT 'openid profile email',
  -- 1 => first-party: auto-approve and skip the consent screen. 0 => show consent.
  trusted            INTEGER NOT NULL DEFAULT 0,
  -- 1 => disabled (refuses new authorizations) without deleting the row/history.
  disabled           INTEGER NOT NULL DEFAULT 0,
  created_at         INTEGER NOT NULL
);
CREATE TABLE oauth_codes (
  code           TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL,
  user_id        TEXT NOT NULL,
  redirect_uri   TEXT NOT NULL,
  scope          TEXT NOT NULL,
  -- PKCE S256 challenge: base64url(SHA-256(code_verifier)). Always required.
  code_challenge TEXT NOT NULL,
  -- OIDC nonce, echoed into the id_token when the client supplied one.
  nonce          TEXT,
  created_at     INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL,
  consumed_at    INTEGER,
  FOREIGN KEY (client_id) REFERENCES oauth_clients(client_id) ON DELETE CASCADE
);
CREATE INDEX idx_oauth_codes_expires_at ON oauth_codes(expires_at);
CREATE INDEX idx_oauth_codes_client_id ON oauth_codes(client_id);
CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  device_kind  TEXT,
  client_label TEXT,
  ip           TEXT,
  revoked_at   INTEGER
);
CREATE INDEX idx_sessions_user_id    ON sessions(user_id);
CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);
CREATE TABLE user_billing (
  user_id                   TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  stripe_customer_id        TEXT,
  stripe_subscription_id    TEXT,
  personal_period_end       INTEGER,
  personal_plan             TEXT,
  personal_plan_status      TEXT,
  personal_plan_started_at  INTEGER,
  personal_plan_cancel_at   INTEGER,
  granted_plan              TEXT,
  granted_plan_expires_at   INTEGER,
  granted_plan_started_at   INTEGER,
  granted_plan_reason       TEXT
);
CREATE INDEX idx_user_billing_subscription ON user_billing(stripe_subscription_id);
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
CREATE TABLE user_moderation_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  moderation_value INTEGER NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  actor_user_id TEXT,
  actor_email TEXT
);
CREATE INDEX user_moderation_events_user_id_created_at
  ON user_moderation_events(user_id, created_at DESC);
CREATE TABLE user_preferences (
  user_id                  TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  reading_font             TEXT,
  editing_font             TEXT,
  ui_font                  TEXT,
  personal_plan_style      TEXT,
  personal_presence_color  TEXT,
  personal_crit_sparkles   INTEGER,
  timezone                 TEXT,
  bio                      TEXT,
  badges                   INTEGER NOT NULL DEFAULT 0
, theme_mode TEXT, theme_custom_color TEXT, handle TEXT, handle_locked INTEGER NOT NULL DEFAULT 0);
CREATE UNIQUE INDEX idx_user_preferences_handle ON user_preferences(handle) WHERE handle IS NOT NULL;
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
, moderation INTEGER NOT NULL DEFAULT 0, totp_secret TEXT, force_password_change INTEGER NOT NULL DEFAULT 0, is_admin INTEGER NOT NULL DEFAULT 0, email_verified INTEGER NOT NULL DEFAULT 0, email_verified_at TEXT, change_token_id TEXT, totp_last_used_step INTEGER);
CREATE INDEX users_created_at ON users(created_at DESC);
CREATE INDEX idx_users_disabled_created
  ON users(created_at DESC, id DESC) WHERE moderation = -1;
CREATE INDEX idx_users_email_lower ON users(lower(email));
CREATE TABLE webauthn_challenges (
  id         TEXT PRIMARY KEY,   -- random UUID, used as lookup key
  user_id    TEXT NOT NULL,
  challenge  TEXT NOT NULL,      -- base64url random bytes
  type       TEXT NOT NULL,      -- 'registration' | 'authentication'
  created_at INTEGER NOT NULL    -- Unix ms, enforce 5-min TTL at verification
);
CREATE INDEX idx_webauthn_challenges_created_at
  ON webauthn_challenges(created_at);
CREATE TABLE webauthn_credentials (
  id         TEXT PRIMARY KEY,   -- base64url credential ID
  user_id    TEXT NOT NULL,
  name       TEXT NOT NULL DEFAULT 'Security Key',
  public_key TEXT NOT NULL,      -- base64url COSE public key
  counter    INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, transports TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX idx_webauthn_credentials_user ON webauthn_credentials(user_id);
CREATE TABLE webhook_events (
  event_id     TEXT PRIMARY KEY,
  type         TEXT NOT NULL,
  processed_at INTEGER NOT NULL
);
CREATE INDEX idx_webhook_events_processed ON webhook_events(processed_at);
