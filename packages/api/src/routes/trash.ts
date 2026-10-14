import { okResponse, errorResponse, Errors, ROLE_RANK, type Session } from "../lib";
import { resolveRole } from "../lib/access";
import { listTrash, restoreFromTrash, purgeTrashEntry, emptyTrash, TRASH_RETENTION_DAYS } from "../lib/trash";
import type { Env } from "../index";

// Site recycle bin (see lib/trash.ts):
//   GET    /projects/:id/trash                    - editor+: list entries
//   POST   /projects/:id/trash/:entryId/restore   - editor+: restore an entry
//   DELETE /projects/:id/trash/:entryId           - admin+: delete forever
//   DELETE /projects/:id/trash                    - admin+: empty the bin
//
// Binning and restoring match the existing delete permission (editor+), but
// the irreversible step is admin+, so the bin protects a site from an
// editor's mistaken (or malicious) delete.
export async function handleTrash(request: Request, env: Env, user: Session, url: URL): Promise<Response> {
  const match = url.pathname.match(/^\/projects\/([^/]+)\/trash(?:\/([^/]+)(?:\/(restore))?)?$/);
  if (!match) return errorResponse(Errors.NOT_FOUND);
  const [, projectId, entryId, action] = match;

  const role = await resolveRole(env.DB, projectId, user.userId);
  if (role === null) return errorResponse(Errors.NOT_FOUND);
  if (ROLE_RANK[role] < ROLE_RANK["editor"]) return errorResponse(Errors.FORBIDDEN);
  const isAdmin = ROLE_RANK[role] >= ROLE_RANK["admin"];

  if (!entryId && request.method === "GET") {
    const entries = await listTrash(env.DB, projectId);
    return okResponse({ entries, retentionDays: TRASH_RETENTION_DAYS, canPurge: isAdmin });
  }

  if (entryId && action === "restore" && request.method === "POST") {
    const restored = await restoreFromTrash(env, projectId, entryId);
    if (!restored) return errorResponse(Errors.NOT_FOUND);
    return okResponse(restored);
  }

  if (entryId && !action && request.method === "DELETE") {
    if (!isAdmin) return errorResponse(Errors.FORBIDDEN);
    const entry = await env.DB.prepare("SELECT id, project_id FROM trash_entries WHERE id = ? AND project_id = ?")
      .bind(entryId, projectId).first<{ id: string; project_id: string }>();
    if (!entry) return errorResponse(Errors.NOT_FOUND);
    await purgeTrashEntry(env, entry);
    return okResponse({ deleted: true });
  }

  if (!entryId && request.method === "DELETE") {
    if (!isAdmin) return errorResponse(Errors.FORBIDDEN);
    return okResponse(await emptyTrash(env, projectId));
  }

  return errorResponse(Errors.NOT_FOUND);
}
