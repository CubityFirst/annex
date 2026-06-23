import { Hono } from "hono";
import { upsertFtsRow } from "../../../api/src/lib/fts";
import { releaseCustomDomain, removeCustomDomain } from "../../../api/src/lib/customDomains";
import { writeAdminAudit } from "../audit";
import type { AppEnv, Env } from "../index";

const projectsRouter = new Hono<AppEnv>();

// Reindex safety ceiling. Each doc costs ~1 R2 read + 1 D1 batch; a
// Worker invocation has a bounded subrequest budget, so very large
// projects must reindex via the owner-facing API path instead of here.
const REINDEX_MAX_DOCS = 2000;
// Bounded fan-out so a big project doesn't reindex one-doc-at-a-time.
const REINDEX_CHUNK = 10;

// GET /api/projects?q=
//
// LEFT JOINs project_custom_domains so each row carries its mapped custom
// domain (if any) + status, letting the UI show + offer to remove it.
projectsRouter.get("/", async (c) => {
  const q = c.req.query("q") ?? "";
  const cols =
    "p.id, p.name, p.owner_id, p.features, p.created_at, " +
    "cd.hostname AS custom_domain, cd.status AS custom_domain_status";
  const join = "FROM projects p LEFT JOIN project_custom_domains cd ON cd.project_id = p.id";
  type Row = {
    id: string; name: string; owner_id: string; features: number; created_at: string;
    custom_domain: string | null; custom_domain_status: string | null;
  };
  const rows = q
    ? await c.env.DB.prepare(
        `SELECT ${cols} ${join} WHERE p.name LIKE ? ORDER BY p.created_at DESC LIMIT 100`,
      ).bind(`%${q}%`).all<Row>()
    : await c.env.DB.prepare(
        `SELECT ${cols} ${join} ORDER BY p.created_at DESC LIMIT 100`,
      ).all<Row>();
  return c.json({ ok: true, data: rows.results });
});

// GET /api/projects/:id — full detail view backing the admin "Project details"
// sheet: branding, ownership/org, granted feature flags + owner-enabled
// toggles, member breakdown, and doc/file/folder content stats. Read-only and
// not audited, mirroring GET /api/users/:id.
projectsRouter.get("/:id", async (c) => {
  const id = c.req.param("id");
  const details = await loadProjectDetails(c.env, id);
  if (!details) return c.json({ ok: false, error: "Project not found" }, 404);
  return c.json({ ok: true, data: details });
});

// GET /api/projects/:id/logo?variant=square|wide — proxies a site logo out of
// R2 for the admin sheet. Sits behind enforceAdmin (unlike the public avatar
// route), so the frontend fetches it with the bearer token and renders it via
// an object URL — an unpublished site's logo must not be world-readable by id.
// 404 when the site has no logo of that variant.
projectsRouter.get("/:id/logo", async (c) => {
  const id = c.req.param("id");
  const variant = c.req.query("variant") === "wide" ? "wide" : "square";
  const obj = await c.env.ASSETS.get(`site-logos/${id}-${variant}`);
  if (!obj) return new Response(null, { status: 404 });
  return new Response(await obj.arrayBuffer(), {
    headers: {
      "Content-Type": obj.httpMetadata?.contentType ?? "application/octet-stream",
      "Cache-Control": "private, max-age=60",
    },
  });
});

// PATCH /api/projects/:id/features — { features: number }
projectsRouter.patch("/:id/features", async (c) => {
  const session = c.get("session");
  const id = c.req.param("id");
  const body = await c.req.json<{ features: number }>().catch(() => ({} as { features?: number }));
  if (typeof body.features !== "number" || !Number.isInteger(body.features) || body.features < 0) {
    return c.json({ ok: false, error: "Invalid features value" }, 400);
  }
  await c.env.DB.prepare("UPDATE projects SET features = ? WHERE id = ?")
    .bind(body.features, id)
    .run();
  await writeAdminAudit(c.env, session, "project.features.update", "project", id, { features: body.features });
  return c.json({ ok: true });
});

