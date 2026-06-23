-- WebAuthn `transports` hint, persisted at registration and echoed back in
-- allowCredentials at authentication. Without it, Chrome on Android defaults to
-- the external-authenticator UI (USB / NFC / "use another device") instead of
-- offering a synced passkey from a password manager. JSON array of
-- AuthenticatorTransportFuture values, e.g. '["internal","hybrid"]'.
ALTER TABLE webauthn_credentials ADD COLUMN transports TEXT;

-- Backfill existing credentials with the platform/synced-passkey hint so they
-- benefit immediately without forcing a re-registration. internal+hybrid is the
-- combination a password-manager / platform passkey reports; it widens (never
-- narrows) the authenticators the browser is willing to offer.
UPDATE webauthn_credentials SET transports = '["internal","hybrid"]' WHERE transports IS NULL;
