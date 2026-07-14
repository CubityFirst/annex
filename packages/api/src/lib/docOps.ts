import type { Env } from "../index";
import { parseFrontmatter } from "./frontmatter";
import { indexDocLinks, invalidateProjectGraphIndex } from "./docLinks";
import { upsertFtsRow, deleteFtsRow } from "./fts";

// Shared document write operations.
//
// These encapsulate the full side-effect chain for creating, updating and
// deleting a doc - R2 body + version objects, the docs row, asset_revisions,
// FTS index, doc-link graph index, and the cached AI summary. Both the
// interactive JWT handler (routes/docs.ts) and the public API-key handler
// (routes/v1.ts) call these so the two surfaces can never drift apart (e.g.
// one forgetting to reindex FTS or invalidate the graph).
//
// Callers are responsible for authorization and for validating that any target
// folderId belongs to the doc's project BEFORE calling these.

// ── Custom doc slugs ─────────────────────────────────────────────────────────
//
// A doc can claim a custom public URL segment via the `slug:` frontmatter key
// (/s/<site>/<slug> instead of /s/<site>/<uuid>). The docs table is the
// site-central registry: docs.slug, unique per project (partial index in
// 0061). Synced on every path that persists content - createDoc,
// applyDocUpdate, and snapshotDocRevision (which also covers the collab
// checkpoint and revision restore).

const DOC_SLUG_MAX_LENGTH = 100;
// Doc ids are crypto.randomUUID(); rejecting UUID-shaped slugs means the
// public (id = ? OR slug = ?) lookup can never match two different docs, so a
// slug can't shadow another doc's canonical id URL.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Path segments the public frontend claims for itself ("/s/<site>/graph" is
// the published graph view, and "/<slug>" must stay unambiguous in host mode).
const RESERVED_DOC_SLUGS = new Set(["graph"]);

// Returns the canonical form of a requested slug, or null when the value is
// unusable (which callers treat as "no slug"). Lowercase alphanumerics and
// hyphens, no leading/trailing hyphen.
export function normalizeDocSlug(raw: string | undefined): string | null {
  if (!raw) return null;
  const slug = raw.trim().toLowerCase();
  if (slug.length === 0 || slug.length > DOC_SLUG_MAX_LENGTH) return null;
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(slug)) return null;
  if (RESERVED_DOC_SLUGS.has(slug)) return null;
  if (UUID_RE.test(slug)) return null;
  return slug;
}

// Syncs the doc's stored slug from its frontmatter. A single conditional
// UPDATE (not SELECT-then-UPDATE) so concurrent saves can't both claim the
// same slug: when the wanted slug is already held by another doc in the site,
// this doc's stored slug is left unchanged (first claimant wins; the doc keeps
// its previous working URL). An absent/invalid frontmatter slug clears the
// column unconditionally.
export async function syncDocSlug(env: Env, projectId: string, docId: string, rawSlug: string | undefined): Promise<void> {
  const slug = normalizeDocSlug(rawSlug);
  await env.DB.prepare(
    `UPDATE docs SET slug = ?2 WHERE id = ?1 AND (?2 IS NULL OR NOT EXISTS (
       SELECT 1 FROM docs WHERE project_id = ?3 AND slug = ?2 AND id <> ?1))`,
  ).bind(docId, slug, projectId).run();
}

export interface CreateDocInput {
  projectId: string;
  authorId: string;
  title: string;
  content: string;
  folderId: string | null;
}

export interface CreatedDoc {
  id: string;
  title: string;
  content: string;
  projectId: string;
  authorId: string;
  folderId: string | null;
  publishedAt: null;
  createdAt: string;
  updatedAt: string;
}