// POST /api/projects/:id/reindex — rebuild FTS index for all docs in a project
projectsRouter.post("/:id/reindex", async (c) => {
  const session = c.get("session");
  const projectId = c.req.param("id");

  const exists = await c.env.DB.prepare("SELECT id FROM projects WHERE id = ?")
    .bind(projectId).first<{ id: string }>();
  if (!exists) return c.json({ ok: false, error: "Not found" }, 404);

  const docs = await c.env.DB.prepare("SELECT id, title FROM docs WHERE project_id = ?")
    .bind(projectId).all<{ id: string; title: string }>();

  if (docs.results.length > REINDEX_MAX_DOCS) {
    return c.json({
      ok: false,
      error: `Project has ${docs.results.length} docs; admin reindex is capped at ${REINDEX_MAX_DOCS}. Reindex from the project owner's tools instead.`,
    }, 409);
  }

  let indexed = 0;
  for (let i = 0; i < docs.results.length; i += REINDEX_CHUNK) {
    const chunk = docs.results.slice(i, i + REINDEX_CHUNK);
    await Promise.all(
      chunk.map(async (doc) => {
        const obj = await c.env.ASSETS.get(`${projectId}/${doc.id}`);
        const content = obj ? await obj.text() : "";
        await upsertFtsRow(c.env.DB, doc.id, projectId, doc.title, content);
      }),
    );
    indexed += chunk.length;
  }

  await writeAdminAudit(c.env, session, "project.reindex", "project", projectId, { indexed });
  return c.json({ ok: true, data: { indexed } });
});

// DELETE /api/projects/:id/domain — remove a site's custom domain mapping.
//
// Deregisters the Cloudflare custom hostname (best-effort) and drops the
// project_custom_domains row, leaving the site itself intact. Mirrors the
// owner-facing DELETE /projects/:id/domain. No-op (200) when the site has no
// mapped domain. Requires CF_API_TOKEN/CF_ZONE_ID on the admin worker for the
// Cloudflare side to actually fire; the DB row is dropped regardless.
projectsRouter.delete("/:id/domain", async (c) => {
  const session = c.get("session");
  const projectId = c.req.param("id");

  const exists = await c.env.DB.prepare("SELECT id FROM projects WHERE id = ?")
    .bind(projectId).first<{ id: string }>();
  if (!exists) return c.json({ ok: false, error: "Not found" }, 404);

  const hostname = await removeCustomDomain(c.env, projectId);
  await writeAdminAudit(c.env, session, "project.domain.remove", "project", projectId, { hostname });
  return c.json({ ok: true, data: { hostname } });
});

// DELETE /api/projects/:id
//
// Mirrors the API worker's project-delete cleanup (packages/api/src/
// routes/projects.ts) so an admin-driven delete doesn't leave orphans
// the owner-driven path would have removed: doc R2 objects + revision
// blobs + files + the project's site logos, plus asset_revisions (no
// cascade), doc_shares (no cascade), and the FTS rows. The SQL deletes
// run as one D1 batch so we can't half-delete a project.
projectsRouter.delete("/:id", async (c) => {
  const session = c.get("session");
  const projectId = c.req.param("id");

  const docs = await c.env.DB.prepare("SELECT id FROM docs WHERE project_id = ?").bind(projectId).all<{ id: string }>();
  const docIds = docs.results.map(d => d.id);

  const revisions = docIds.length > 0
    ? await c.env.DB.prepare(
        `SELECT asset_id, id FROM asset_revisions WHERE asset_type = 'doc' AND asset_id IN (${docIds.map(() => "?").join(",")})`,
      ).bind(...docIds).all<{ asset_id: string; id: string }>()
    : { results: [] as { asset_id: string; id: string }[] };

  const files = await c.env.DB.prepare("SELECT id FROM files WHERE project_id = ?").bind(projectId).all<{ id: string }>();

  // R2 is not transactional; do the object deletes first, then the
  // single SQL batch.
  await Promise.all([
    ...docIds.map(docId => c.env.ASSETS.delete(`${projectId}/${docId}`)),
    ...revisions.results.map(r => c.env.ASSETS.delete(`${projectId}/${r.asset_id}/v/${r.id}`)),
    ...files.results.map(f => c.env.ASSETS.delete(`files/${f.id}`)),
    c.env.ASSETS.delete(`site-logos/${projectId}-square`),
    c.env.ASSETS.delete(`site-logos/${projectId}-wide`),
  ]);

  const stmts = [];
  if (docIds.length > 0) {
    const ph = docIds.map(() => "?").join(",");
    // asset_revisions and doc_shares have no ON DELETE CASCADE from docs.
    stmts.push(
      c.env.DB.prepare(`DELETE FROM asset_revisions WHERE asset_type = 'doc' AND asset_id IN (${ph})`).bind(...docIds),
    );
    stmts.push(
      c.env.DB.prepare(`DELETE FROM doc_shares WHERE doc_id IN (${ph})`).bind(...docIds),
    );
  }
  stmts.push(c.env.DB.prepare("DELETE FROM docs_fts WHERE project_id = ?").bind(projectId));
  stmts.push(c.env.DB.prepare("DELETE FROM projects WHERE id = ?").bind(projectId));

  // Release the Cloudflare custom hostname (if any) before the batch deletes
  // the project + its cascading project_custom_domains row. Best-effort no-op
  // when CF isn't configured on the admin worker.
  await releaseCustomDomain(c.env, projectId);

  await c.env.DB.batch(stmts);

  await writeAdminAudit(c.env, session, "project.delete", "project", projectId, {
    docs: docIds.length,
    files: files.results.length,
  });
  return c.json({ ok: true });
});

