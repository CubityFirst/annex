import { okResponse, errorResponse, Errors, ProjectFeatures, ROLE_RANK, type Session, type Doc, type Role } from "../lib";
import { parseFrontmatter } from "../lib/frontmatter";
import { indexDocLinks, invalidateProjectGraphIndex } from "../lib/docLinks";
import { upsertFtsRow, deleteFtsRow } from "../lib/fts";
import type { Env } from "../index";

async function getCallerInfo(db: D1Database, projectId: string, userId: string): Promise<{ role: Role; name: string } | null> {
  const row = await db.prepare("SELECT role, name FROM project_members WHERE project_id = ? AND user_id = ? AND accepted = 1")
    .bind(projectId, userId).first<{ role: Role; name: string }>();
  return row ? { role: row.role, name: row.name } : null;
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

  // GET /docs?projectId=xxx[&folderId=yyy] — any member
  if (!docId && request.method === "GET") {
    const projectId = params.get("projectId");
    if (!projectId) return errorResponse(Errors.BAD_REQUEST);

    const caller = await getCallerInfo(env.DB, projectId, user.userId);
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

  // POST /docs — editor or above
  if (!docId && request.method === "POST") {
    const body = await request.json<{ title: string; content: string; projectId: string; folderId?: string | null }>();
    if (!body.title || !body.projectId) return errorResponse(Errors.BAD_REQUEST);

    const caller = await getCallerInfo(env.DB, body.projectId, user.userId);
    if (caller === null) return errorResponse(Errors.FORBIDDEN);
    if (ROLE_RANK[caller.role] < ROLE_RANK["editor"]) return errorResponse(Errors.FORBIDDEN);

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const content = body.content ?? "";
    const folderId = body.folderId ?? null;
    const fm = parseFrontmatter(content);
    const sidebarPosition = fm.sidebar_position ?? null;
    const tags = fm.tags ? JSON.stringify(fm.tags) : null;

    await env.ASSETS.put(`${body.projectId}/${id}`, content);
    await env.DB.prepare(
      "INSERT INTO docs (id, title, project_id, author_id, folder_id, sidebar_position, tags, published_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)",
    ).bind(id, body.title, body.projectId, user.userId, folderId, sidebarPosition, tags, now, now).run();
    await upsertFtsRow(env.DB, id, body.projectId, body.title, content);

    // A new doc may be the target of references in other docs, so the whole project's graph index must be recomputed.
    await invalidateProjectGraphIndex(env, body.projectId);

    return okResponse(
      { id, title: body.title, content, projectId: body.projectId, authorId: user.userId, folderId, publishedAt: null, createdAt: now, updatedAt: now },
      201,
    );
  }

  // POST /docs/:id/collab/reset — editor or above; wipes the collab DO so a frozen room
  // (state size cap exceeded) can recover. The next WS connection creates a fresh DO,
  // and the connecting client seeds it from R2's saved markdown.
  if (docId && subResource === "collab" && subId === "reset" && request.method === "POST") {
    const meta = await env.DB.prepare("SELECT project_id FROM docs WHERE id = ?").bind(docId).first<{ project_id: string }>();
    if (!meta) return errorResponse(Errors.NOT_FOUND);

    const project = await env.DB.prepare("SELECT features FROM projects WHERE id = ?").bind(meta.project_id).first<{ features: number }>();
    if (!project) return errorResponse(Errors.NOT_FOUND);
    if (!(project.features & ProjectFeatures.REALTIME)) return errorResponse(Errors.FORBIDDEN);

    const caller = await getCallerInfo(env.DB, meta.project_id, user.userId);
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

  // GET /docs/:id/revisions/:revisionId — any member (limited must have a doc_share)
  if (docId && subResource === "revisions" && subId && request.method === "GET") {
    const meta = await env.DB.prepare("SELECT project_id FROM docs WHERE id = ?").bind(docId).first<{ project_id: string }>();
    if (!meta) return errorResponse(Errors.NOT_FOUND);
    const caller = await getCallerInfo(env.DB, meta.project_id, user.userId);
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

  // GET /docs/:id/revisions — any member (limited must have a doc_share)
  if (docId && subResource === "revisions" && !subId && request.method === "GET") {
    const meta = await env.DB.prepare("SELECT project_id FROM docs WHERE id = ?").bind(docId).first<{ project_id: string }>();
    if (!meta) return errorResponse(Errors.NOT_FOUND);
    const caller = await getCallerInfo(env.DB, meta.project_id, user.userId);
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

  // GET /docs/:id — any member of the doc's project (limited must have a doc_share)
  if (docId && request.method === "GET") {
    const meta = await env.DB.prepare("SELECT project_id FROM docs WHERE id = ?").bind(docId).first<{ project_id: string }>();
    if (!meta) return errorResponse(Errors.NOT_FOUND);
    const caller = await getCallerInfo(env.DB, meta.project_id, user.userId);
    if (caller === null) return errorResponse(Errors.FORBIDDEN);
    let myPermission: string | null = null;
    // limited has no project-wide read access — a doc_share is required.
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

  // PUT /docs/:id — editor or above
  if (docId && request.method === "PUT") {
    type DocRow = { id: string; title: string; project_id: string; author_id: string; published_at: string | null; show_heading: number; show_last_updated: number; folder_id: string | null; created_at: string; updated_at: string };
    const doc = await env.DB.prepare("SELECT * FROM docs WHERE id = ?").bind(docId).first<DocRow>();
    if (!doc) return errorResponse(Errors.NOT_FOUND);

    const caller = await getCallerInfo(env.DB, doc.project_id, user.userId);
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

    const now = new Date().toISOString();
    let savedContent: string | undefined;

    if (body.content !== undefined) {
      const oldR2 = await env.ASSETS.get(`${doc.project_id}/${docId}`);
      const oldContent = oldR2 ? await oldR2.text() : "";
      if (body.content !== oldContent) {
        savedContent = body.content;

        // Collect collab contributors (clears the DO's tracked set for the next session)
        let contributorsJson: string | null = null;
        if (env.DOC_COLLAB) {
          try {
            const roomId = env.DOC_COLLAB.idFromName(`${doc.project_id}:${docId}`);
            const resp = await env.DOC_COLLAB.get(roomId).fetch(
              new Request("https://internal/contributors"),
            );
            if (resp.ok) {
              const { editors } = await resp.json<{ editors: { id: string; name: string }[] }>();
              const all = [
                { id: user.userId, name: caller.name },
                ...editors.filter(e => e.id !== user.userId),
              ];
              if (all.length > 1) contributorsJson = JSON.stringify(all);
            }
          } catch { /* non-fatal */ }
        }

        const revisionId = crypto.randomUUID();
        await Promise.all([
          env.ASSETS.put(`${doc.project_id}/${docId}`, body.content),
          env.ASSETS.put(`${doc.project_id}/${docId}/v/${revisionId}`, body.content),
        ]);
        await env.DB.prepare(
          "INSERT INTO asset_revisions (id, asset_type, asset_id, project_id, editor_id, editor_name, created_at, data, changelog, contributors) VALUES (?, 'doc', ?, ?, ?, ?, ?, NULL, ?, ?)",
        ).bind(revisionId, docId, doc.project_id, user.userId, caller.name, now, body.changelog ?? null, contributorsJson).run();
        await indexDocLinks(env, doc.project_id, docId, body.content);
      }
    }

    const showHeading = body.showHeading !== undefined ? (body.showHeading ? 1 : 0) : null;
    const showLastUpdated = body.showLastUpdated !== undefined ? (body.showLastUpdated ? 1 : 0) : null;
    const newFm = body.content !== undefined ? parseFrontmatter(body.content) : undefined;
    const newSidebarPosition = newFm !== undefined ? (newFm.sidebar_position ?? null) : undefined;
    const newTags = newFm !== undefined ? (newFm.tags ? JSON.stringify(newFm.tags) : null) : undefined;

    // Build dynamic SET clause. Splitting published_at out of the COALESCE
    // group is required: an undefined publishedAt should leave the column
    // untouched, but null is a meaningful explicit unpublish, so we can't use
    // COALESCE there.
    const sets: string[] = [];
    const binds: unknown[] = [];
    if (body.title !== undefined) { sets.push("title = ?"); binds.push(body.title); }
    if (body.publishedAt !== undefined) { sets.push("published_at = ?"); binds.push(body.publishedAt); }
    if (showHeading !== null) { sets.push("show_heading = ?"); binds.push(showHeading); }
    if (showLastUpdated !== null) { sets.push("show_last_updated = ?"); binds.push(showLastUpdated); }
    if (newSidebarPosition !== undefined) { sets.push("sidebar_position = ?"); binds.push(newSidebarPosition); }
    if (newTags !== undefined) { sets.push("tags = ?"); binds.push(newTags); }
    if (body.folderId !== undefined) { sets.push("folder_id = ?"); binds.push(body.folderId); }
    sets.push("updated_at = ?");
    binds.push(now);
    binds.push(docId);
    await env.DB.prepare(`UPDATE docs SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run();

    // Title or folder changes affect how *other* docs' wikilinks resolve, so the project-wide index must be rebuilt.
    if ((body.title && body.title !== doc.title) || body.folderId !== undefined) {
      await invalidateProjectGraphIndex(env, doc.project_id);
    }

    // Only re-index FTS when the body changed (title or content). Settings-only
    // toggles don't affect search.
    if (body.title !== undefined || savedContent !== undefined) {
      const ftsContent = savedContent ?? (await (async () => {
        const r2 = await env.ASSETS.get(`${doc.project_id}/${docId}`);
        return r2 ? await r2.text() : "";
      })());
      await upsertFtsRow(env.DB, docId, doc.project_id, body.title ?? doc.title, ftsContent);
    }

    // Drop any cached AI summary when the body changed — its version is the doc's
    // updated_at at cache time, and that just advanced. Leaving the row would
    // show stale content under DocPage's auto-summary mode until the next
    // doc.id change, since the effect only refires on id.
    if (savedContent !== undefined) {
      await env.DB.prepare("DELETE FROM doc_ai_summaries WHERE doc_id = ?").bind(docId).run();
    }

    const updated = {
      ...doc,
      title: body.title ?? doc.title,
      published_at: body.publishedAt !== undefined ? body.publishedAt : doc.published_at,
      show_heading: showHeading !== null ? showHeading : doc.show_heading,
      show_last_updated: showLastUpdated !== null ? showLastUpdated : doc.show_last_updated,
      folder_id: body.folderId !== undefined ? body.folderId : doc.folder_id,
      updated_at: now,
    };
    // Only echo content when it was sent. Clients toggling settings already
    // have the content locally and merge non-content fields into existing state.
    return okResponse(savedContent !== undefined ? { ...updated, content: savedContent } : updated);
  }

  // DELETE /docs/:id — editor or above
  if (docId && request.method === "DELETE") {
    const doc = await env.DB.prepare("SELECT project_id FROM docs WHERE id = ?").bind(docId).first<{ project_id: string }>();
    if (!doc) return errorResponse(Errors.NOT_FOUND);

    const caller = await getCallerInfo(env.DB, doc.project_id, user.userId);
    if (caller === null) return errorResponse(Errors.FORBIDDEN);
    if (ROLE_RANK[caller.role] < ROLE_RANK["editor"]) return errorResponse(Errors.FORBIDDEN);

    const proj = await env.DB.prepare("SELECT home_doc_id FROM projects WHERE id = ?").bind(doc.project_id).first<{ home_doc_id: string | null }>();
    if (proj?.home_doc_id === docId) return errorResponse(Errors.FORBIDDEN);

    const revisions = await env.DB.prepare("SELECT id FROM asset_revisions WHERE asset_type = 'doc' AND asset_id = ?")
      .bind(docId).all<{ id: string }>();
    await Promise.all([
      env.ASSETS.delete(`${doc.project_id}/${docId}`),
      ...revisions.results.map(r => env.ASSETS.delete(`${doc.project_id}/${docId}/v/${r.id}`)),
    ]);
    await env.DB.prepare("DELETE FROM docs WHERE id = ?").bind(docId).run();
    // Explicit child cleanup. asset_revisions has NO foreign key to docs, so
    // nothing cascades — without this its rows leak forever on every delete.
    // doc_shares does declare ON DELETE CASCADE, but the table-recreate
    // migrations make cascade firing unreliable; deleting here is idempotent
    // and correct whether or not the cascade also runs.
    await env.DB.prepare("DELETE FROM asset_revisions WHERE asset_type = 'doc' AND asset_id = ?").bind(docId).run();
    await env.DB.prepare("DELETE FROM doc_shares WHERE doc_id = ?").bind(docId).run();
    await deleteFtsRow(env.DB, docId);
    // doc_links rows for this doc cascade away, but the deleted title may have shadowed another doc's resolution, so reindex.
    await invalidateProjectGraphIndex(env, doc.project_id);

    // Best-effort: clean up the collab DO room (closes active sockets + wipes stored state)
    if (env.DOC_COLLAB) {
      try {
        const roomId = env.DOC_COLLAB.idFromName(`${doc.project_id}:${docId}`);
        await env.DOC_COLLAB.get(roomId).fetch(new Request("https://internal/", { method: "DELETE" }));
      } catch { /* non-fatal — room may never have been created */ }
    }

    return okResponse({ deleted: true });
  }

  return errorResponse(Errors.NOT_FOUND);
}
