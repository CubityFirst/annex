-- Split per-project logo into two slots: a square icon (used in the projects
-- sidebar, favourites, profile cards) and a wide wordmark (used in the
-- top-left of published-site headers). Existing single-slot uploads are
-- migrated into logo_wide_updated_at (most users uploaded wordmark-style
-- assets that fit the published-site header); the square slot starts empty
-- and admins re-upload a square icon when they want one.
--
-- R2 keys move from `site-logos/{id}` to `site-logos/{id}-square` /
-- `site-logos/{id}-wide` - handled out-of-band by
-- packages/api/scripts/backfill-logo-keys.ts.
ALTER TABLE projects ADD COLUMN logo_square_updated_at TEXT;
ALTER TABLE projects ADD COLUMN logo_wide_updated_at TEXT;
UPDATE projects SET logo_wide_updated_at = logo_updated_at WHERE logo_updated_at IS NOT NULL;
ALTER TABLE projects DROP COLUMN logo_updated_at;