export interface ProjectDetailRow {
  id: string;
  name: string;
  description: string | null;
  owner_id: string;
  created_at: string;
  published_at: string | null;
  changelog_mode: string;
  home_doc_id: string | null;
  vanity_slug: string | null;
  logo_square_updated_at: string | null;
  logo_wide_updated_at: string | null;
  features: number;
  ai_enabled: number;
  ai_summarization_type: string;
  graph_enabled: number;
  published_graph_enabled: number;
  organization_id: string | null;
  organization_name: string | null;
}

export interface ProjectMemberRow {
  id: string;
  user_id: string;
  email: string;
  name: string;
  role: string;
  accepted: number;
  created_at: string;
}

export interface ProjectDetails {
  profile: {
    id: string;
    name: string;
    description: string | null;
    created_at: string;
    published: boolean;
    published_at: string | null;
    changelog_mode: string;
    home_doc_id: string | null;
    owner: { id: string; name: string | null; email: string | null } | null;
  };
  branding: {
    vanity_slug: string | null;
    logo_square_updated_at: string | null;
    logo_wide_updated_at: string | null;
    custom_domain: { hostname: string; status: string | null } | null;
  };
  organization: { id: string; name: string } | null;
  settings: {
    features: number;
    ai_enabled: boolean;
    ai_summarization_type: string;
    graph_enabled: boolean;
    published_graph_enabled: boolean;
  };
  members: {
    accepted: number;
    pending: number;
    by_role: Array<{ role: string; count: number }>;
    list: Array<{
      id: string;
      user_id: string;
      name: string;
      email: string;
      role: string;
      accepted: boolean;
      created_at: string;
    }>;
  };
  content: {
    docs: { total: number; published: number; drafts: number; with_ai_summary: number };
    folders: number;
    files: { count: number; total_bytes: number };
  };
}

// Aggregates one project's admin detail view. The project row (+ org name) is
// fetched first to short-circuit on a missing id; everything else fans out in
// one Promise.all. The owner identity comes from AUTH_DB (cross-DB) since the
// main DB only stores owner_id; member name/email are denormalized on
// project_members so no auth lookup is needed for the roster.
async function loadProjectDetails(env: Env, id: string): Promise<ProjectDetails | null> {
  const project = await env.DB.prepare(
    `SELECT p.id, p.name, p.description, p.owner_id, p.created_at, p.published_at,
            p.changelog_mode, p.home_doc_id, p.vanity_slug,
            p.logo_square_updated_at, p.logo_wide_updated_at,
            p.features, p.ai_enabled, p.ai_summarization_type,
            p.graph_enabled, p.published_graph_enabled,
            p.organization_id, o.name AS organization_name
     FROM projects p
     LEFT JOIN organizations o ON o.id = p.organization_id
     WHERE p.id = ?`,
  ).bind(id).first<ProjectDetailRow>();

  if (!project) return null;

  const [owner, customDomain, docStats, aiSummaries, folderCount, fileStats, memberCounts, byRole, members] =
    await Promise.all([
      env.AUTH_DB.prepare("SELECT id, name, email FROM users WHERE id = ?")
        .bind(project.owner_id)
        .first<{ id: string; name: string | null; email: string | null }>(),
      env.DB.prepare("SELECT hostname, status FROM project_custom_domains WHERE project_id = ?")
        .bind(id)
        .first<{ hostname: string; status: string | null }>(),
      env.DB.prepare(
        "SELECT COUNT(*) AS total, SUM(CASE WHEN published_at IS NOT NULL THEN 1 ELSE 0 END) AS published FROM docs WHERE project_id = ?",
      ).bind(id).first<{ total: number; published: number | null }>(),
      env.DB.prepare(
        "SELECT COUNT(*) AS n FROM doc_ai_summaries WHERE doc_id IN (SELECT id FROM docs WHERE project_id = ?)",
      ).bind(id).first<{ n: number }>(),
      env.DB.prepare("SELECT COUNT(*) AS n FROM folders WHERE project_id = ?").bind(id).first<{ n: number }>(),
      env.DB.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM files WHERE project_id = ?")
        .bind(id)
        .first<{ n: number; bytes: number }>(),
      env.DB.prepare(
        "SELECT SUM(CASE WHEN accepted = 1 THEN 1 ELSE 0 END) AS accepted, SUM(CASE WHEN accepted = 0 THEN 1 ELSE 0 END) AS pending FROM project_members WHERE project_id = ?",
      ).bind(id).first<{ accepted: number | null; pending: number | null }>(),
      env.DB.prepare(
        "SELECT role, COUNT(*) AS count FROM project_members WHERE project_id = ? AND accepted = 1 GROUP BY role",
      ).bind(id).all<{ role: string; count: number }>(),
      env.DB.prepare(
        `SELECT id, user_id, email, name, role, accepted, created_at
         FROM project_members
         WHERE project_id = ?
         ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'editor' THEN 2 WHEN 'viewer' THEN 3 ELSE 4 END,
                  created_at ASC
         LIMIT 250`,
      ).bind(id).all<ProjectMemberRow>(),
    ]);

  return buildProjectDetails({
    project,
    owner,
    customDomain,
    docStats,
    aiSummaries,
    folderCount,
    fileStats,
    memberCounts,
    byRole: byRole.results,
    members: members.results,
  });
}

