import { okResponse, errorResponse, Errors, ROLE_RANK, folderInProject, wouldCreateFolderCycle, type Session, type Folder, type Role } from "../lib";
import type { Env } from "../index";
import { resolveRole } from "../lib/access";

export async function handleFolders(
  request: Request,
  env: Env,
  user: Session,
  url: URL,
): Promise<Response> {
  const parts = url.pathname.replace(/^\/folders\/?/, "").split("/");
  const folderId = parts[0] || null;
  const params = url.searchParams;

  // GET /folders?projectId=xxx[&parentId=yyy|&rootFolderId=zzz]
  if (!folderId && request.method === "GET") {
    const projectId = params.get("projectId");
    if (!projectId) return errorResponse(Errors.BAD_REQUEST);

    const role = await resolveRole(env.DB, projectId, user.userId);
    if (role === null) return errorResponse(Errors.FORBIDDEN);

    const parentId = params.get("parentId");
    const rootFolderId = params.get("rootFolderId");
    const type = params.get("type") ?? "docs";

    const all = params.get("all") === "1";

    if (role === "limited") {
      const rows = await env.DB.prepare(
        all
          ? `WITH accessible_folder_ids AS (
               SELECT DISTINCT d.folder_id
               FROM docs d
               JOIN doc_shares ds ON ds.doc_id = d.id AND ds.user_id = ?
               WHERE d.project_id = ? AND d.folder_id IS NOT NULL
             ),
             ancestors(id, parent_id) AS (
               SELECT f.id, f.parent_id FROM folders f WHERE f.id IN (SELECT folder_id FROM accessible_folder_ids)
               UNION ALL
               SELECT f.id, f.parent_id FROM folders f JOIN ancestors a ON f.id = a.parent_id
             )
             SELECT DISTINCT f.id, f.name, f.type, f.project_id, f.parent_id, f.created_at
             FROM folders f
             WHERE f.id IN (SELECT id FROM ancestors) AND f.project_id = ? AND f.type = ?
             ORDER BY f.name ASC`
          : `WITH accessible_folder_ids AS (
               SELECT DISTINCT d.folder_id
               FROM docs d
               JOIN doc_shares ds ON ds.doc_id = d.id AND ds.user_id = ?
               WHERE d.project_id = ? AND d.folder_id IS NOT NULL
             ),
             ancestors(id, parent_id) AS (
               SELECT f.id, f.parent_id FROM folders f WHERE f.id IN (SELECT folder_id FROM accessible_folder_ids)
               UNION ALL
               SELECT f.id, f.parent_id FROM folders f JOIN ancestors a ON f.id = a.parent_id
             )
             SELECT DISTINCT f.id, f.name, f.type, f.project_id, f.parent_id, f.created_at
             FROM folders f
             WHERE f.id IN (SELECT id FROM ancestors) AND f.project_id = ? AND f.type = ?
               AND f.parent_id IS ?
             ORDER BY f.name ASC`,
      ).bind(
        ...(all
          ? [user.userId, projectId, projectId, type]
          : [user.userId, projectId, projectId, type, parentId ?? null]),
      ).all<Folder>();
      return okResponse(rows.results);
    }

    let rows;
    if (all) {
      rows = await env.DB.prepare(
        "SELECT * FROM folders WHERE project_id = ? AND type = ? ORDER BY name ASC",
      ).bind(projectId, type).all<Folder>();
    } else if (rootFolderId) {
      rows = await env.DB.prepare(`
        WITH RECURSIVE subtree(id, name, type, project_id, parent_id, created_at) AS (
          SELECT id, name, type, project_id, parent_id, created_at
            FROM folders WHERE id = ? AND project_id = ? AND type = ?
          UNION ALL
          SELECT f.id, f.name, f.type, f.project_id, f.parent_id, f.created_at
            FROM folders f JOIN subtree s ON f.parent_id = s.id
        )
        SELECT * FROM subtree WHERE id != ? ORDER BY name ASC
      `).bind(rootFolderId, projectId, type, rootFolderId).all<Folder>();
    } else if (parentId) {
      rows = await env.DB.prepare(
        "SELECT * FROM folders WHERE project_id = ? AND parent_id = ? AND type = ? ORDER BY name ASC",
      ).bind(projectId, parentId, type).all<Folder>();
    } else {
      rows = await env.DB.prepare(
        "SELECT * FROM folders WHERE project_id = ? AND parent_id IS NULL AND type = ? ORDER BY name ASC",
      ).bind(projectId, type).all<Folder>();
    }

    return okResponse(rows.results);
  }

  // GET /folders/counts?projectId=xxx
  // Returns { [folderId]: { docs: number; folders: number } } with recursive subtree counts.
  if (folderId === "counts" && request.method === "GET") {
    const projectId = params.get("projectId");
    if (!projectId) return errorResponse(Errors.BAD_REQUEST);

    const role = await resolveRole(env.DB, projectId, user.userId);
    if (role === null) return errorResponse(Errors.FORBIDDEN);
    if (role === "limited") return okResponse({});

    const type = params.get("type") ?? "docs";
    const itemTable = "docs";

    // Build a (ancestor_id, folder_id) mapping for every folder in the project, then
    // aggregate: distinct non-self folder_ids = recursive subfolder count,
    // joined item rows = recursive doc count.
    const rows = await env.DB.prepare(`
      WITH RECURSIVE subtree(ancestor_id, folder_id) AS (
        SELECT id, id FROM folders WHERE project_id = ? AND type = ?
        UNION ALL
        SELECT s.ancestor_id, f.id
          FROM folders f JOIN subtree s ON f.parent_id = s.folder_id
         WHERE f.project_id = ? AND f.type = ?
      )
      SELECT
        s.ancestor_id AS folder_id,
        COUNT(DISTINCT CASE WHEN s.folder_id != s.ancestor_id THEN s.folder_id END) AS folders,
        COUNT(i.id) AS docs
      FROM subtree s
      LEFT JOIN ${itemTable} i ON i.folder_id = s.folder_id AND i.project_id = ?
      GROUP BY s.ancestor_id
    `).bind(projectId, type, projectId, type, projectId)
      .all<{ folder_id: string; folders: number; docs: number }>();

    const counts: Record<string, { docs: number; folders: number }> = {};
    for (const r of rows.results) counts[r.folder_id] = { docs: r.docs, folders: r.folders };
    return okResponse(counts);
  }

  // POST /folders - editor or above
  if (!folderId && request.method === "POST") {
    const body = await request.json<{ name: string; projectId: string; parentId?: string | null; type?: string }>();
    if (!body.name || !body.projectId) return errorResponse(Errors.BAD_REQUEST);

    const role = await resolveRole(env.DB, body.projectId, user.userId);
    if (role === null) return errorResponse(Errors.FORBIDDEN);
    if (ROLE_RANK[role] < ROLE_RANK["editor"]) return errorResponse(Errors.FORBIDDEN);

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const type = body.type ?? "docs";

    // Parent folder (if any) must live in this project and share the type.
    if (!(await folderInProject(env.DB, body.parentId, body.projectId, type))) {
      return errorResponse(Errors.BAD_REQUEST);
    }

    await env.DB.prepare(
      "INSERT INTO folders (id, name, type, project_id, parent_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(id, body.name, type, body.projectId, body.parentId ?? null, now).run();

    return okResponse({ id, name: body.name, type, project_id: body.projectId, parent_id: body.parentId ?? null, created_at: now }, 201);
  }

  // PUT /folders/:id - editor or above (rename or move)
  if (folderId && folderId !== "counts" && request.method === "PUT") {
    const folder = await env.DB.prepare("SELECT * FROM folders WHERE id = ?")
      .bind(folderId).first<Folder & { type: string }>();
    if (!folder) return errorResponse(Errors.NOT_FOUND);

    const role = await resolveRole(env.DB, folder.project_id, user.userId);
    if (role === null) return errorResponse(Errors.FORBIDDEN);
    if (ROLE_RANK[role] < ROLE_RANK["editor"]) return errorResponse(Errors.FORBIDDEN);

    const body = await request.json<Partial<{ name: string; parentId: string | null }>>();

    // Validate a re-parent: target must be in the same project + type, and the
    // move must not create a cycle (which would make the recursive subtree CTEs
    // loop forever - a DoS).
    if (body.parentId !== undefined && body.parentId !== null) {
      if (!(await folderInProject(env.DB, body.parentId, folder.project_id, folder.type))) {
        return errorResponse(Errors.BAD_REQUEST);
      }
      if (body.parentId === folderId || (await wouldCreateFolderCycle(env.DB, folderId, body.parentId))) {
        return errorResponse(Errors.BAD_REQUEST);
      }
    }

    const sets: string[] = [];
    const binds: (string | null)[] = [];
    if (body.name !== undefined) { sets.push("name = ?"); binds.push(body.name); }
    if (body.parentId !== undefined) { sets.push("parent_id = ?"); binds.push(body.parentId); }
    if (sets.length > 0) {
      await env.DB.prepare(`UPDATE folders SET ${sets.join(", ")} WHERE id = ?`)
        .bind(...binds, folderId).run();
    }

    return okResponse({
      ...folder,
      name: body.name ?? folder.name,
      parent_id: body.parentId !== undefined ? (body.parentId ?? null) : folder.parent_id,
    });
  }

  // DELETE /folders/:id - editor or above
  if (folderId && folderId !== "counts" && request.method === "DELETE") {
    const folder = await env.DB.prepare("SELECT project_id FROM folders WHERE id = ?")
      .bind(folderId).first<{ project_id: string }>();
    if (!folder) return errorResponse(Errors.NOT_FOUND);

    const role = await resolveRole(env.DB, folder.project_id, user.userId);
    if (role === null) return errorResponse(Errors.FORBIDDEN);
    if (ROLE_RANK[role] < ROLE_RANK["editor"]) return errorResponse(Errors.FORBIDDEN);

    await env.DB.prepare("DELETE FROM folders WHERE id = ?").bind(folderId).run();
    return okResponse({ deleted: true });
  }

  return errorResponse(Errors.NOT_FOUND);
}
