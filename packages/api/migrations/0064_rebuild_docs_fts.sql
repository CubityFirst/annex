-- Rebuild docs_fts so per-site search and per-doc writes stop scanning the
-- whole platform's FTS corpus (see packages/api/src/lib/fts.ts).
--
-- 1. `pid` is a new INDEXED column holding one token per row: hex(project_id).
--    Search ANDs `pid:"<token>"` into the MATCH, so FTS5 only evaluates (and
--    runs bm25/snippet for) rows of the requested site. hex() of the UTF-8 id
--    is injective, a single token for any id under the ascii tokenizer, and
--    (72 chars for a UUID, > the porter stemmer's 64-char cap) never stemmed.
--    pid is declared after body, so snippet(docs_fts, 1, ...) is still the body
--    and bm25(docs_fts, 5.0, 1.0, 0.0) keeps the title/body weights while
--    giving the pid hit no weight.
-- 2. docs_fts_map(rid, doc_id) maps each doc to its FTS rowid, so writes are
--    rowid lookups instead of a `WHERE doc_id = ?` scan of an UNINDEXED column.
--    Invariant (kept by lib/fts.ts and lib/trash.ts): exactly one map row per
--    docs_fts row.
--
-- Rows are copied with their rowids preserved. Only one row per doc survives
-- (the newest, should a race have left duplicates), and rows whose doc no
-- longer exists in `docs` are dropped: a binned doc's FTS row already lives in
-- trash_items.extra_json (restore re-inserts it from there), so anything left
-- in docs_fts for a missing doc is a leak (e.g. a site deleted without its
-- FTS cleanup).

CREATE VIRTUAL TABLE docs_fts_new USING fts5(
  title,
  body,
  pid,
  doc_id     UNINDEXED,
  project_id UNINDEXED,
  tokenize = 'porter ascii'
);

INSERT INTO docs_fts_new (rowid, title, body, pid, doc_id, project_id)
SELECT f.rowid, f.title, f.body, hex(f.project_id), f.doc_id, f.project_id
FROM docs_fts f
WHERE f.rowid IN (SELECT max(rowid) FROM docs_fts GROUP BY doc_id)
  AND f.doc_id IN (SELECT id FROM docs);

DROP TABLE docs_fts;
ALTER TABLE docs_fts_new RENAME TO docs_fts;

CREATE TABLE docs_fts_map (
  rid    INTEGER PRIMARY KEY,
  doc_id TEXT NOT NULL UNIQUE
);

INSERT INTO docs_fts_map (rid, doc_id) SELECT rowid, doc_id FROM docs_fts;
