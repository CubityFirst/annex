-- Custom per-doc URL slugs, set via the `slug:` frontmatter key and synced to
-- this column on every save path. Unique per site (the docs table is the
-- site-central slug registry); NULL = no custom slug, doc is reachable by id only.
ALTER TABLE docs ADD COLUMN slug TEXT;
CREATE UNIQUE INDEX idx_docs_project_slug ON docs (project_id, slug) WHERE slug IS NOT NULL;
