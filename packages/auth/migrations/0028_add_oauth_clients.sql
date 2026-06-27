-- "Sign in with Annex" - OIDC identity provider (authorization-code + PKCE).
-- Generalizes the single-purpose admin_handoffs flow (0009) into a real
-- OAuth2 / OpenID Connect provider so other first-party services can
-- authenticate users against their Annex account.
--
-- oauth_clients - registry of services allowed to use the flow. One row per
--   connected app. `redirect_uris` is a JSON array of EXACT allowed callback
--   URLs (no wildcards - the token/authorize paths only ever accept an exact
--   string match against this list). `client_secret_hash` is NULL for public
--   clients (SPA / native) that authenticate with PKCE alone.
-- oauth_codes - short-lived, single-use authorization codes. Generalizes
--   admin_handoffs: adds the client binding, the PKCE S256 challenge, the
--   granted scope, and the OIDC nonce. Consumed atomically at the token
--   endpoint (UPDATE … WHERE consumed_at IS NULL) so a code can't be replayed.

CREATE TABLE IF NOT EXISTS oauth_clients (
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

CREATE TABLE IF NOT EXISTS oauth_codes (
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

CREATE INDEX IF NOT EXISTS idx_oauth_codes_expires_at ON oauth_codes(expires_at);
CREATE INDEX IF NOT EXISTS idx_oauth_codes_client_id ON oauth_codes(client_id);
