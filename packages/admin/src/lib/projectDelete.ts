import { releaseCustomDomain } from "../../../api/src/lib/customDomains";
import { deleteR2Prefix } from "./r2";
import type { Env } from "../index";

// Permanently deletes one site and everything hanging off it. Shared by the
// admin site delete (DELETE /api/projects/:id) and the scheduled account
// deletion (lib/userDeletion.ts executeUserDeletion, run by the hourly cron -
// only for sites the operator explicitly confirmed when scheduling it).
//
// Mirrors the API worker's project-delete cleanup (packages/api/src/
// routes/projects.ts) so an admin-driven delete doesn't leave orphans
// the owner-driven path would have removed. Scale-safety mirrors it too:
// every doc body and revision snapshot lives under the `{projectId}/`
// prefix, so one batched prefix sweep removes them all (including objects
// orphaned by failed inserts) in ~1 subrequest per 1000 keys, and the
// per-doc-id SQL deletes are chunked to stay under D1's ~100 bound-
// parameter limit. The final batch (satellite rows + FTS + the project
// row, which cascades docs/files/members/domains) is a single D1 batch
// so the row deletes can't half-apply.
//
// The caller owns the existence check and the audit row.
export async function deleteProjectCascade(
  env: Env,
  projectId: string,
): Promise<{ docs: number; files: number }> {
  // Includes recycle-bin items (api lib/trash.ts): their rows cascade away
  // with the project, but their R2 objects and revisions don't.
  const docs = await env.DB.prepare(
    "SELECT id FROM docs WHERE project_id = ? UNION SELECT item_id FROM trash_items WHERE project_id = ? AND item_type = 'doc'",
  ).bind(projectId, projectId).all<{ id: string }>();
  const docIds = docs.results.map(d => d.id);
  const files = await env.DB.prepare(
    "SELECT id FROM files WHERE project_id = ? UNION SELECT item_id FROM trash_items WHERE project_id = ? AND item_type = 'file'",
  ).bind(projectId, projectId).all<{ id: string }>();

  // R2 is not transactional; do the object deletes first, then the SQL.
  // Docs + revisions via prefix sweep; files and logos live under other
  // prefixes and are deleted by key, batched (R2 array delete takes up
  // to 1000 keys per call).
  await deleteR2Prefix(env.ASSETS, `${projectId}/`);
  const otherKeys = [
    ...files.results.map(f => `files/${f.id}`),
    `site-logos/${projectId}-square`,
    `site-logos/${projectId}-wide`,
  ];
  for (let i = 0; i < otherKeys.length; i += 1000) {
    await env.ASSETS.delete(otherKeys.slice(i, i + 1000));
  }

  // asset_revisions and doc_shares have no ON DELETE CASCADE from docs;
  // delete them in 50-id chunks so a large project never exceeds D1's
  // bound-parameter limit (an unchunked IN(...) 500s past ~100 docs).
  for (let i = 0; i < docIds.length; i += 50) {
    const chunk = docIds.slice(i, i + 50);
    const ph = chunk.map(() => "?").join(",");
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM asset_revisions WHERE asset_type = 'doc' AND asset_id IN (${ph})`).bind(...chunk),
      env.DB.prepare(`DELETE FROM doc_shares WHERE doc_id IN (${ph})`).bind(...chunk),
    ]);
  }

  // Release the Cloudflare custom hostname (if any) before the batch deletes
  // the project + its cascading project_custom_domains row. Best-effort no-op
  // when CF isn't configured on the admin worker.
  await releaseCustomDomain(env, projectId);

  await env.DB.batch([
    env.DB.prepare("DELETE FROM docs_fts WHERE project_id = ?").bind(projectId),
    env.DB.prepare("DELETE FROM projects WHERE id = ?").bind(projectId),
  ]);

  return { docs: docIds.length, files: files.results.length };
}
