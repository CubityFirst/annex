import { deleteR2Prefix } from "./docOps";
import { releaseCustomDomain, type CustomDomainEnv } from "./customDomains";
import { deleteAllAvatarVariants } from "../avatar";
import type { Env } from "../index";

type ProjectDeleteEnv = Pick<Env, "DB" | "ASSETS"> & CustomDomainEnv;

// Permanently deletes one site and everything hanging off it. Shared by the
// owner-driven site delete (DELETE /projects/:id) and self-service account
// deletion (DELETE /me, via cleanupDeletedAccount below), so both paths remove
// the same data. The admin worker keeps its own mirror in
// packages/admin/src/lib/projectDelete.ts.
//
// Includes recycle-bin items (lib/trash.ts): their rows cascade away with the
// project, but their R2 objects don't.
//
// Order: R2 first (not transactional; re-deleting a missing key is a no-op),
// then release the Cloudflare custom hostname before the project row - and its
// cascading project_custom_domains row - goes, then one D1 batch for the rows
// with no FK cascade from projects (asset_revisions, the docs_fts virtual
// table) plus the project row itself, so the row deletes can't half-apply. A
// failure anywhere before the batch leaves the site intact and the whole call
// safe to retry.
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
    env.DB.prepare("DELETE FROM docs_fts WHERE project_id = ?").bind(projectId),
    env.DB.prepare("DELETE FROM projects WHERE id = ?").bind(projectId),
  ]);
}

// API-DB + R2 cleanup for DELETE /me, run AFTER the auth worker has deleted
// the account (which verifies the password/2FA, so nothing here may run
// before it). DELETE /me already refuses while the caller owns any site, so
// the owned-site loop only catches sites created in the window between that
// check and the auth delete.
//
// The account is already gone when this runs, so there is no way to roll back
// or to let the user retry: every step is best-effort and logged, and a
// failure in one site's cleanup doesn't stop the rest (the old inline code
// threw on the first failure, skipping the membership + avatar cleanup and
// 500ing a deletion that had in fact happened). A site whose cleanup failed
// keeps its row with `owner_id` pointing at the deleted user, so it stays
// findable for an admin delete.
export async function cleanupDeletedAccount(
  env: ProjectDeleteEnv,
  userId: string,
): Promise<{ failedProjectIds: string[] }> {
  const failedProjectIds: string[] = [];
  let ownedIds: string[] = [];
  try {
    const owned = await env.DB.prepare("SELECT id FROM projects WHERE owner_id = ?")
      .bind(userId).all<{ id: string }>();
    ownedIds = owned.results.map(p => p.id);
  } catch (err) {
    console.error("account cleanup: owned-site lookup failed", { userId, err });
  }
  for (const projectId of ownedIds) {
    try {
      await deleteProjectCascade(env, projectId);
    } catch (err) {
      failedProjectIds.push(projectId);
      console.error("account cleanup: site delete failed", { userId, projectId, err });
    }
  }

  try {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM project_members WHERE user_id = ?").bind(userId),
      env.DB.prepare("DELETE FROM organization_members WHERE user_id = ?").bind(userId),
    ]);
  } catch (err) {
    console.error("account cleanup: membership delete failed", { userId, err });
  }

  try {
    await deleteAllAvatarVariants(env.ASSETS, userId);
  } catch (err) {
    console.error("account cleanup: avatar delete failed", { userId, err });
  }

  return { failedProjectIds };
}
