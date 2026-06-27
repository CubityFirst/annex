import { okResponse, errorResponse, Errors, ROLE_RANK, type Role } from "../lib";
import type { Env } from "../index";
import type { Session } from "../lib";
import { resolveRole } from "../lib/access";

type SharePermission = "view" | "edit";

function isValidPermission(p: unknown): p is SharePermission {
  return p === "view" || p === "edit";
}

// Handles:
//   GET/POST         /docs/:docId/shares[/:userId]
//   PATCH            /docs/:docId/shares/:userId
//   DELETE           /docs/:docId/shares/:userId
//   POST             /projects/:projectId/folder-shares
export async function handleDocShares(
  request: Request,
  env: Env,
  user: Session,
  url: URL,
): Promise<Response> {
  // POST /projects/:projectId/folder-shares - bulk share all docs in a folder
  const folderShareMatch = url.pathname.match(/^\/projects\/([^/]+)\/folder-shares$/);
  if (folderShareMatch && request.method === "POST") {
    const projectId = folderShareMatch[1];
    const callerRole = await resolveRole(env.DB, projectId, user.userId);
    if (callerRole === null) return errorResponse(Errors.NOT_FOUND);
    if (ROLE_RANK[callerRole] < ROLE_RANK["admin"]) return errorResponse(Errors.FORBIDDEN);

    const body = await request.json<{ userId: string; folderId: string; permission?: SharePermission }>();
    if (!body.userId || !body.folderId) return errorResponse(Errors.BAD_REQUEST);
    const permission: SharePermission = isValidPermission(body.permission) ? body.permission : "view";

    const target = await env.DB.prepare(
      "SELECT role FROM project_members WHERE project_id = ? AND user_id = ?",
    ).bind(projectId, body.userId).first<{ role: Role }>();
    if (!target) return errorResponse(Errors.NOT_FOUND);
    // Editor/admin/owner already have project-wide edit, so a per-doc share is meaningless.
    if (ROLE_RANK[target.role] >= ROLE_RANK["editor"]) return errorResponse(Errors.BAD_REQUEST);

    const docs = await env.DB.prepare(
      "SELECT id FROM docs WHERE project_id = ? AND folder_id = ?",
    ).bind(projectId, body.folderId).all<{ id: string }>();

    if (docs.results.length === 0) return okResponse({ granted: 0 });

    const now = new Date().toISOString();
    const stmts = docs.results.map(doc =>
      env.DB.prepare(
        "INSERT INTO doc_shares (id, doc_id, user_id, project_id, granted_by, created_at, permission) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(doc_id, user_id) DO UPDATE SET permission = excluded.permission",
      ).bind(crypto.randomUUID(), doc.id, body.userId, projectId, user.userId, now, permission),
    );
    await env.DB.batch(stmts);

    return okResponse({ granted: docs.results.length });
  }

  // /docs/:docId/shares[/:targetUserId]
  const docShareMatch = url.pathname.match(/^\/docs\/([^/]+)\/shares\/?([^/]*)$/);
  if (!docShareMatch) return errorResponse(Errors.NOT_FOUND);
  const docId = docShareMatch[1];
  const targetUserId = docShareMatch[2] || null;

  const meta = await env.DB.prepare("SELECT project_id FROM docs WHERE id = ?")
    .bind(docId).first<{ project_id: string }>();
  if (!meta) return errorResponse(Errors.NOT_FOUND);

  const callerRole = await resolveRole(env.DB, meta.project_id, user.userId);
  if (callerRole === null) return errorResponse(Errors.NOT_FOUND);
  if (ROLE_RANK[callerRole] < ROLE_RANK["admin"]) return errorResponse(Errors.FORBIDDEN);

  // GET /docs/:id/shares - list shares with permission levels.
  // Only surface shares whose target is below editor; editor/admin/owner already
  // have project-wide access, so any lingering share row for them (e.g. left
  // over from a role promotion) is functionally inert and would confuse admins.
  if (!targetUserId && request.method === "GET") {
    const rows = await env.DB.prepare(`
      SELECT ds.user_id, pm.name, pm.email, ds.permission
      FROM doc_shares ds
      JOIN project_members pm ON pm.project_id = ds.project_id AND pm.user_id = ds.user_id
      WHERE ds.doc_id = ? AND pm.role NOT IN ('editor', 'admin', 'owner')
      ORDER BY pm.name ASC
    `).bind(docId).all<{ user_id: string; name: string; email: string; permission: SharePermission }>();
    return okResponse(rows.results.map(r => ({
      userId: r.user_id, name: r.name, email: r.email, permission: r.permission,
    })));
  }

  // POST /docs/:id/shares - grant access with a permission level
  if (!targetUserId && request.method === "POST") {
    const body = await request.json<{ userId: string; permission?: SharePermission }>();
    if (!body.userId) return errorResponse(Errors.BAD_REQUEST);
    const permission: SharePermission = isValidPermission(body.permission) ? body.permission : "view";

    const target = await env.DB.prepare(
      "SELECT role FROM project_members WHERE project_id = ? AND user_id = ?",
    ).bind(meta.project_id, body.userId).first<{ role: Role }>();
    if (!target) return errorResponse(Errors.NOT_FOUND);
    if (ROLE_RANK[target.role] >= ROLE_RANK["editor"]) return errorResponse(Errors.BAD_REQUEST);

    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO doc_shares (id, doc_id, user_id, project_id, granted_by, created_at, permission) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(doc_id, user_id) DO UPDATE SET permission = excluded.permission",
    ).bind(crypto.randomUUID(), docId, body.userId, meta.project_id, user.userId, now, permission).run();

    const share = await env.DB.prepare(
      "SELECT pm.name, pm.email FROM doc_shares ds JOIN project_members pm ON pm.project_id = ds.project_id AND pm.user_id = ds.user_id WHERE ds.doc_id = ? AND ds.user_id = ?",
    ).bind(docId, body.userId).first<{ name: string; email: string }>();

    return okResponse({ userId: body.userId, name: share?.name ?? "", email: share?.email ?? "", permission }, 201);
  }

  // PATCH /docs/:id/shares/:userId - update permission level
  if (targetUserId && request.method === "PATCH") {
    const body = await request.json<{ permission: SharePermission }>();
    if (!isValidPermission(body.permission)) return errorResponse(Errors.BAD_REQUEST);

    const existing = await env.DB.prepare("SELECT id FROM doc_shares WHERE doc_id = ? AND user_id = ?")
      .bind(docId, targetUserId).first();
    if (!existing) return errorResponse(Errors.NOT_FOUND);

    await env.DB.prepare("UPDATE doc_shares SET permission = ? WHERE doc_id = ? AND user_id = ?")
      .bind(body.permission, docId, targetUserId).run();

    return okResponse({ userId: targetUserId, permission: body.permission });
  }

  // DELETE /docs/:id/shares/:userId - revoke access
  if (targetUserId && request.method === "DELETE") {
    const existing = await env.DB.prepare("SELECT id FROM doc_shares WHERE doc_id = ? AND user_id = ?")
      .bind(docId, targetUserId).first();
    if (!existing) return errorResponse(Errors.NOT_FOUND);

    await env.DB.prepare("DELETE FROM doc_shares WHERE doc_id = ? AND user_id = ?")
      .bind(docId, targetUserId).run();

    return okResponse({ revoked: true });
  }

  return errorResponse(Errors.NOT_FOUND);
}