// Pure assembly of the detail payload from already-fetched rows — split out of
// loadProjectDetails so it can be unit-tested without a live D1. Coalesces the
// nullable COUNT/SUM aggregates (a project with zero docs/members/files yields
// NULL sums) and derives the published flag + draft count.
export function buildProjectDetails(input: {
  project: ProjectDetailRow;
  owner: { id: string; name: string | null; email: string | null } | null;
  customDomain: { hostname: string; status: string | null } | null;
  docStats: { total: number; published: number | null } | null;
  aiSummaries: { n: number } | null;
  folderCount: { n: number } | null;
  fileStats: { n: number; bytes: number } | null;
  memberCounts: { accepted: number | null; pending: number | null } | null;
  byRole: Array<{ role: string; count: number }>;
  members: ProjectMemberRow[];
}): ProjectDetails {
  const { project, owner, customDomain, docStats, aiSummaries, folderCount, fileStats, memberCounts, byRole, members } =
    input;
  const totalDocs = docStats?.total ?? 0;
  const publishedDocs = docStats?.published ?? 0;

  return {
    profile: {
      id: project.id,
      name: project.name,
      description: project.description,
      created_at: project.created_at,
      published: project.published_at !== null,
      published_at: project.published_at,
      changelog_mode: project.changelog_mode,
      home_doc_id: project.home_doc_id,
      owner: owner ? { id: owner.id, name: owner.name, email: owner.email } : null,
    },
    branding: {
      vanity_slug: project.vanity_slug,
      logo_square_updated_at: project.logo_square_updated_at,
      logo_wide_updated_at: project.logo_wide_updated_at,
      custom_domain: customDomain
        ? { hostname: customDomain.hostname, status: customDomain.status }
        : null,
    },
    organization: project.organization_id
      ? { id: project.organization_id, name: project.organization_name ?? "" }
      : null,
    settings: {
      features: project.features,
      ai_enabled: project.ai_enabled === 1,
      ai_summarization_type: project.ai_summarization_type,
      graph_enabled: project.graph_enabled === 1,
      published_graph_enabled: project.published_graph_enabled === 1,
    },
    members: {
      accepted: memberCounts?.accepted ?? 0,
      pending: memberCounts?.pending ?? 0,
      by_role: byRole,
      list: members.map((m) => ({
        id: m.id,
        user_id: m.user_id,
        name: m.name,
        email: m.email,
        role: m.role,
        accepted: m.accepted === 1,
        created_at: m.created_at,
      })),
    },
    content: {
      docs: {
        total: totalDocs,
        published: publishedDocs,
        drafts: totalDocs - publishedDocs,
        with_ai_summary: aiSummaries?.n ?? 0,
      },
      folders: folderCount?.n ?? 0,
      files: { count: fileStats?.n ?? 0, total_bytes: fileStats?.bytes ?? 0 },
    },
  };
}

export { projectsRouter };
