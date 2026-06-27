-- Read-efficiency indexes.
--
-- docs(project_id): the FK declared in 0001_init.sql was never indexed.
-- Many hot queries filter docs by project (sidebar, graph build, doc-share
-- grants, exports, FTS rebuilds, the COUNT(*) subquery in /api/projects).
-- Without this every one of those forces a full docs scan.
--
-- doc_shares(user_id) and doc_shares(project_id, user_id): the table's
-- UNIQUE(doc_id, user_id) already auto-indexes lookups keyed by doc_id,
-- but the limited-viewer hot path also hits "shares for this user in this
-- project" (graph.ts) and "any share for this user in this project"
-- (files.ts) - both unindexed today.
CREATE INDEX IF NOT EXISTS idx_docs_project           ON docs(project_id);
CREATE INDEX IF NOT EXISTS idx_doc_shares_user        ON doc_shares(user_id);
CREATE INDEX IF NOT EXISTS idx_doc_shares_project_user ON doc_shares(project_id, user_id);
