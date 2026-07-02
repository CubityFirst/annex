ALTER TABLE asset_revisions ADD COLUMN title TEXT;
DROP INDEX IF EXISTS idx_asset_revisions_asset;
CREATE INDEX IF NOT EXISTS idx_asset_revisions_asset_created ON asset_revisions(asset_type, asset_id, created_at DESC);
