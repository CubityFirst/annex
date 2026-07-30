-- WebAuthn start is public and lazily removes abandoned ceremonies by age.
-- Keep that cleanup bounded as the challenge table grows.
CREATE INDEX IF NOT EXISTS idx_webauthn_challenges_created_at
  ON webauthn_challenges(created_at);