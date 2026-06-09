-- TOTP replay guard: the highest 30-second time step whose code has been
-- accepted for this user. Verification consumes the step atomically and only
-- accepts codes from a strictly later step (RFC 6238 §5.2: the verifier MUST
-- NOT accept the same or an earlier OTP), so an observed code cannot be
-- replayed within its ±1-step drift window. NULL = no code accepted yet;
-- cleared on TOTP disable so a fresh enrollment starts unguarded.
ALTER TABLE users ADD COLUMN totp_last_used_step INTEGER;
