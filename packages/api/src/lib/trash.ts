// Recycle bin (schema: migrations/0062_add_trash.sql).
//
// Deleting a doc, file or folder moves its rows OUT of the live
// docs/files/folders tables into trash_items as JSON snapshots, in one D1
// batch (a transaction). Because binned rows are physically absent from the
// live tables, every existing reader - public site, search, graph, export,
// /v1, file serving - keeps working unchanged and can never leak a binned
// item. What the bin deliberately does NOT move:
//
// - R2 objects (doc bodies, revision snapshots, file bytes) and asset_revisions
//   rows. Nothing has an FK to them, so they simply wait for purge.
// - doc_links / doc_ai_summaries, which cascade away with the docs row. Both
//   are derived caches: the graph is invalidated (reindexes on demand) and AI
//   summaries regenerate.
//
// doc_shares, the docs_fts row and site_reports.doc_id pointers would also be
// lost to the delete's cascades, but they are NOT derivable, so they ride
// along in trash_items.extra_json and come back on restore.
//
// Entries older than TRASH_RETENTION_DAYS are purged by the daily cron.

import type { Env } from "../index";
import { ProjectFeatures } from "../lib";
import { invalidateProjectGraphIndex } from "./docLinks";

export const TRASH_RETENTION_DAYS = 30;

export type TrashItemType = "doc" | "file" | "folder";

type Row = Record<string, unknown>;

interface DocExtra {
  shares?: Row[];
  fts?: { title: string; body: string } | null;
  reportIds?: string[];
}

export interface TrashEntry {
  id: string;
  project_id: string;
  item_type: TrashItemType;
  item_id: string;
  name: string;
  folder_id: string | null;
  folder_path: string | null;
  doc_count: number;
  file_count: number;
  folder_count: number;
  size: number;
  deleted_by: string;
  deleted_at: string;
}

// D1 caps bound parameters at 100 per statement; IN-lists are chunked well
// under that.
const CHUNK = 50;
// Live collab rooms of binned docs are reset so connected editors are kicked
// (as a hard delete always did). Bounded so binning a huge folder can't blow
// the Workers subrequest budget - rooms beyond the cap are reset at purge.
const MAX_ROOM_RESETS = 50;

