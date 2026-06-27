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
    const oldR2 = await env.ASSETS.get(`${doc.project_id}/${doc.id}`);
    const oldContent = oldR2 ? await oldR2.text() : "";
    if (patch.content !== oldContent) {
      savedContent = patch.content;

      const contributorsJson = opts.gatherContributors ? await opts.gatherContributors() : null;
      const revisionId = crypto.randomUUID();
      await Promise.all([
        env.ASSETS.put(`${doc.project_id}/${doc.id}`, patch.content),
        env.ASSETS.put(`${doc.project_id}/${doc.id}/v/${revisionId}`, patch.content),
      ]);
      await env.DB.prepare(
        "INSERT INTO asset_revisions (id, asset_type, asset_id, project_id, editor_id, editor_name, created_at, data, changelog, contributors) VALUES (?, 'doc', ?, ?, ?, ?, ?, NULL, ?, ?)",
      ).bind(revisionId, doc.id, doc.project_id, editorId, editorName, now, patch.changelog ?? null, contributorsJson).run();
      await indexDocLinks(env, doc.project_id, doc.id, patch.content);
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

  // Title or folder changes affect how *other* docs' wikilinks resolve, so the
  // project-wide index must be rebuilt.
  if ((patch.title && patch.title !== doc.title) || patch.folderId !== undefined) {
    await invalidateProjectGraphIndex(env, doc.project_id);
  }

  // Only re-index FTS when the body changed (title or content). Settings-only
  // toggles don't affect search.
  if (patch.title !== undefined || savedContent !== undefined) {
    const ftsContent = savedContent ?? (await (async () => {
      const r2 = await env.ASSETS.get(`${doc.project_id}/${doc.id}`);
      return r2 ? await r2.text() : "";
    })());
    await upsertFtsRow(env.DB, doc.id, doc.project_id, patch.title ?? doc.title, ftsContent);
  }

  // Drop any cached AI summary when the body changed - its version is the doc's
  // updated_at at cache time, and that just advanced.
  if (savedContent !== undefined) {
    await env.DB.prepare("DELETE FROM doc_ai_summaries WHERE doc_id = ?").bind(doc.id).run();
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

// Deletes a doc and everything keyed off it: R2 body + every revision object,
// the docs row, asset_revisions (no FK to docs, so it never cascades),
// doc_shares, the FTS row, and the collab DO room. The graph is reindexed
// because a removed title may have shadowed another doc's wikilink resolution.
// The caller must enforce permission and any preconditions (e.g. home-doc).
export async function deleteDoc(env: Env, docId: string, projectId: string): Promise<void> {
  const revisions = await env.DB.prepare("SELECT id FROM asset_revisions WHERE asset_type = 'doc' AND asset_id = ?")
    .bind(docId).all<{ id: string }>();
  await Promise.all([
    env.ASSETS.delete(`${projectId}/${docId}`),
    ...revisions.results.map(r => env.ASSETS.delete(`${projectId}/${docId}/v/${r.id}`)),
  ]);
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
