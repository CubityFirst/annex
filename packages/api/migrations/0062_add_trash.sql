-- Recycle bin. Deleting a doc, file or folder from a site no longer destroys
-- it: its rows are MOVED out of the live docs/files/folders tables into
-- trash_items (as JSON snapshots), so none of the many readers of those tables
-- (public site, search, graph, export, /v1, ...) ever needs a "not deleted"
-- filter. R2 objects (doc bodies, revisions, file bytes) and asset_revisions
-- rows stay put until the entry is purged. See src/lib/trash.ts.

-- One row per user-visible bin entry: the thing the user deleted. Deleting a
-- folder creates ONE entry holding the whole subtree.
CREATE TABLE trash_entries (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  item_type    TEXT NOT NULL CHECK (item_type IN ('doc', 'file', 'folder')),
  item_id      TEXT NOT NULL,
  name         TEXT NOT NULL,
  -- Parent folder at deletion time. Restore puts the item back there if that
  -- folder still exists, otherwise at the site root. No FK: the folder may be
  -- deleted (or binned) independently.
  folder_id    TEXT,
  -- "Parent / Child" label of folder_id at deletion time, for display only.
  folder_path  TEXT,
  -- Contents of a binned folder subtree (a doc/file entry counts itself).
  doc_count    INTEGER NOT NULL DEFAULT 0,
  file_count   INTEGER NOT NULL DEFAULT 0,
  folder_count INTEGER NOT NULL DEFAULT 0,
  -- Total file bytes in the entry.
  size         INTEGER NOT NULL DEFAULT 0,
  -- Auth-DB users.id; no FK (users live in the auth DB).
  deleted_by   TEXT NOT NULL,
  deleted_at   TEXT NOT NULL
);

CREATE INDEX idx_trash_entries_project ON trash_entries (project_id, deleted_at DESC);
-- The daily retention sweep scans by age across all projects.
CREATE INDEX idx_trash_entries_deleted_at ON trash_entries (deleted_at);

-- Every row removed from docs/files/folders by a bin entry. row_json is the
-- full original row; extra_json carries satellite state the delete would
-- otherwise lose to ON DELETE cascades (doc_shares, the docs_fts row, and
-- site_reports pointers).
CREATE TABLE trash_items (
  entry_id   TEXT NOT NULL REFERENCES trash_entries(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  item_type  TEXT NOT NULL CHECK (item_type IN ('doc', 'file', 'folder')),
  item_id    TEXT NOT NULL,
  -- Folder depth below the entry root (0 = root); restore inserts parents first.
  depth      INTEGER NOT NULL DEFAULT 0,
  row_json   TEXT NOT NULL,
  extra_json TEXT,
  PRIMARY KEY (item_type, item_id)
);

CREATE INDEX idx_trash_items_entry ON trash_items (entry_id);
-- Site deletion sweeps a project's binned file/doc ids for R2 cleanup.
CREATE INDEX idx_trash_items_project ON trash_items (project_id, item_type);