export async function createDoc(env: Env, input: CreateDocInput): Promise<CreatedDoc> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const content = input.content ?? "";
  const fm = parseFrontmatter(content);
  const sidebarPosition = fm.sidebar_position ?? null;
  const tags = fm.tags ? JSON.stringify(fm.tags) : null;

  await env.ASSETS.put(`${input.projectId}/${id}`, content);
  await env.DB.prepare(
    "INSERT INTO docs (id, title, project_id, author_id, folder_id, sidebar_position, tags, published_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)",
  ).bind(id, input.title, input.projectId, input.authorId, input.folderId, sidebarPosition, tags, now, now).run();
  await syncDocSlug(env, input.projectId, id, fm.slug);
  await upsertFtsRow(env.DB, id, input.projectId, input.title, content);

  // A new doc may be the target of references in other docs, so the whole
  // project's graph index must be recomputed.
  await invalidateProjectGraphIndex(env, input.projectId);

  return {
    id,
    title: input.title,
    content,
    projectId: input.projectId,
    authorId: input.authorId,
    folderId: input.folderId,
    publishedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

export interface DocUpdateRow {
  id: string;
  title: string;
  project_id: string;
  author_id: string;
  published_at: string | null;
  show_heading: number;
  show_last_updated: number;
  folder_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface DocUpdatePatch {
  title?: string;
  content?: string;
  publishedAt?: string | null;
  showHeading?: boolean;
  showLastUpdated?: boolean;
  folderId?: string | null;
  changelog?: string;
}

export interface DocUpdateResult {
  updated: DocUpdateRow;
  // Defined only when the body actually changed (a new revision was written).
  savedContent?: string;
}

// Returns the content of the doc's most recent revision, or null when the doc
// has no revisions at all. This is the "did the content change?" baseline for
// both applyDocUpdate and the collab DO's session-end checkpoint: the live R2
// body is NOT a reliable baseline because the collab Durable Object mirrors
// the Y.Doc text straight over it (~30s after the last edit), which would make
// an explicit save arriving after the mirror look like a no-op and silently
// skip the revision + changelog + reindex side effects.
export async function latestDocRevisionContent(env: Env, projectId: string, docId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT id FROM asset_revisions WHERE asset_type = 'doc' AND asset_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
  ).bind(docId).first<{ id: string }>();
  if (!row) return null;
  const obj = await env.ASSETS.get(`${projectId}/${docId}/v/${row.id}`);
  return obj ? await obj.text() : "";
}

export interface SnapshotDocRevisionInput {
  projectId: string;
  docId: string;
  content: string;
  // The doc's title as of this save - versioned alongside the body so a revert
  // can restore both.
  title: string;
  editorId: string;
  editorName: string;
  changelog?: string | null;
  contributors?: string | null;
  now?: string;
}

// The full revision side-effect chain, shared by applyDocUpdate (explicit
// saves) and DocCollabRoom's session-end checkpoint: R2 `v/` snapshot,
// asset_revisions row (with title), FTS reindex, doc-link graph reindex,
// AI-summary cache invalidation, and the docs.updated_at bump. Does NOT write
// the live R2 body - callers own that (applyDocUpdate writes it; the collab DO
// mirrors it from persist()).
export async function snapshotDocRevision(env: Env, input: SnapshotDocRevisionInput): Promise<string> {
  const now = input.now ?? new Date().toISOString();
  const revisionId = crypto.randomUUID();
  await env.ASSETS.put(`${input.projectId}/${input.docId}/v/${revisionId}`, input.content);
  await env.DB.prepare(
    "INSERT INTO asset_revisions (id, asset_type, asset_id, project_id, editor_id, editor_name, created_at, data, changelog, contributors, title) VALUES (?, 'doc', ?, ?, ?, ?, ?, NULL, ?, ?, ?)",
  ).bind(revisionId, input.docId, input.projectId, input.editorId, input.editorName, now, input.changelog ?? null, input.contributors ?? null, input.title).run();
  await upsertFtsRow(env.DB, input.docId, input.projectId, input.title, input.content);
  await indexDocLinks(env, input.projectId, input.docId, input.content);
  // Drop any cached AI summary - its version is the doc's updated_at at cache
  // time, and that is about to advance.
  await env.DB.prepare("DELETE FROM doc_ai_summaries WHERE doc_id = ?").bind(input.docId).run();
  // Sync the frontmatter-derived columns alongside the updated_at bump so
  // every revision-writing path (explicit save, collab checkpoint, restore)
  // keeps them consistent with the body it just persisted - the collab
  // checkpoint in particular never goes through applyDocUpdate.
  const fm = parseFrontmatter(input.content);
  await env.DB.prepare("UPDATE docs SET sidebar_position = ?, tags = ?, updated_at = ? WHERE id = ?")
    .bind(fm.sidebar_position ?? null, fm.tags ? JSON.stringify(fm.tags) : null, now, input.docId).run();
  await syncDocSlug(env, input.projectId, input.docId, fm.slug);
  return revisionId;
}

export interface ApplyDocUpdateOptions {
  // Invoked once, ONLY when the body actually changed, to produce the
  // contributors JSON stored on the new revision (the interactive collab path
  // also relies on this firing only-on-change for its DO-set-clearing side
  // effect). Omitted for programmatic edits, which have a single editor.
  gatherContributors?: () => Promise<string | null>;
}

// Applies an already-authorized patch to a doc.
export async function applyDocUpdate(
  env: Env,
  doc: DocUpdateRow,
  editorId: string,
  editorName: string,
  patch: DocUpdatePatch,
  opts: ApplyDocUpdateOptions = {},
): Promise<DocUpdateResult> {
  const now = new Date().toISOString();
  let savedContent: string | undefined;

  if (patch.content !== undefined) {
    // Baseline = latest revision's content (not the live R2 body - the collab
    // DO mirrors over that, which would make post-mirror explicit saves look
    // like no-ops). Docs with no revisions yet fall back to the live body.
    const baseline = await latestDocRevisionContent(env, doc.project_id, doc.id);
    const oldContent = baseline !== null ? baseline : await (async () => {
      const oldR2 = await env.ASSETS.get(`${doc.project_id}/${doc.id}`);
      return oldR2 ? await oldR2.text() : "";
    })();
    if (patch.content !== oldContent) {
      savedContent = patch.content;

      const contributorsJson = opts.gatherContributors ? await opts.gatherContributors() : null;
      // The live body may already hold this exact content (collab-mirrored
      // case) - writing it again is harmless and keeps this path simple.
      await env.ASSETS.put(`${doc.project_id}/${doc.id}`, patch.content);
      await snapshotDocRevision(env, {
        projectId: doc.project_id,
        docId: doc.id,
        content: patch.content,
        title: patch.title ?? doc.title,
        editorId,
        editorName,
        changelog: patch.changelog ?? null,
        contributors: contributorsJson,
        now,
      });
    }
  }

  const showHeading = patch.showHeading !== undefined ? (patch.showHeading ? 1 : 0) : null;
  const showLastUpdated = patch.showLastUpdated !== undefined ? (patch.showLastUpdated ? 1 : 0) : null;
  const newFm = patch.content !== undefined ? parseFrontmatter(patch.content) : undefined;
  const newSidebarPosition = newFm !== undefined ? (newFm.sidebar_position ?? null) : undefined;
  const newTags = newFm !== undefined ? (newFm.tags ? JSON.stringify(newFm.tags) : null) : undefined;

  // Build dynamic SET clause. Splitting published_at out of the COALESCE group
  // is required: an undefined publishedAt should leave the column untouched, but
  // null is a meaningful explicit unpublish, so we can't COALESCE there.
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (patch.title !== undefined) { sets.push("title = ?"); binds.push(patch.title); }
  if (patch.publishedAt !== undefined) { sets.push("published_at = ?"); binds.push(patch.publishedAt); }
  if (showHeading !== null) { sets.push("show_heading = ?"); binds.push(showHeading); }
  if (showLastUpdated !== null) { sets.push("show_last_updated = ?"); binds.push(showLastUpdated); }
  if (newSidebarPosition !== undefined) { sets.push("sidebar_position = ?"); binds.push(newSidebarPosition); }
  if (newTags !== undefined) { sets.push("tags = ?"); binds.push(newTags); }
  if (patch.folderId !== undefined) { sets.push("folder_id = ?"); binds.push(patch.folderId); }
  sets.push("updated_at = ?");
  binds.push(now);
  binds.push(doc.id);
  await env.DB.prepare(`UPDATE docs SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run();

  // Content provided but unchanged → snapshotDocRevision didn't run, so the
  // slug still needs syncing here (repairs docs whose column drifted, e.g.
  // saves from before the slug column existed).
  if (newFm !== undefined && savedContent === undefined) {
    await syncDocSlug(env, doc.project_id, doc.id, newFm.slug);
  }

  // Title or folder changes affect how *other* docs' wikilinks resolve, so the
  // project-wide index must be rebuilt.
  if ((patch.title && patch.title !== doc.title) || patch.folderId !== undefined) {
    await invalidateProjectGraphIndex(env, doc.project_id);
  }

  // Only re-index FTS when the body changed (title or content). Settings-only
  // toggles don't affect search. When the content changed, snapshotDocRevision
  // already reindexed with the final title, so only a title-only change needs
  // handling here (content fetched from the live body).
  if (patch.title !== undefined && savedContent === undefined) {
    const ftsContent = await (async () => {
      const r2 = await env.ASSETS.get(`${doc.project_id}/${doc.id}`);
      return r2 ? await r2.text() : "";
    })();
    await upsertFtsRow(env.DB, doc.id, doc.project_id, patch.title, ftsContent);
  }

  const updated: DocUpdateRow = {
    ...doc,
    title: patch.title ?? doc.title,
    published_at: patch.publishedAt !== undefined ? patch.publishedAt : doc.published_at,
    show_heading: showHeading !== null ? showHeading : doc.show_heading,
    show_last_updated: showLastUpdated !== null ? showLastUpdated : doc.show_last_updated,
    folder_id: patch.folderId !== undefined ? patch.folderId : doc.folder_id,
    updated_at: now,
  };

  return { updated, savedContent };
}

// Deletes every R2 object under `prefix`, in batches. One list() page is at
// most 1000 keys and the array form of delete() accepts up to 1000 keys, so
// each page maps to exactly one delete subrequest - a doc/project with
// thousands of revision objects stays far below the Workers subrequest limit
// (the old one-delete-per-D1-row fan-out did not). Listing by prefix (rather
// than by surviving D1 rows) also sweeps up objects orphaned by a failed
// insert, which previously leaked forever.
export async function deleteR2Prefix(assets: R2Bucket, prefix: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const listing = await assets.list({ prefix, cursor });
    if (listing.objects.length > 0) {
      await assets.delete(listing.objects.map(o => o.key));
    }
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor !== undefined);
}

// How long non-latest doc revisions are kept.
export const REVISION_RETENTION_DAYS = 90;

// Prunes doc revisions older than the retention window. The newest revision
// per doc is ALWAYS kept regardless of age: it is the "did the content
// change?" baseline for applyDocUpdate and the collab checkpoint (see
// latestDocRevisionContent) - pruning it would resurrect the collab-mirror
// no-op-save bug on dormant docs, and would leave stale docs with no history
// at all. Runs from the API worker's daily cron. Each pass selects up to
// `batch` rows, deletes their R2 snapshots in one array call, then their D1
// rows in chunks; `maxBatches` bounds a single invocation's subrequests, so a
// large backlog drains over successive runs. R2 objects are deleted before
// their rows - if the row delete fails, the survivors are reselected next run
// (and re-deleting a missing R2 key is a no-op), so the order self-heals.
export async function pruneDocRevisions(
  env: Env,
  opts: { now?: Date; batch?: number; maxBatches?: number } = {},
): Promise<number> {
  const batch = opts.batch ?? 500;
  const maxBatches = opts.maxBatches ?? 20;
  const cutoff = new Date((opts.now ?? new Date()).getTime() - REVISION_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  let pruned = 0;
  for (let i = 0; i < maxBatches; i++) {
    const rows = await env.DB.prepare(
      `SELECT id, project_id, asset_id FROM (
         SELECT id, project_id, asset_id, created_at,
                ROW_NUMBER() OVER (PARTITION BY asset_id ORDER BY created_at DESC, id DESC) AS rn
         FROM asset_revisions WHERE asset_type = 'doc'
       ) WHERE rn > 1 AND created_at < ? LIMIT ?`,
    ).bind(cutoff, batch).all<{ id: string; project_id: string; asset_id: string }>();
    if (rows.results.length === 0) break;

    await env.ASSETS.delete(rows.results.map(r => `${r.project_id}/${r.asset_id}/v/${r.id}`));
    for (let j = 0; j < rows.results.length; j += 50) {
      const chunk = rows.results.slice(j, j + 50);
      await env.DB.prepare(
        `DELETE FROM asset_revisions WHERE id IN (${chunk.map(() => "?").join(",")})`,
      ).bind(...chunk.map(r => r.id)).run();
    }
    pruned += rows.results.length;
    if (rows.results.length < batch) break;
  }
  return pruned;
}

// Deletes a doc and everything keyed off it: R2 body + every revision object,
// the docs row, asset_revisions (no FK to docs, so it never cascades),
// doc_shares, the FTS row, and the collab DO room. The graph is reindexed
// because a removed title may have shadowed another doc's wikilink resolution.
// The caller must enforce permission and any preconditions (e.g. home-doc).
export async function deleteDoc(env: Env, docId: string, projectId: string): Promise<void> {
  await env.ASSETS.delete(`${projectId}/${docId}`);
  await deleteR2Prefix(env.ASSETS, `${projectId}/${docId}/v/`);
  await env.DB.prepare("DELETE FROM docs WHERE id = ?").bind(docId).run();
  await env.DB.prepare("DELETE FROM asset_revisions WHERE asset_type = 'doc' AND asset_id = ?").bind(docId).run();
  await env.DB.prepare("DELETE FROM doc_shares WHERE doc_id = ?").bind(docId).run();
  await deleteFtsRow(env.DB, docId);
  await invalidateProjectGraphIndex(env, projectId);

  if (env.DOC_COLLAB) {
    try {
      const roomId = env.DOC_COLLAB.idFromName(`${projectId}:${docId}`);
      await env.DOC_COLLAB.get(roomId).fetch(new Request("https://internal/", { method: "DELETE" }));
    } catch { /* non-fatal - room may never have been created */ }
  }
}
