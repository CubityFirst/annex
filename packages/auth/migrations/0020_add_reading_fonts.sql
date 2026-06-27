-- User-selectable reading & editing fonts. NULL means "use the default"
-- (sans for reading, sans for editing - the editor's monospace code-line
-- rules still apply regardless of this prose-level choice).
--
-- Read by loadCurrentSession() and surfaced on the GET /me API response,
-- so a schema change here requires redeploying auth + api workers.
ALTER TABLE users ADD COLUMN reading_font TEXT;
ALTER TABLE users ADD COLUMN editing_font TEXT;
