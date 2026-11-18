import { deleteR2Prefix } from "./docOps";
import { ftsDeleteProjectStatements } from "./fts";
import { releaseCustomDomain, type CustomDomainEnv } from "./customDomains";
import type { Env } from "../index";

type ProjectDeleteEnv = Pick<Env, "DB" | "ASSETS"> & CustomDomainEnv;

// Permanently deletes one site and everything hanging off it (the owner-driven
// site delete, DELETE /projects/:id). The admin worker keeps its own mirror in
// packages/admin/src/lib/projectDelete.ts.
//
// Includes recycle-bin items (lib/trash.ts): their rows cascade away with the
// project, but their R2 objects don't.
//
// Order: R2 first (not transactional; re-deleting a missing key is a no-op),
// then release the Cloudflare custom hostname before the project row - and its
// cascading project_custom_domains row - goes, then one D1 batch for the rows
// with no FK cascade from projects (asset_revisions, the docs_fts virtual
// table and its docs_fts_map rowid map) plus the project row itself, so the
// row deletes can't half-apply. A failure before the batch leaves the project row in place (its R2 content may
// already be gone, as before) and the whole call safe to retry.
export async function deleteProjectCascade(
  env: ProjectDeleteEnv,
  projectId: string,
): Promise<void> {
  const files = await env.DB.prepare(
    "SELECT id FROM files WHERE project_id = ? UNION SELECT item_id FROM trash_items WHERE project_id = ? AND item_type = 'file'",
  ).bind(projectId, projectId).all<{ id: string }>();

  // Every doc body (`{projectId}/{docId}`) and every revision snapshot
  // (`{projectId}/{docId}/v/{revId}`) lives under the `{projectId}/` prefix,
  // so one batched prefix sweep removes them all - including revision objects
  // orphaned by a failed insert, which a per-D1-row delete would leak. Files
  // and logos live under other prefixes and are deleted by key, batched
  // (R2's array delete takes up to 1000 keys per call).
  await deleteR2Prefix(env.ASSETS, `${projectId}/`);
  const otherKeys = [
    ...files.results.map(f => `files/${f.id}`),
    `site-logos/${projectId}-square`,
    `site-logos/${projectId}-wide`,
  ];
  for (let i = 0; i < otherKeys.length; i += 1000) {
    await env.ASSETS.delete(otherKeys.slice(i, i + 1000));
  }

  await releaseCustomDomain(env, projectId);

  // asset_revisions rows carry their doc's project_id (docOps
  // insertDocRevision), so one statement covers live and binned docs alike.
  await env.DB.batch([
    env.DB.prepare("DELETE FROM asset_revisions WHERE project_id = ?").bind(projectId),
    ...ftsDeleteProjectStatements(env.DB, projectId),
    env.DB.prepare("DELETE FROM projects WHERE id = ?").bind(projectId),
  ]);
}
