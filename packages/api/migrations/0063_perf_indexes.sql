-- Additive performance indexes (no column changes, no drops). Each index is
-- tied to the query it serves; all verified with EXPLAIN QUERY PLAN against
-- the fully migrated schema (see packages/api/src/test/perfIndexes.test.ts).

-- "Your Sites" (GET /projects), GET /pending-invites, account deletion and
-- the per-user name/email sync all filter project_members by user_id. The
-- original idx_members_user (0007) was lost in the 0032/0033 table rebuilds,
-- leaving only the UNIQUE(project_id, user_id) autoindex, so these SCAN.
CREATE INDEX IF NOT EXISTS idx_project_members_user ON project_members(user_id, accepted);

-- folders.parent_id is an ON DELETE CASCADE FK: without an index every
-- folder delete scans folders to find children.
CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_id);
-- Per-site folder listings (root: parent_id IS NULL). With parent_id alone
-- the planner would pick idx_folders_parent for `parent_id IS NULL` and walk
-- every site's root folders.
CREATE INDEX IF NOT EXISTS idx_folders_project_parent ON folders(project_id, parent_id);

-- site_reports.doc_id is an ON DELETE SET NULL FK (every doc delete scanned
-- site_reports) and is looked up by doc id when binning docs (lib/trash.ts).
CREATE INDEX IF NOT EXISTS idx_site_reports_doc ON site_reports(doc_id);

-- Folder listings (`project_id = ? AND folder_id = ? / IS NULL`) previously
-- read every doc in the site via idx_docs_project.
CREATE INDEX IF NOT EXISTS idx_docs_project_folder ON docs(project_id, folder_id);

-- Published docs of a site, newest publish first (routes/public.ts).
CREATE INDEX IF NOT EXISTS idx_docs_project_published
  ON docs(project_id, published_at) WHERE published_at IS NOT NULL;

-- Owned-org checks on account deletion + admin user deletion/preview.
CREATE INDEX IF NOT EXISTS idx_organizations_owner ON organizations(owner_id);

-- user_favourite_projects has no FK to projects (adding one needs a table
-- rebuild) and no delete path cleaned it, so deleted sites left orphan rows.
-- Clear the existing orphans, then keep it clean with a trigger; the index
-- serves the trigger's per-project delete.
DELETE FROM user_favourite_projects WHERE project_id NOT IN (SELECT id FROM projects);
CREATE INDEX IF NOT EXISTS idx_ufp_project ON user_favourite_projects(project_id);
CREATE TRIGGER IF NOT EXISTS trg_projects_delete_ufp AFTER DELETE ON projects
BEGIN
  DELETE FROM user_favourite_projects WHERE project_id = OLD.id;
END;

-- Site deletion removes a site's revisions by project_id.
CREATE INDEX IF NOT EXISTS idx_asset_revisions_project ON asset_revisions(project_id);
-- Revision history / latest revision / retention pruning's ROW_NUMBER() all
-- order by (created_at DESC, id DESC) within an asset;
-- idx_asset_revisions_asset_created lacks the id tie-break and needed a TEMP
-- B-TREE. (The old index is left in place for now; dropped in a follow-up.)
-- No standalone created_at index: the pruning cutoff is applied outside the
-- window subquery, so SQLite cannot use one there.
CREATE INDEX IF NOT EXISTS idx_asset_revisions_asset_created_id
  ON asset_revisions(asset_type, asset_id, created_at DESC, id DESC);

-- Admin reports "all statuses" list: ORDER BY created_at DESC, id DESC.
CREATE INDEX IF NOT EXISTS idx_site_reports_created ON site_reports(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_user_reports_created ON user_reports(created_at DESC, id DESC);

-- Favourite-site search over published sites, ORDER BY name LIMIT 20.
CREATE INDEX IF NOT EXISTS idx_projects_published_name
  ON projects(name) WHERE published_at IS NOT NULL;