function chunked<T>(items: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const qs = (n: number) => Array(n).fill("?").join(",");

const TABLES: Record<TrashItemType, "docs" | "files" | "folders"> = {
  doc: "docs",
  file: "files",
  folder: "folders",
};

// The column that points at the item's containing folder.
const PARENT_COL: Record<TrashItemType, "folder_id" | "parent_id"> = {
  doc: "folder_id",
  file: "folder_id",
  folder: "parent_id",
};

const SUBTREE_CTE = `WITH RECURSIVE sub(id, depth) AS (
  SELECT id, 0 FROM folders WHERE id = ?
  UNION ALL
  SELECT f.id, sub.depth + 1 FROM folders f JOIN sub ON f.parent_id = sub.id
)`;

async function selectIn(db: D1Database, sql: (ph: string) => string, ids: string[]): Promise<Row[]> {
  const out: Row[] = [];
  for (const chunk of chunked(ids)) {
    const res = await db.prepare(sql(qs(chunk.length))).bind(...chunk).all<Row>();
    out.push(...res.results);
  }
  return out;
}

// "Parent / Child" label for a folder, root-first. Bounded by the CTE's own
// termination (folder cycles are rejected at write time).
async function folderPathLabel(db: D1Database, folderId: string | null): Promise<string | null> {
  if (!folderId) return null;
  const res = await db.prepare(
    `WITH RECURSIVE anc(id, name, parent_id, depth) AS (
       SELECT id, name, parent_id, 0 FROM folders WHERE id = ?
       UNION ALL
       SELECT f.id, f.name, f.parent_id, anc.depth + 1 FROM folders f JOIN anc ON f.id = anc.parent_id
       WHERE anc.depth < 64
     )
     SELECT name FROM anc ORDER BY depth DESC`,
  ).bind(folderId).all<{ name: string }>();
  return res.results.length > 0 ? res.results.map(r => r.name).join(" / ") : null;
}

async function resetCollabRooms(env: Env, projectId: string, docIds: string[]): Promise<void> {
  if (!env.DOC_COLLAB || docIds.length === 0) return;
  const project = await env.DB.prepare("SELECT features FROM projects WHERE id = ?")
    .bind(projectId).first<{ features: number }>();
  if (!project || !(project.features & ProjectFeatures.REALTIME)) return;
  await Promise.allSettled(docIds.slice(0, MAX_ROOM_RESETS).map(docId => {
    const roomId = env.DOC_COLLAB!.idFromName(`${projectId}:${docId}`);
    return env.DOC_COLLAB!.get(roomId).fetch(new Request("https://internal/", { method: "DELETE" }));
  }));
}

export interface MoveToTrashResult {
  entryId: string;
  // A binned folder contained the site's home doc, which can't be binned; it
  // was moved to the site root instead.
  homeDocMoved: boolean;
}

// Moves an item (and, for a folder, its whole subtree) into the bin. Returns
// null when the item doesn't exist in `projectId`. The caller enforces
// permission and the home-doc rule for a direct doc delete.
export async function moveToTrash(
  env: Env,
  opts: { projectId: string; type: TrashItemType; id: string; deletedBy: string; now?: Date },
): Promise<MoveToTrashResult | null> {
  const { projectId, type, id, deletedBy } = opts;
  const db = env.DB;
  const root = await db.prepare(`SELECT * FROM ${TABLES[type]} WHERE id = ? AND project_id = ?`)
    .bind(id, projectId).first<Row>();
  if (!root) return null;

  let folders: (Row & { __depth: number })[] = [];
  let docs: Row[] = [];
  let files: Row[] = [];
  let homeDocMoved = false;
  const homeId = (await db.prepare("SELECT home_doc_id FROM projects WHERE id = ?")
    .bind(projectId).first<{ home_doc_id: string | null }>())?.home_doc_id ?? null;

  if (type === "folder") {
    folders = (await db.prepare(
      `${SUBTREE_CTE} SELECT f.*, sub.depth AS __depth FROM folders f JOIN sub ON sub.id = f.id ORDER BY sub.depth`,
    ).bind(id).all<Row & { __depth: number }>()).results;
    docs = (await db.prepare(`${SUBTREE_CTE} SELECT d.* FROM docs d WHERE d.folder_id IN (SELECT id FROM sub)`)
      .bind(id).all<Row>()).results;
    files = (await db.prepare(`${SUBTREE_CTE} SELECT fl.* FROM files fl WHERE fl.folder_id IN (SELECT id FROM sub)`)
      .bind(id).all<Row>()).results;
    if (homeId && docs.some(d => d.id === homeId)) {
      docs = docs.filter(d => d.id !== homeId);
      homeDocMoved = true;
    }
  } else if (type === "doc") {
    docs = [root];
  } else {
    files = [root];
  }

  const docIds = docs.map(d => d.id as string);
  const fileIds = files.map(f => f.id as string);

  // Satellite state that the docs-row delete would cascade away.
  const extras = new Map<string, DocExtra>();
  if (docIds.length > 0) {
    for (const s of await selectIn(db, ph => `SELECT * FROM doc_shares WHERE doc_id IN (${ph})`, docIds)) {
      const e = extras.get(s.doc_id as string) ?? {};
      (e.shares ??= []).push(s);
      extras.set(s.doc_id as string, e);
    }
    for (const f of await selectIn(db, ph => `SELECT doc_id, title, body FROM docs_fts WHERE doc_id IN (${ph})`, docIds)) {
      const e = extras.get(f.doc_id as string) ?? {};
      e.fts = { title: f.title as string, body: f.body as string };
      extras.set(f.doc_id as string, e);
    }
    for (const r of await selectIn(db, ph => `SELECT id, doc_id FROM site_reports WHERE doc_id IN (${ph})`, docIds)) {
      const e = extras.get(r.doc_id as string) ?? {};
      (e.reportIds ??= []).push(r.id as string);
      extras.set(r.doc_id as string, e);
    }
  }

  const parentId = (root[PARENT_COL[type]] as string | null) ?? null;
  const entry: TrashEntry = {
    id: crypto.randomUUID(),
    project_id: projectId,
    item_type: type,
    item_id: id,
    name: type === "doc" ? ((root.title as string) || "Untitled") : (root.name as string),
    folder_id: parentId,
    folder_path: await folderPathLabel(db, parentId),
    doc_count: docs.length,
    file_count: files.length,
    // Subfolders only - the binned folder itself isn't "contents".
    folder_count: Math.max(0, folders.length - 1),
    size: files.reduce((s, f) => s + (Number(f.size) || 0), 0),
    deleted_by: deletedBy,
    deleted_at: (opts.now ?? new Date()).toISOString(),
  };

  const stmts: D1PreparedStatement[] = [
    db.prepare(
      `INSERT INTO trash_entries (id, project_id, item_type, item_id, name, folder_id, folder_path,
         doc_count, file_count, folder_count, size, deleted_by, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(entry.id, entry.project_id, entry.item_type, entry.item_id, entry.name, entry.folder_id,
      entry.folder_path, entry.doc_count, entry.file_count, entry.folder_count, entry.size,
      entry.deleted_by, entry.deleted_at),
  ];
  const insertItem = db.prepare(
    `INSERT INTO trash_items (entry_id, project_id, item_type, item_id, depth, row_json, extra_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const { __depth, ...row } of folders) {
    stmts.push(insertItem.bind(entry.id, projectId, "folder", row.id as string, __depth, JSON.stringify(row), null));
  }
  for (const row of docs) {
    const extra = extras.get(row.id as string);
    stmts.push(insertItem.bind(entry.id, projectId, "doc", row.id as string, 0, JSON.stringify(row), extra ? JSON.stringify(extra) : null));
  }
  for (const row of files) {
    stmts.push(insertItem.bind(entry.id, projectId, "file", row.id as string, 0, JSON.stringify(row), null));
  }

  for (const chunk of chunked(docIds)) {
    stmts.push(db.prepare(`DELETE FROM docs_fts WHERE doc_id IN (${qs(chunk.length)})`).bind(...chunk));
    stmts.push(db.prepare(`DELETE FROM docs WHERE id IN (${qs(chunk.length)})`).bind(...chunk));
  }
  for (const chunk of chunked(fileIds)) {
    stmts.push(db.prepare(`DELETE FROM files WHERE id IN (${qs(chunk.length)})`).bind(...chunk));
  }
  if (homeDocMoved) {
    // Before the folder delete, so it's an explicit move rather than relying
    // on the ON DELETE SET NULL cascade.
    stmts.push(db.prepare("UPDATE docs SET folder_id = NULL WHERE id = ?").bind(homeId));
  }
  if (type === "folder") {
    // Subfolders go with it via the parent_id ON DELETE CASCADE; every doc and
    // file in the subtree has already been removed above, so nothing is left
    // for the folder_id SET NULL cascade to dump at the site root.
    stmts.push(db.prepare("DELETE FROM folders WHERE id = ?").bind(id));
  }

  await db.batch(stmts);

  if (docIds.length > 0) {
    await invalidateProjectGraphIndex(env, projectId);
    try { await resetCollabRooms(env, projectId, docIds); } catch { /* non-fatal */ }
  }
  return { entryId: entry.id, homeDocMoved };
}

export async function listTrash(db: D1Database, projectId: string): Promise<(TrashEntry & { deleted_by_name: string | null })[]> {
  const res = await db.prepare(
    `SELECT e.*, pm.name AS deleted_by_name
     FROM trash_entries e
     LEFT JOIN project_members pm ON pm.project_id = e.project_id AND pm.user_id = e.deleted_by
     WHERE e.project_id = ?
     ORDER BY e.deleted_at DESC`,
  ).bind(projectId).all<TrashEntry & { deleted_by_name: string | null }>();
  return res.results;
}

const columnCache = new Map<string, Set<string>>();

// Current columns of a live table. Restore inserts only the snapshot keys the
// table still has, so a column added after an item was binned takes its
// default and one dropped since is ignored, instead of failing the restore.
async function tableColumns(db: D1Database, table: string): Promise<Set<string>> {
  const cached = columnCache.get(table);
  if (cached) return cached;
  const res = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
  const cols = new Set(res.results.map(r => r.name));
  if (cols.size > 0) columnCache.set(table, cols);
  return cols;
}

function insertRow(db: D1Database, table: string, cols: Set<string>, row: Row): D1PreparedStatement {
  const keys = Object.keys(row).filter(k => cols.has(k));
  return db.prepare(`INSERT INTO ${table} (${keys.join(", ")}) VALUES (${qs(keys.length)})`)
    .bind(...keys.map(k => row[k] ?? null));
}

export interface RestoreResult {
  type: TrashItemType;
  itemId: string;
  // Where the restored item now lives: its original folder when that still
  // exists, otherwise the site root (null).
  folderId: string | null;
}

// Restores a bin entry in one batch. Returns null when the entry doesn't exist
// in `projectId`.
export async function restoreFromTrash(env: Env, projectId: string, entryId: string): Promise<RestoreResult | null> {
  const db = env.DB;
  const entry = await db.prepare("SELECT * FROM trash_entries WHERE id = ? AND project_id = ?")
    .bind(entryId, projectId).first<TrashEntry>();
  if (!entry) return null;

  const items = (await db.prepare(
    `SELECT item_type, item_id, depth, row_json, extra_json FROM trash_items WHERE entry_id = ?
     ORDER BY CASE item_type WHEN 'folder' THEN 0 ELSE 1 END, depth`,
  ).bind(entryId).all<{ item_type: TrashItemType; item_id: string; depth: number; row_json: string; extra_json: string | null }>()).results;

  const parent = entry.folder_id
    ? await db.prepare("SELECT id FROM folders WHERE id = ? AND project_id = ?").bind(entry.folder_id, projectId).first<{ id: string }>()
    : null;
  const folderId = parent?.id ?? null;

  const docs = items.filter(i => i.item_type === "doc").map(i => ({ row: JSON.parse(i.row_json) as Row, extra: i.extra_json ? JSON.parse(i.extra_json) as DocExtra : {} }));

  // A custom slug claimed by another doc while this one was binned is dropped
  // rather than failing the restore on the (project_id, slug) unique index.
  const slugs = docs.map(d => d.row.slug).filter((s): s is string => typeof s === "string" && s !== "");
  const taken = new Set<string>();
  for (const chunk of chunked(slugs)) {
    const res = await db.prepare(`SELECT slug FROM docs WHERE project_id = ? AND slug IN (${qs(chunk.length)})`)
      .bind(projectId, ...chunk).all<{ slug: string }>();
    for (const r of res.results) taken.add(r.slug);
  }

  const stmts: D1PreparedStatement[] = [];
  for (const item of items) {
    if (item.item_type === "doc") continue;
    const row = JSON.parse(item.row_json) as Row;
    if (item.item_id === entry.item_id) row[PARENT_COL[item.item_type]] = folderId;
    stmts.push(insertRow(db, TABLES[item.item_type], await tableColumns(db, TABLES[item.item_type]), row));
  }
  const docCols = await tableColumns(db, "docs");
  const shareCols = await tableColumns(db, "doc_shares");
  for (const { row, extra } of docs) {
    if (row.id === entry.item_id) row.folder_id = folderId;
    if (typeof row.slug === "string" && taken.has(row.slug)) row.slug = null;
    stmts.push(insertRow(db, "docs", docCols, row));
    for (const share of extra.shares ?? []) {
      const keys = Object.keys(share).filter(k => shareCols.has(k));
      stmts.push(db.prepare(`INSERT OR IGNORE INTO doc_shares (${keys.join(", ")}) VALUES (${qs(keys.length)})`)
        .bind(...keys.map(k => share[k] ?? null)));
    }
    if (extra.fts) {
      stmts.push(db.prepare("INSERT INTO docs_fts(doc_id, project_id, title, body) VALUES (?, ?, ?, ?)")
        .bind(row.id as string, projectId, extra.fts.title, extra.fts.body));
    }
    for (const reportId of extra.reportIds ?? []) {
      stmts.push(db.prepare("UPDATE site_reports SET doc_id = ? WHERE id = ? AND doc_id IS NULL").bind(row.id as string, reportId));
    }
  }
  // Last: the trash_items rows cascade away with the entry.
  stmts.push(db.prepare("DELETE FROM trash_entries WHERE id = ?").bind(entryId));

  await db.batch(stmts);
  if (docs.length > 0) await invalidateProjectGraphIndex(env, projectId);
  return { type: entry.item_type, itemId: entry.item_id, folderId };
}

// Permanently deletes a bin entry: R2 objects first, then rows, so a failure
// part-way leaves the entry in place to be retried (re-deleting a missing R2
// key is a no-op). Doc revision objects are deleted by key from their
// asset_revisions rows - one R2 call per 1000 keys rather than one prefix
// listing per doc, so purging a large folder stays inside the subrequest
// budget.
export async function purgeTrashEntry(env: Env, entry: { id: string; project_id: string }): Promise<void> {
  const db = env.DB;
  const projectId = entry.project_id;
  const items = (await db.prepare("SELECT item_type, item_id FROM trash_items WHERE entry_id = ?")
    .bind(entry.id).all<{ item_type: TrashItemType; item_id: string }>()).results;
  const docIds = items.filter(i => i.item_type === "doc").map(i => i.item_id);
  const fileIds = items.filter(i => i.item_type === "file").map(i => i.item_id);

  const revisions = await selectIn(
    db,
    ph => `SELECT id, asset_id FROM asset_revisions WHERE asset_type = 'doc' AND asset_id IN (${ph})`,
    docIds,
  );
  const keys = [
    ...docIds.map(id => `${projectId}/${id}`),
    ...revisions.map(r => `${projectId}/${r.asset_id}/v/${r.id}`),
    ...fileIds.map(id => `files/${id}`),
  ];
  for (const chunk of chunked(keys, 1000)) await env.ASSETS.delete(chunk);

  try { await resetCollabRooms(env, projectId, docIds); } catch { /* non-fatal */ }

  const stmts: D1PreparedStatement[] = [];
  for (const chunk of chunked(docIds)) {
    stmts.push(db.prepare(`DELETE FROM asset_revisions WHERE asset_type = 'doc' AND asset_id IN (${qs(chunk.length)})`).bind(...chunk));
  }
  stmts.push(db.prepare("DELETE FROM trash_entries WHERE id = ?").bind(entry.id));
  await db.batch(stmts);
}

// Empties a site's bin. Bounded per call; returns how many entries remain so
// the caller can report a partial empty (the cron finishes the rest anyway).
export async function emptyTrash(env: Env, projectId: string, maxEntries = 200): Promise<{ purged: number; remaining: number }> {
  const rows = (await env.DB.prepare("SELECT id, project_id FROM trash_entries WHERE project_id = ? ORDER BY deleted_at LIMIT ?")
    .bind(projectId, maxEntries).all<{ id: string; project_id: string }>()).results;
  for (const row of rows) await purgeTrashEntry(env, row);
  const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM trash_entries WHERE project_id = ?")
    .bind(projectId).first<{ n: number }>();
  return { purged: rows.length, remaining: left?.n ?? 0 };
}

// Daily retention sweep: purges entries older than TRASH_RETENTION_DAYS.
// Bounded per run; a backlog drains over successive days.
export async function purgeExpiredTrash(env: Env, opts: { now?: Date; maxEntries?: number } = {}): Promise<number> {
  const cutoff = new Date((opts.now ?? new Date()).getTime() - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const rows = (await env.DB.prepare("SELECT id, project_id FROM trash_entries WHERE deleted_at < ? ORDER BY deleted_at LIMIT ?")
    .bind(cutoff, opts.maxEntries ?? 200).all<{ id: string; project_id: string }>()).results;
  for (const row of rows) await purgeTrashEntry(env, row);
  return rows.length;
}
