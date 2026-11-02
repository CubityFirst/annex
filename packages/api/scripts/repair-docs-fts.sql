-- Re-runnable repair for docs_fts / docs_fts_map (migration 0064).
--
-- Run it once right after the api + admin workers that understand 0064 are
-- fully deployed. Between applying 0064 and that deploy, still-running old code
-- writes docs_fts rows with no `pid` and no map row, and deletes rows without
-- touching the map. Search ignores those rows (they can't match `pid:`), so the
-- only symptom is that the affected docs are missing from search until this
-- runs. Safe to run any number of times; on a consistent index it changes
-- nothing.
--
--   cd packages/api && npx wrangler d1 execute cubedocs-main --remote \
--     --command="$(grep -v '^--' scripts/repair-docs-fts.sql | tr '\n' ' ')"
--
-- (Git Bash/POSIX shell.) Why not plain `--file` / `--command "$(cat ...)"`:
-- a remote --file goes through D1's bulk-import API rather than the query
-- path `migrations apply` uses (the path that created and rebuilt docs_fts);
-- and on Windows `npx` runs through a .cmd shim that cuts an argument off at
-- its first newline, so a multi-line --command silently runs only its first
-- line. Stripping the full-line comments and joining the lines avoids both;
-- the output must show 8 result sets, the last two being the checks below.
-- Every step is defined on the current state alone, so a run interrupted
-- part-way is fixed by simply running it again.
--
-- Old code always deletes EVERY row of a doc before inserting its new one, so
-- if a doc has both a mapped row and unmapped rows, the mapped row was written
-- later (by new code) and is the one to keep.

-- 1. Rows whose doc no longer exists (binned docs keep theirs in
--    trash_items.extra_json; anything else is a leak).
DELETE FROM docs_fts WHERE rowid IN (
  SELECT rowid FROM docs_fts WHERE doc_id NOT IN (SELECT id FROM docs)
);

-- 2. Map rows that don't point at their own doc's row.
DELETE FROM docs_fts_map WHERE NOT EXISTS (
  SELECT 1 FROM docs_fts f WHERE f.rowid = docs_fts_map.rid AND f.doc_id = docs_fts_map.doc_id
);

-- 3. Unmapped rows of a doc that still has a mapped row: stale.
DELETE FROM docs_fts WHERE rowid IN (
  SELECT f.rowid FROM docs_fts f
  WHERE f.rowid NOT IN (SELECT rid FROM docs_fts_map)
    AND f.doc_id IN (SELECT doc_id FROM docs_fts_map)
);

-- 4. Remaining unmapped rows: keep only the newest per doc.
DELETE FROM docs_fts WHERE rowid IN (
  SELECT rowid FROM docs_fts
  WHERE rowid NOT IN (SELECT rid FROM docs_fts_map)
    AND rowid NOT IN (
      SELECT max(rowid) FROM docs_fts WHERE rowid NOT IN (SELECT rid FROM docs_fts_map) GROUP BY doc_id
    )
);

-- 5. Map them.
INSERT INTO docs_fts_map (rid, doc_id)
SELECT rowid, doc_id FROM docs_fts WHERE rowid NOT IN (SELECT rid FROM docs_fts_map);

-- 6. Give rows written by old code their site token.
UPDATE docs_fts SET pid = hex(project_id) WHERE pid IS NULL OR pid <> hex(project_id);

-- Verification: fts_rows = map_rows, bad_pid = 0. unindexed_docs counts docs
-- with no FTS row at all (normally 0; e.g. a doc binned by new code while its
-- row was still an unmapped old-code row, then restored). If it isn't 0,
-- reindex those sites (admin Sites -> Reindex, or the owner's
-- POST /projects/:id/reindex) - the per-site breakdown is below.
SELECT
  (SELECT count(*) FROM docs_fts) AS fts_rows,
  (SELECT count(*) FROM docs_fts_map) AS map_rows,
  (SELECT count(*) FROM docs_fts WHERE pid IS NULL OR pid <> hex(project_id)) AS bad_pid,
  (SELECT count(*) FROM docs d WHERE NOT EXISTS (SELECT 1 FROM docs_fts_map m WHERE m.doc_id = d.id)) AS unindexed_docs;

SELECT d.project_id, count(*) AS unindexed_docs
FROM docs d
WHERE NOT EXISTS (SELECT 1 FROM docs_fts_map m WHERE m.doc_id = d.id)
GROUP BY d.project_id;
