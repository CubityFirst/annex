import { okResponse, errorResponse, Errors, ProjectFeatures, ROLE_RANK, folderInProject, type Session, type Doc } from "../lib";
import { parseFrontmatter } from "../lib/frontmatter";
import { createDoc, applyDocUpdate, deleteDoc, snapshotDocRevision, type DocUpdateRow, type DocUpdatePatch } from "../lib/docOps";
import type { Env } from "../index";
import { resolveAccess } from "../lib/access";

interface RevisionRow {
  id: string;
  editor_id: string;
  editor_name: string;
  created_at: string;
  changelog: string | null;
  contributors: string | null;
  title: string | null;
}

// Builds the gatherContributors callback shared by the content PUT and the
// revision-restore endpoint: collects (and clears) the collab DO's tracked
// editor set so a revision written after a realtime session credits everyone
// who typed. applyDocUpdate invokes it only when the body actually changed.
function collabContributorsGatherer(
  env: Env,
  projectId: string,
  docId: string,
  userId: string,
  userName: string,
): () => Promise<string | null> {
  return async () => {
    if (!env.DOC_COLLAB) return null;
    try {
      const roomId = env.DOC_COLLAB.idFromName(`${projectId}:${docId}`);
      const resp = await env.DOC_COLLAB.get(roomId).fetch(new Request("https://internal/contributors"));
      if (resp.ok) {
        const { editors } = await resp.json<{ editors: { id: string; name: string }[] }>();
        const all = [
          { id: userId, name: userName },
          ...editors.filter(e => e.id !== userId),
        ];
        if (all.length > 1) return JSON.stringify(all);
      }
    } catch { /* non-fatal */ }
    return null;
  };
}

