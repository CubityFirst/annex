import { okResponse, errorResponse, Errors, ProjectFeatures, ROLE_RANK, folderInProject, type Session, type Doc } from "../lib";
import { parseFrontmatter } from "../lib/frontmatter";
import { createDoc, applyDocUpdate, deleteDoc, type DocUpdateRow } from "../lib/docOps";
import type { Env } from "../index";
import { resolveAccess } from "../lib/access";

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

  // GET /docs/:id/revisions/:revisionId - any member (limited must have a doc_share)
  if (docId && subResource === "revisions" && subId && request.method === "GET") {
    const meta = await env.DB.prepare("SELECT project_id FROM docs WHERE id = ?").bind(docId).first<{ project_id: string }>();
    if (!meta) return errorResponse(Errors.NOT_FOUND);
    const caller = await resolveAccess(env.DB, meta.project_id, user.userId);
    if (caller === null) return errorResponse(Errors.FORBIDDEN);
    if (caller.role === "limited") {
      const share = await env.DB.prepare("SELECT id FROM doc_shares WHERE doc_id = ? AND user_id = ?").bind(docId, user.userId).first();
      if (!share) return errorResponse(Errors.FORBIDDEN);
    }
    const revision = await env.DB.prepare(
      "SELECT id, editor_id, editor_name, created_at, changelog, contributors FROM asset_revisions WHERE id = ? AND asset_type = 'doc' AND asset_id = ?",
    ).bind(subId, docId).first<{ id: string; editor_id: string; editor_name: string; created_at: string; changelog: string | null; contributors: string | null }>();
    if (!revision) return errorResponse(Errors.NOT_FOUND);
    const r2Object = await env.ASSETS.get(`${meta.project_id}/${docId}/v/${subId}`);
    const content = r2Object ? await r2Object.text() : "";
    return okResponse({ ...revision, content });
  }

  // GET /docs/:id/revisions - any member (limited must have a doc_share)
  if (docId && subResource === "revisions" && !subId && request.method === "GET") {
    const meta = await env.DB.prepare("SELECT project_id FROM docs WHERE id = ?").bind(docId).first<{ project_id: string }>();
    if (!meta) return errorResponse(Errors.NOT_FOUND);
    const caller = await resolveAccess(env.DB, meta.project_id, user.userId);
    if (caller === null) return errorResponse(Errors.FORBIDDEN);
    if (caller.role === "limited") {
      const share = await env.DB.prepare("SELECT id FROM doc_shares WHERE doc_id = ? AND user_id = ?").bind(docId, user.userId).first();
      if (!share) return errorResponse(Errors.FORBIDDEN);
    }
    const rows = await env.DB.prepare(
      "SELECT id, editor_id, editor_name, created_at, changelog, contributors FROM asset_revisions WHERE asset_type = 'doc' AND asset_id = ? ORDER BY created_at DESC",
    ).bind(docId).all<{ id: string; editor_id: string; editor_name: string; created_at: string; changelog: string | null; contributors: string | null }>();
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
      `SELECT d.id, d.title, d.project_id, d.author_id, d.published_at,
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
      gatherContributors: async () => {
        if (!env.DOC_COLLAB) return null;
        try {
          const roomId = env.DOC_COLLAB.idFromName(`${doc.project_id}:${docId}`);
          const resp = await env.DOC_COLLAB.get(roomId).fetch(new Request("https://internal/contributors"));
          if (resp.ok) {
            const { editors } = await resp.json<{ editors: { id: string; name: string }[] }>();
            const all = [
              { id: user.userId, name: caller.name },
              ...editors.filter(e => e.id !== user.userId),
            ];
            if (all.length > 1) return JSON.stringify(all);
          }
        } catch { /* non-fatal */ }
        return null;
      },
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
