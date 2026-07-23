-- Pending new address for an email-change request.
-- NULL = plain verification of the account's current email (signup flow).
ALTER TABLE email_verification_tokens ADD COLUMN email TEXT;
