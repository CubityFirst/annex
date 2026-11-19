-- Annex becomes an OpenID Connect client of the identity service at
-- auth.cubityfir.st (worker `cubityfirst-auth`). Identity (passwords, 2FA,
-- passkeys, email changes, account moderation) lives there now; everything
-- Annex-specific moves into this database, keyed on the same user ids (the
-- OIDC `sub` is the existing Annex user id).
--
-- One-time data copy from cubedocs-auth: scripts/import-auth-data.mjs.

-- Local mirror of the identity account. Refreshed on every sign-in and from
-- IdentityService.getUser (see src/session.ts), so it can be a little stale.
-- email is deliberately NOT unique: the identity service owns uniqueness, and
-- a stale mirror (A changed address, B then took A's old one) must not make
-- B's first sign-in fail.
CREATE TABLE users (
  id              TEXT PRIMARY KEY,
  email           TEXT NOT NULL,
  name            TEXT NOT NULL,
  email_verified  INTEGER NOT NULL DEFAULT 0,
  is_admin        INTEGER NOT NULL DEFAULT 0,
  -- Last known standing on the identity service: 'active' | 'disabled' |
  -- 'suspended' (suspended_until = unix seconds).
  status          TEXT NOT NULL DEFAULT 'active',
  suspended_until INTEGER,
  -- Account creation time as reported by the identity service.
  created_at      TEXT NOT NULL,
  first_seen_at   INTEGER NOT NULL,
  last_login_at   INTEGER,
  synced_at       INTEGER NOT NULL
);

CREATE INDEX users_created_at ON users(created_at DESC, id DESC);
CREATE INDEX idx_users_email_lower ON users(lower(email));
CREATE INDEX idx_users_not_active ON users(created_at DESC, id DESC) WHERE status <> 'active';

-- Annex's own sessions, created from a verified id_token. The session JWT
-- carries the row id as `sid`. kind separates the docs app from the admin
-- panel so a token minted for one is refused by the other.
--
-- id_token is kept for RP-initiated logout (id_token_hint). handoff_hash is
-- the SHA-256 of the single-use code /auth/callback hands the SPA; the SPA
-- exchanges it for the session JWT once, within handoff_expires_at.
CREATE TABLE sessions (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind               TEXT NOT NULL DEFAULT 'app',
  created_at         INTEGER NOT NULL,
  expires_at         INTEGER NOT NULL,
  last_used_at       INTEGER NOT NULL,
  device_kind        TEXT,
  client_label       TEXT,
  ip                 TEXT,
  revoked_at         INTEGER,
  id_token           TEXT,
  handoff_hash       TEXT,
  handoff_expires_at INTEGER
);

CREATE INDEX idx_sessions_user_id ON sessions(user_id);
CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);
CREATE UNIQUE INDEX idx_sessions_handoff ON sessions(handoff_hash) WHERE handoff_hash IS NOT NULL;

-- Stripe + Ink plan state (was cubedocs-auth user_billing, same columns).
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

-- Fonts, theme, Ink cosmetics, timezone, bio, badges and the /@<handle>
-- profile link (was cubedocs-auth user_preferences, same columns).
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
  badges                   INTEGER NOT NULL DEFAULT 0,
  theme_mode               TEXT,
  theme_custom_color       TEXT,
  handle                   TEXT,
  handle_locked            INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX idx_user_preferences_handle ON user_preferences(handle) WHERE handle IS NOT NULL;

-- Stripe webhook idempotency markers.
CREATE TABLE webhook_events (
  event_id     TEXT PRIMARY KEY,
  type         TEXT NOT NULL,
  processed_at INTEGER NOT NULL
);

CREATE INDEX idx_webhook_events_processed ON webhook_events(processed_at);

-- Admin-scheduled deletion of a user's Annex data (admin lib/userDeletion.ts).
-- A row blocks the user from Annex for as long as it exists: scheduling
-- blocks at once, cancel deletes the row, and completion keeps it
-- (completed_at set) so the user stays locked out until the identity account
-- itself is deleted at auth.cubityfir.st - at which point the deletion sync
-- removes the users row and this one cascades with it.
--
-- id identifies THIS schedule: the cron claims a row by (user_id, id), so a
-- cancel + reschedule can never be executed on the old schedule's consent.
CREATE TABLE user_deletions (
  user_id             TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  id                  TEXT NOT NULL,
  requested_by        TEXT NOT NULL,
  requested_by_email  TEXT NOT NULL,
  requested_at        TEXT NOT NULL DEFAULT (datetime('now')),
  execute_after       INTEGER NOT NULL,
  confirm_site_ids    TEXT NOT NULL DEFAULT '[]',
  confirm_org_ids     TEXT NOT NULL DEFAULT '[]',
  lease_until         INTEGER,
  started_at          INTEGER,
  completed_at        INTEGER,
  last_error          TEXT,
  last_attempt_at     TEXT
);

CREATE INDEX idx_user_deletions_execute_after ON user_deletions(execute_after);

-- History of moderation actions taken from the Annex admin panel before the
-- split. Moderation itself happens on auth.cubityfir.st now; kept read-only.
CREATE TABLE user_moderation_events (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action           TEXT NOT NULL,
  moderation_value INTEGER NOT NULL,
  reason           TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  actor_user_id    TEXT,
  actor_email      TEXT
);

CREATE INDEX user_moderation_events_user_id_created_at
  ON user_moderation_events(user_id, created_at DESC);

-- Actor-attributed log of admin-panel actions. No FKs on purpose: rows must
-- outlive the actor and the target.
CREATE TABLE admin_audit_log (
  id            TEXT PRIMARY KEY,
  actor_user_id TEXT NOT NULL,
  actor_email   TEXT NOT NULL,
  action        TEXT NOT NULL,
  target_type   TEXT NOT NULL,
  target_id     TEXT,
  detail        TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX admin_audit_log_created_at ON admin_audit_log(created_at DESC);
CREATE INDEX admin_audit_log_actor ON admin_audit_log(actor_user_id, created_at DESC);
CREATE INDEX admin_audit_log_target ON admin_audit_log(target_type, target_id, created_at DESC);
CREATE INDEX idx_admin_audit_log_action_created ON admin_audit_log(action, created_at DESC, id DESC);

-- Accounts deleted on the identity service, fed by the hourly deletion sync
-- (IdentityService.listDeletedUsers; src/lib/identityDeletions.ts). MAX(deleted_at)
-- is the sync cursor. Owned sites/orgs are NOT deleted: their ids are recorded
-- here and the admin panel lists them for an operator to resolve.
CREATE TABLE identity_deletions (
  user_id        TEXT PRIMARY KEY,
  deleted_at     INTEGER NOT NULL,
  deleted_by     TEXT NOT NULL,
  processed_at   INTEGER,
  owned_site_ids TEXT NOT NULL DEFAULT '[]',
  owned_org_ids  TEXT NOT NULL DEFAULT '[]',
  last_error     TEXT
);

CREATE INDEX idx_identity_deletions_deleted_at ON identity_deletions(deleted_at);
CREATE INDEX idx_identity_deletions_pending ON identity_deletions(deleted_at) WHERE processed_at IS NULL;
