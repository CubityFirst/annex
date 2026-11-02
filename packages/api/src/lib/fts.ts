import { stripFrontmatter } from "./frontmatter";

function stripMarkdown(content: string): string {
  let text = stripFrontmatter(content);
  text = text.replace(/```[\s\S]*?```/g, " ");
  text = text.replace(/`[^`\n]+`/g, " ");
  text = text.replace(/!\[.*?\]\(.*?\)/g, " ");
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  text = text.replace(/#{1,6}\s+/g, "");
  text = text.replace(/(\*\*|__)(.+?)\1/g, "$2");
  text = text.replace(/(\*|_)(.+?)\1/g, "$2");
  text = text.replace(/^>\s*/gm, "");
  text = text.replace(/^[-*+]\s+/gm, "");
  text = text.replace(/^\d+\.\s+/gm, "");
  text = text.replace(/\|/g, " ");
  text = text.replace(/[~_*[\]]/g, "");
  return text.replace(/\s+/g, " ").trim();
}

// Each user word as a quoted FTS5 phrase. Quotes are stripped first, so a word
// can never close its phrase: user input can only ever be plain terms, never
// operators or column filters.
function ftsTerms(q: string): string[] {
  const words = q.replace(/['"*()^:~\-]/g, " ").trim().split(/\s+/).filter(Boolean);
  // Star the final token so search-as-you-type matches partially typed words
  // ("colla" finds "collaboration"); earlier tokens must be complete words.
  return words.map((w, i) => (i === words.length - 1 ? `"${w}"*` : `"${w}"`));
}

export function sanitizeFtsQuery(q: string): string {
  const terms = ftsTerms(q);
  return terms.length ? terms.join(" ") : '""';
}

// ---------------------------------------------------------------------------
// docs_fts layout (migrations/0064_rebuild_docs_fts.sql):
//
//   docs_fts(title, body, pid, doc_id UNINDEXED, project_id UNINDEXED)
//   docs_fts_map(rid INTEGER PRIMARY KEY, doc_id TEXT UNIQUE)
//
// `pid` holds one indexed token per row, hex(project_id), so a search ANDs
// `pid:"<token>"` into its MATCH and FTS5 only evaluates that site's rows.
// docs_fts_map gives every doc its FTS rowid, so per-doc writes are rowid
// lookups rather than a scan of the UNINDEXED doc_id column. Every writer
// below keeps exactly one map row per docs_fts row.
//
// A doc's row is replaced, not updated in place: the old row (found through
// the map, and only if it really is this doc's) is deleted, the new one is
// inserted with an automatic rowid (max + 1, so it can never collide with a
// row some other writer put there), and the map is pointed at it via
// last_insert_rowid(). INSERT OR REPLACE also drops any stale map row that
// claimed the new rowid. The three statements must stay adjacent in a batch.
// ---------------------------------------------------------------------------

// The `pid` token for a site: hex of the id's UTF-8 bytes, exactly what
// SQLite's hex(project_id) produces (the migration and the writers below use
// that). Injective, a single token for any id under the ascii tokenizer, and
// longer than the porter stemmer's 64-char cap for UUIDs.
export function ftsSiteToken(projectId: string): string {
  let out = "";
  for (const b of new TextEncoder().encode(projectId)) out += b.toString(16).padStart(2, "0");
  return out.toUpperCase();
}

// MATCH expression for a site-scoped search: the site token, AND every
// sanitized user term restricted to the title/body columns. The column filter
// is what keeps a user prefix like "a"* from matching the pid token itself.
// Ranking is unchanged as long as callers weight pid 0: bm25(docs_fts, 5.0, 1.0, 0.0).
export function siteFtsMatch(projectId: string, q: string): string {
  const terms = ftsTerms(q);
  const filtered = terms.length ? terms.map(t => `{title body}:${t}`) : ['{title body}:""'];
  return [`pid:"${ftsSiteToken(projectId)}"`, ...filtered].join(" AND ");
}

function siteOnlyMatch(projectId: string): string {
  return `pid:"${ftsSiteToken(projectId)}"`;
}

// Inserts an already-stripped title/body as the doc's row (replacing any
// existing one). Used directly by recycle-bin restore, which re-inserts the
// exact title/body it snapshotted.
export function ftsInsertStatements(
  db: D1Database,
  docId: string,
  projectId: string,
  title: string,
  body: string,
): D1PreparedStatement[] {
  return [
    db.prepare("DELETE FROM docs_fts WHERE rowid = (SELECT rid FROM docs_fts_map WHERE doc_id = ?) AND doc_id = ?")
      .bind(docId, docId),
    db.prepare("INSERT INTO docs_fts (title, body, pid, doc_id, project_id) VALUES (?, ?, hex(?), ?, ?)")
      .bind(title, body, projectId, docId, projectId),
    db.prepare("INSERT OR REPLACE INTO docs_fts_map (rid, doc_id) VALUES (last_insert_rowid(), ?)").bind(docId),
  ];
}

export function ftsUpsertStatements(
  db: D1Database,
  docId: string,
  projectId: string,
  title: string,
  content: string,
): D1PreparedStatement[] {
  return ftsInsertStatements(db, docId, projectId, title, stripMarkdown(content));
}

export async function upsertFtsRow(
  db: D1Database,
  docId: string,
  projectId: string,
  title: string,
  content: string,
): Promise<void> {
  await db.batch(ftsUpsertStatements(db, docId, projectId, title, content));
}

// Deletes the rows of up to ~90 docs (one bound parameter per id). The
// correlated doc_id check makes sure a map row can only ever delete its own
// doc's row.
export function ftsDeleteStatements(db: D1Database, docIds: string[]): D1PreparedStatement[] {
  if (docIds.length === 0) return [];
  const ph = docIds.map(() => "?").join(",");
  return [
    db.prepare(
      `DELETE FROM docs_fts WHERE rowid IN (SELECT rid FROM docs_fts_map WHERE doc_id IN (${ph}))
         AND doc_id = (SELECT m.doc_id FROM docs_fts_map m WHERE m.rid = docs_fts.rowid)`,
    ).bind(...docIds),
    db.prepare(`DELETE FROM docs_fts_map WHERE doc_id IN (${ph})`).bind(...docIds),
  ];
}

export async function deleteFtsRow(db: D1Database, docId: string): Promise<void> {
  await db.batch(ftsDeleteStatements(db, [docId]));
}

// Every row of one site, found through the indexed pid token. Map rows first,
// while the FTS rows they point at still exist.
export function ftsDeleteProjectStatements(db: D1Database, projectId: string): D1PreparedStatement[] {
  const match = siteOnlyMatch(projectId);
  return [
    db.prepare("DELETE FROM docs_fts_map WHERE rid IN (SELECT rowid FROM docs_fts WHERE docs_fts MATCH ?)").bind(match),
    db.prepare("DELETE FROM docs_fts WHERE docs_fts MATCH ?").bind(match),
  ];
}

export async function deleteFtsForProject(db: D1Database, projectId: string): Promise<void> {
  await db.batch(ftsDeleteProjectStatements(db, projectId));
}

// After a full-site reindex: drops the site's rows whose doc is no longer in
// the site (e.g. left behind by an interrupted delete).
export function ftsPruneProjectStatements(db: D1Database, projectId: string): D1PreparedStatement[] {
  const match = siteOnlyMatch(projectId);
  const stale = "SELECT rowid FROM docs_fts WHERE docs_fts MATCH ? AND doc_id NOT IN (SELECT id FROM docs WHERE project_id = ?)";
  return [
    db.prepare(`DELETE FROM docs_fts_map WHERE rid IN (${stale})`).bind(match, projectId),
    db.prepare(`DELETE FROM docs_fts WHERE rowid IN (${stale})`).bind(match, projectId),
  ];
}