export async function handleDocs(
  request: Request,
  env: Env,
  user: Session,
  url: URL,
): Promise<Response> {
  const parts = url.pathname.replace(/^\/docs\/?/, "").split("/");
  const docId = parts[0] || null;
  const subResource = parts[1] || null;
  const subId = parts[2] || null;
  const params = url.searchParams;

  // GET /docs?projectId=xxx[&folderId=yyy] - any member
  if (!docId && request.method === "GET") {
    const projectId = params.get("projectId");
    if (!projectId) return errorResponse(Errors.BAD_REQUEST);

    const caller = await resolveAccess(env.DB, projectId, user.userId);
    if (caller === null) return errorResponse(Errors.FORBIDDEN);
    const role = caller.role;

    const folderId = params.get("folderId");
    const q = params.get("q");
    const isLimitedViewer = role === "limited";

    type DocWithAuthor = Doc & { author_name: string; author_role: string | null; is_home: number };

    const docWithAuthor = (sharesJoin: boolean) => `
      SELECT d.id, d.title, d.folder_id, d.author_id, d.created_at, d.updated_at, d.sidebar_position, d.tags,
        COALESCE(pm.name, d.author_id) AS author_name,
        pm.role AS author_role,
        CASE WHEN p.home_doc_id = d.id THEN 1 ELSE 0 END AS is_home
      FROM docs d
      LEFT JOIN project_members pm ON pm.project_id = d.project_id AND pm.user_id = d.author_id
      LEFT JOIN projects p ON p.id = d.project_id
      ${sharesJoin ? "JOIN doc_shares ds ON ds.doc_id = d.id AND ds.user_id = ?" : ""}
    `;
    const lv = isLimitedViewer;

    if (q) {
      const rootFolderId = params.get("rootFolderId");
      let rows;
      if (rootFolderId) {
        rows = await env.DB.prepare(`
          WITH RECURSIVE subtree(id) AS (
            SELECT id FROM folders WHERE id = ?
            UNION ALL
            SELECT f.id FROM folders f JOIN subtree s ON f.parent_id = s.id
          )
          ${docWithAuthor(lv)}
          WHERE d.project_id = ? AND d.folder_id IN (SELECT id FROM subtree)
            AND (LOWER(d.title) LIKE LOWER(?) OR LOWER(COALESCE(pm.name, d.author_id)) LIKE LOWER(?))
          ORDER BY CASE WHEN d.sidebar_position IS NULL THEN 1 ELSE 0 END, d.sidebar_position ASC, d.title ASC
        `).bind(...(lv ? [user.userId] : []), rootFolderId, projectId, `%${q}%`, `%${q}%`).all<DocWithAuthor>();
      } else {
        rows = await env.DB.prepare(`${docWithAuthor(lv)} WHERE d.project_id = ? AND (LOWER(d.title) LIKE LOWER(?) OR LOWER(COALESCE(pm.name, d.author_id)) LIKE LOWER(?)) ORDER BY CASE WHEN d.sidebar_position IS NULL THEN 1 ELSE 0 END, d.sidebar_position ASC, d.title ASC`)
          .bind(...(lv ? [user.userId] : []), projectId, `%${q}%`, `%${q}%`).all<DocWithAuthor>();
      }
      return okResponse(rows.results);
    }

    const rows = folderId
      ? await env.DB.prepare(`${docWithAuthor(lv)} WHERE d.project_id = ? AND d.folder_id = ? ORDER BY CASE WHEN d.sidebar_position IS NULL THEN 1 ELSE 0 END, d.sidebar_position ASC, d.title ASC`)
          .bind(...(lv ? [user.userId] : []), projectId, folderId).all<DocWithAuthor>()
      : params.has("folderId")
        ? await env.DB.prepare(`${docWithAuthor(lv)} WHERE d.project_id = ? AND d.folder_id IS NULL ORDER BY CASE WHEN d.sidebar_position IS NULL THEN 1 ELSE 0 END, d.sidebar_position ASC, d.title ASC`)
            .bind(...(lv ? [user.userId] : []), projectId).all<DocWithAuthor>()
        : await env.DB.prepare(`${docWithAuthor(lv)} WHERE d.project_id = ? ORDER BY d.created_at DESC`)
            .bind(...(lv ? [user.userId] : []), projectId).all<DocWithAuthor>();
    return okResponse(rows.results);
  }

  // POST /docs - editor or above
  if (!docId && request.method === "POST") {
    const body = await request.json<{ title: string; content: string; projectId: string; folderId?: string | null }>();
    if (!body.title || !body.projectId) return errorResponse(Errors.BAD_REQUEST);

    const caller = await resolveAccess(env.DB, body.projectId, user.userId);
    if (caller === null) return errorResponse(Errors.FORBIDDEN);
    if (ROLE_RANK[caller.role] < ROLE_RANK["editor"]) return errorResponse(Errors.FORBIDDEN);

    const folderId = body.folderId ?? null;
    // Target folder (if any) must belong to this project and be a docs folder.
    if (!(await folderInProject(env.DB, folderId, body.projectId, "docs"))) {
      return errorResponse(Errors.BAD_REQUEST);
    }

    const created = await createDoc(env, {
      projectId: body.projectId,
      authorId: user.userId,
      title: body.title,
      content: body.content ?? "",
      folderId,
    });
    return okResponse(created, 201);
  }

  // POST /docs/:id/collab/reset - editor or above; wipes the collab DO so a frozen room
  // (state size cap exceeded) can recover. The next WS connection creates a fresh DO,
  // and the connecting client seeds it from R2's saved markdown.
  if (docId && subResource === "collab" && subId === "reset" && request.method === "POST") {
    const meta = await env.DB.prepare("SELECT project_id FROM docs WHERE id = ?").bind(docId).first<{ project_id: string }>();
    if (!meta) return errorResponse(Errors.NOT_FOUND);

    const project = await env.DB.prepare("SELECT features FROM projects WHERE id = ?").bind(meta.project_id).first<{ features: number }>();
    if (!project) return errorResponse(Errors.NOT_FOUND);
    if (!(project.features & ProjectFeatures.REALTIME)) return errorResponse(Errors.FORBIDDEN);

    const caller = await resolveAccess(env.DB, meta.project_id, user.userId);
    if (caller === null) return errorResponse(Errors.FORBIDDEN);
    if (ROLE_RANK[caller.role] < ROLE_RANK["editor"]) return errorResponse(Errors.FORBIDDEN);

    if (env.DOC_COLLAB) {
      try {
        const roomId = env.DOC_COLLAB.idFromName(`${meta.project_id}:${docId}`);
        await env.DOC_COLLAB.get(roomId).fetch(new Request("https://internal/", { method: "DELETE" }));
      } catch (err) {
        console.error("[docs/collab/reset] DO reset failed:", err);
        return errorResponse(Errors.INTERNAL);
      }
    }

    return okResponse({ ok: true });
  }

  // POST /docs/:id/revisions/:revisionId/restore - same gate as the content
  // PUT: editor+ OR a doc_share with permission = 'edit'. Applies the stored
  // revision's content (and title, when captured) through applyDocUpdate so
  // the restore itself becomes a new revision with a changelog, instead of the
  // client re-PUTting downloaded content.
  if (docId && subResource === "revisions" && subId && parts[3] === "restore" && !parts[4] && request.method === "POST") {
    const doc = await env.DB.prepare("SELECT * FROM docs WHERE id = ?").bind(docId).first<DocUpdateRow>();
    if (!doc) return errorResponse(Errors.NOT_FOUND);

    const caller = await resolveAccess(env.DB, doc.project_id, user.userId);
    if (caller === null) return errorResponse(Errors.FORBIDDEN);
    if (ROLE_RANK[caller.role] < ROLE_RANK["editor"]) {
      const share = await env.DB.prepare("SELECT permission FROM doc_shares WHERE doc_id = ? AND user_id = ?")
        .bind(docId, user.userId).first<{ permission: string }>();
      if (!share || share.permission !== "edit") return errorResponse(Errors.FORBIDDEN);
    }

    const revision = await env.DB.prepare(
      "SELECT id, title, created_at FROM asset_revisions WHERE id = ? AND asset_type = 'doc' AND asset_id = ?",
    ).bind(subId, docId).first<{ id: string; title: string | null; created_at: string }>();
    if (!revision) return errorResponse(Errors.NOT_FOUND);
    // Unlike the read path (which renders a missing snapshot as ""), the
    // write path must fail hard: restoring an orphaned revision row would
    // silently wipe the live doc to empty.
    const r2Object = await env.ASSETS.get(`${doc.project_id}/${docId}/v/${subId}`);
    if (!r2Object) return errorResponse(Errors.NOT_FOUND);
    const content = await r2Object.text();

    let changelog: string | undefined;
    try {
      const body = await request.json<{ changelog?: string }>();
      if (typeof body?.changelog === "string" && body.changelog.trim() !== "") changelog = body.changelog;
    } catch { /* empty or non-JSON body - use the auto changelog */ }
    if (changelog === undefined) changelog = `Restored version from ${revision.created_at}`;

    const patch: DocUpdatePatch = { content, changelog };
    // Old revisions (pre-title-versioning) have a NULL title - leave the
    // current title untouched for those.
    if (revision.title !== null) patch.title = revision.title;

    const { updated, savedContent } = await applyDocUpdate(env, doc, user.userId, caller.name, patch, {
      gatherContributors: collabContributorsGatherer(env, doc.project_id, docId, user.userId, caller.name),
    });

    // A title-only restore (content already matches the latest revision)
    // still mutates the doc, so it must leave a history entry - applyDocUpdate
    // only writes revisions on content changes, which would otherwise drop
    // this restore's changelog and record nothing.
    if (savedContent === undefined && patch.title !== undefined && patch.title !== doc.title) {
      await snapshotDocRevision(env, {
        projectId: doc.project_id,
        docId,
        content,
        title: patch.title,
        editorId: user.userId,
        editorName: caller.name,
        changelog,
      });
    }

    // Same shape as the PUT. Restoring the already-current content and title
    // is a valid no-op: the doc is returned without content and no revision
    // is written.
    return okResponse(savedContent !== undefined ? { ...updated, content: savedContent } : updated);
  }

  // GET /docs/:id/revisions/:revisionId - any member (limited must have a doc_share)
  if (docId && subResource === "revisions" && subId && !parts[3] && request.method === "GET") {
    const meta = await env.DB.prepare("SELECT project_id FROM docs WHERE id = ?").bind(docId).first<{ project_id: string }>();
    if (!meta) return errorResponse(Errors.NOT_FOUND);
    const caller = await resolveAccess(env.DB, meta.project_id, user.userId);
    if (caller === null) return errorResponse(Errors.FORBIDDEN);
    if (caller.role === "limited") {
      const share = await env.DB.prepare("SELECT id FROM doc_shares WHERE doc_id = ? AND user_id = ?").bind(docId, user.userId).first();
      if (!share) return errorResponse(Errors.FORBIDDEN);
    }
    const revision = await env.DB.prepare(
      "SELECT id, editor_id, editor_name, created_at, changelog, contributors, title FROM asset_revisions WHERE id = ? AND asset_type = 'doc' AND asset_id = ?",
    ).bind(subId, docId).first<RevisionRow>();
    if (!revision) return errorResponse(Errors.NOT_FOUND);
    const r2Object = await env.ASSETS.get(`${meta.project_id}/${docId}/v/${subId}`);
    const content = r2Object ? await r2Object.text() : "";
    return okResponse({ ...revision, content });
  }

  // GET /docs/:id/revisions[?limit=N&before=ISO&beforeId=ID] - any member
  // (limited must have a doc_share). Keyset-paginated: when before+beforeId
  // are given, returns only rows strictly older than that (created_at, id)
  // pair. Response stays a plain array; clients infer another page when they
  // receive exactly `limit` rows.
  if (docId && subResource === "revisions" && !subId && request.method === "GET") {
    const meta = await env.DB.prepare("SELECT project_id FROM docs WHERE id = ?").bind(docId).first<{ project_id: string }>();
    if (!meta) return errorResponse(Errors.NOT_FOUND);
    const caller = await resolveAccess(env.DB, meta.project_id, user.userId);
    if (caller === null) return errorResponse(Errors.FORBIDDEN);
    if (caller.role === "limited") {
      const share = await env.DB.prepare("SELECT id FROM doc_shares WHERE doc_id = ? AND user_id = ?").bind(docId, user.userId).first();
      if (!share) return errorResponse(Errors.FORBIDDEN);
    }
    const limitRaw = parseInt(params.get("limit") ?? "", 10);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;
    const before = params.get("before");
    const beforeId = params.get("beforeId");
    const rows = before && beforeId
      ? await env.DB.prepare(
          "SELECT id, editor_id, editor_name, created_at, changelog, contributors, title FROM asset_revisions WHERE asset_type = 'doc' AND asset_id = ? AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT ?",
        ).bind(docId, before, before, beforeId, limit).all<RevisionRow>()
      : await env.DB.prepare(
          "SELECT id, editor_id, editor_name, created_at, changelog, contributors, title FROM asset_revisions WHERE asset_type = 'doc' AND asset_id = ? ORDER BY created_at DESC, id DESC LIMIT ?",
        ).bind(docId, limit).all<RevisionRow>();
    return okResponse(rows.results);
  }

  // GET /docs/:id - any member of the doc's project (limited must have a doc_share)
  if (docId && request.method === "GET") {
    const meta = await env.DB.prepare("SELECT project_id FROM docs WHERE id = ?").bind(docId).first<{ project_id: string }>();
    if (!meta) return errorResponse(Errors.NOT_FOUND);
    const caller = await resolveAccess(env.DB, meta.project_id, user.userId);
    if (caller === null) return errorResponse(Errors.FORBIDDEN);
    let myPermission: string | null = null;
    // limited has no project-wide read access - a doc_share is required.
    // viewer already reads everything, but a doc_share with permission='edit' uplifts them on this doc.
    if (caller.role === "limited" || caller.role === "viewer") {
      const share = await env.DB.prepare("SELECT permission FROM doc_shares WHERE doc_id = ? AND user_id = ?").bind(docId, user.userId).first<{ permission: string }>();
      if (caller.role === "limited" && !share) return errorResponse(Errors.FORBIDDEN);
      myPermission = share?.permission ?? null;
    }
    const row = await env.DB.prepare(
      `SELECT d.id, d.slug, d.title, d.project_id, d.author_id, d.published_at,
              d.show_heading, d.show_last_updated, d.folder_id,
              d.sidebar_position, d.tags, d.created_at, d.updated_at,
              s.summary AS ai_summary, s.version AS ai_summary_version
       FROM docs d
       LEFT JOIN doc_ai_summaries s ON s.doc_id = d.id
       WHERE d.id = ?`,
    ).bind(docId).first<Doc>();
    if (!row) return errorResponse(Errors.NOT_FOUND);
    const r2Content = await env.ASSETS.get(`${meta.project_id}/${docId}`);
    const content = r2Content ? await r2Content.text() : "";
    const fm = parseFrontmatter(content);
    const display_title = fm.title ?? null;
    const hide_title = fm.hide_title ?? null;
    const description = fm.description ?? null;
    const image = fm.image ?? null;
    return okResponse({ ...row, content, myRole: caller.role, myPermission, display_title, hide_title, description, image });
  }

  // PUT /docs/:id - editor or above
  if (docId && request.method === "PUT") {
    const doc = await env.DB.prepare("SELECT * FROM docs WHERE id = ?").bind(docId).first<DocUpdateRow>();
    if (!doc) return errorResponse(Errors.NOT_FOUND);

    const caller = await resolveAccess(env.DB, doc.project_id, user.userId);
    if (caller === null) return errorResponse(Errors.FORBIDDEN);
    const isUpliftedEdit = ROLE_RANK[caller.role] < ROLE_RANK["editor"];
    if (isUpliftedEdit) {
      const share = await env.DB.prepare("SELECT permission FROM doc_shares WHERE doc_id = ? AND user_id = ?")
        .bind(docId, user.userId).first<{ permission: string }>();
      if (!share || share.permission !== "edit") return errorResponse(Errors.FORBIDDEN);
    }

    const body = await request.json<Partial<{ title: string; content: string; publishedAt: string | null; showHeading: boolean; showLastUpdated: boolean; folderId: string | null; changelog: string }>>();

    // Per-doc edit grants are content-only; structural changes (publish, move) still require project-level editor+.
    if (isUpliftedEdit) {
      delete body.publishedAt;
      delete body.folderId;
    }

    // A move must target a folder in this doc's own project (and a docs folder).
    if (body.folderId !== undefined && !(await folderInProject(env.DB, body.folderId, doc.project_id, "docs"))) {
      return errorResponse(Errors.BAD_REQUEST);
    }

    const { updated, savedContent } = await applyDocUpdate(env, doc, user.userId, caller.name, body, {
      // Collect collab contributors (clears the DO's tracked set for the next
      // session). Runs only when the body actually changed.
      gatherContributors: collabContributorsGatherer(env, doc.project_id, docId, user.userId, caller.name),
    });

    // Only echo content when it was sent. Clients toggling settings already
    // have the content locally and merge non-content fields into existing state.
    return okResponse(savedContent !== undefined ? { ...updated, content: savedContent } : updated);
  }

  // DELETE /docs/:id - editor or above
  if (docId && request.method === "DELETE") {
    const doc = await env.DB.prepare("SELECT project_id FROM docs WHERE id = ?").bind(docId).first<{ project_id: string }>();
    if (!doc) return errorResponse(Errors.NOT_FOUND);

    const caller = await resolveAccess(env.DB, doc.project_id, user.userId);
    if (caller === null) return errorResponse(Errors.FORBIDDEN);
    if (ROLE_RANK[caller.role] < ROLE_RANK["editor"]) return errorResponse(Errors.FORBIDDEN);

    const proj = await env.DB.prepare("SELECT home_doc_id FROM projects WHERE id = ?").bind(doc.project_id).first<{ home_doc_id: string | null }>();
    if (proj?.home_doc_id === docId) return errorResponse(Errors.FORBIDDEN);

    await deleteDoc(env, docId, doc.project_id);
    return okResponse({ deleted: true });
  }

  return errorResponse(Errors.NOT_FOUND);
}
