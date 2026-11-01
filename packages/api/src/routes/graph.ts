import { okResponse, errorResponse, Errors, ROLE_RANK, type Session } from "../lib";
import { reindexProject } from "../lib/docLinks";
import type { Env } from "../index";
import { resolveAccess } from "../lib/access";

const REINDEX_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

interface GraphNode {
  id: string;
  title: string;
  links: number;
  tags: string[];
}

interface GraphEdge {
  source: string;
  target: string;
}

// Builds the graph from the stored doc_links rows. Never reindexes: callers
// decide whether the index may be rebuilt first (see reindexIfStale).
export async function buildGraph(
  env: Env,
  projectId: string,
  allowedDocIds: Set<string> | null,
): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
  const [docsResult, edgesResult] = await Promise.all([
    env.DB.prepare("SELECT id, title, tags FROM docs WHERE project_id = ?").bind(projectId).all<{ id: string; title: string; tags: string | null }>(),
    env.DB.prepare("SELECT source_doc_id, target_doc_id FROM doc_links WHERE project_id = ?").bind(projectId).all<{ source_doc_id: string; target_doc_id: string }>(),
  ]);

  const visibleDocs = allowedDocIds
    ? docsResult.results.filter(d => allowedDocIds.has(d.id))
    : docsResult.results;
  if (visibleDocs.length === 0) return { nodes: [], edges: [] };

  const visibleSet = new Set(visibleDocs.map(d => d.id));
  const linkCount = new Map<string, number>(visibleDocs.map(d => [d.id, 0]));
  const edges: GraphEdge[] = [];
  for (const e of edgesResult.results) {
    if (!visibleSet.has(e.source_doc_id) || !visibleSet.has(e.target_doc_id)) continue;
    edges.push({ source: e.source_doc_id, target: e.target_doc_id });
    linkCount.set(e.source_doc_id, (linkCount.get(e.source_doc_id) ?? 0) + 1);
    linkCount.set(e.target_doc_id, (linkCount.get(e.target_doc_id) ?? 0) + 1);
  }

  const nodes: GraphNode[] = visibleDocs.map(d => ({
    id: d.id,
    title: d.title,
    links: linkCount.get(d.id) ?? 0,
    tags: d.tags ? (JSON.parse(d.tags) as string[]) : [],
  }));
  return { nodes, edges };
}

// projects.graph_indexed_at is cleared (NULL) by every create/rename/move/
// trash/restore. Whoever flips it back to non-NULL owns the rebuild: the
// conditional UPDATE is the claim, so concurrent viewers of a stale graph run
// exactly one reindex between them and everyone else serves the stored links.
// An invalidation that lands mid-rebuild re-clears the column, so the next
// viewer (or the daily cron) picks the newer change up. On failure the claim
// is released so the work is retried. Returns whether this caller reindexed.
export async function reindexIfStale(env: Env, projectId: string): Promise<boolean> {
  const claimedAt = new Date().toISOString();
  const claim = await env.DB.prepare(
    "UPDATE projects SET graph_indexed_at = ? WHERE id = ? AND graph_indexed_at IS NULL",
  ).bind(claimedAt, projectId).run();
  if (!claim.meta.changes) return false;
  await runClaimedReindex(env, projectId, claimedAt);
  return true;
}

// Runs the rebuild for a caller that has already set graph_indexed_at =
// claimedAt; on failure puts it back to NULL (unless something else has
// since changed it) so the next viewer or the cron retries.
async function runClaimedReindex(env: Env, projectId: string, claimedAt: string): Promise<void> {
  try {
    await reindexProject(env, projectId);
  } catch (err) {
    await env.DB.prepare("UPDATE projects SET graph_indexed_at = NULL WHERE id = ? AND graph_indexed_at = ?")
      .bind(projectId, claimedAt).run()
      .catch(() => {});
    throw err;
  }
}

const CRON_REINDEX_MAX_PROJECTS = 25;
const CRON_REINDEX_DOC_BUDGET = 2000;

// Daily cron pass: anonymous/public graph views never rebuild the index, so
// sites whose stale graph is only seen publicly are refreshed here. Bounded
// by project count and by total docs (each doc is one R2 read); a site that
// alone exceeds the doc budget is still processed when it comes first.
// Sequential on purpose - this is background work. Returns sites reindexed.
export async function reindexStaleGraphs(env: Env): Promise<number> {
  const candidates = await env.DB.prepare(
    `SELECT s.id, (SELECT COUNT(*) FROM docs d WHERE d.project_id = s.id) AS doc_count
       FROM (SELECT id FROM projects
              WHERE graph_enabled = 1 AND graph_indexed_at IS NULL
              ORDER BY RANDOM() LIMIT ?) s`,
  ).bind(CRON_REINDEX_MAX_PROJECTS).all<{ id: string; doc_count: number }>();
  let reindexed = 0;
  let docsRead = 0;
  for (const c of candidates.results) {
    if (reindexed > 0 && docsRead + c.doc_count > CRON_REINDEX_DOC_BUDGET) break;
    try {
      if (await reindexIfStale(env, c.id)) {
        reindexed++;
        docsRead += c.doc_count;
      }
    } catch (err) {
      console.error(`[graph] cron reindex failed for ${c.id}:`, err);
    }
  }
  return reindexed;
}

export async function handleGraph(
  request: Request,
  env: Env,
  user: Session,
  url: URL,
): Promise<Response> {
  if (request.method !== "GET") return errorResponse(Errors.NOT_FOUND);

  const match = url.pathname.match(/^\/projects\/([^/]+)\/graph$/);
  if (!match) return errorResponse(Errors.NOT_FOUND);
  const projectId = match[1];

  const member = await resolveAccess(env.DB, projectId, user.userId);
  if (!member) return errorResponse(Errors.FORBIDDEN);

  const proj = await env.DB.prepare("SELECT graph_enabled, graph_tag_colors, graph_indexed_at FROM projects WHERE id = ?")
    .bind(projectId).first<{ graph_enabled: number; graph_tag_colors: string | null; graph_indexed_at: string | null }>();
  if (!proj) return errorResponse(Errors.NOT_FOUND);
  if (!proj.graph_enabled) return errorResponse(Errors.FORBIDDEN);

  if (proj.graph_indexed_at === null) {
    try {
      await reindexIfStale(env, projectId);
    } catch (err) {
      // The claim was released; serve the stored links rather than failing.
      console.error(`[graph] reindex failed for ${projectId}:`, err);
    }
  }

  let allowed: Set<string> | null = null;
  if (member.role === "limited") {
    // buildGraph only considers this site's docs, so the shares themselves
    // (idx_doc_shares_project_user) are enough - no docs join needed.
    const shares = await env.DB.prepare(
      "SELECT doc_id FROM doc_shares WHERE project_id = ? AND user_id = ?",
    ).bind(projectId, user.userId).all<{ doc_id: string }>();
    allowed = new Set(shares.results.map(r => r.doc_id));
  }

  const graph = await buildGraph(env, projectId, allowed);
  const tagColors: { tag: string; color: string }[] = proj.graph_tag_colors
    ? (JSON.parse(proj.graph_tag_colors) as { tag: string; color: string }[])
    : [];
  return okResponse({ ...graph, tagColors });
}

export async function handlePublicGraph(
  env: Env,
  url: URL,
): Promise<Response> {
  const match = url.pathname.match(/^\/public\/projects\/([^/]+)\/graph$/);
  if (!match) return errorResponse(Errors.NOT_FOUND);
  const slug = match[1];

  const project = await env.DB.prepare(
    "SELECT id, published_graph_enabled, graph_tag_colors FROM projects WHERE (id = ? OR vanity_slug = ?) AND published_at IS NOT NULL",
  ).bind(slug, slug).first<{ id: string; published_graph_enabled: number; graph_tag_colors: string | null }>();
  if (!project) return errorResponse(Errors.NOT_FOUND);
  if (!project.published_graph_enabled) return errorResponse(Errors.FORBIDDEN);

  // Anonymous traffic never rebuilds the index (no R2 fan-out or write batch
  // per public view): it serves the stored doc_links, which every save keeps
  // current per source doc. Stale sites are rebuilt by an authenticated view,
  // the admin reindex, or the daily cron (reindexStaleGraphs).
  const graph = await buildGraph(env, project.id, null);
  const tagColors: { tag: string; color: string }[] = project.graph_tag_colors
    ? (JSON.parse(project.graph_tag_colors) as { tag: string; color: string }[])
    : [];
  return okResponse({ ...graph, tagColors });
}

export async function handleGraphReindex(
  request: Request,
  env: Env,
  user: Session,
  url: URL,
): Promise<Response> {
  if (request.method !== "POST") return errorResponse(Errors.NOT_FOUND);

  const match = url.pathname.match(/^\/projects\/([^/]+)\/graph\/reindex$/);
  if (!match) return errorResponse(Errors.NOT_FOUND);
  const projectId = match[1];

  const member = await resolveAccess(env.DB, projectId, user.userId);
  if (!member) return errorResponse(Errors.FORBIDDEN);
  if (ROLE_RANK[member.role] < ROLE_RANK["admin"]) return errorResponse(Errors.FORBIDDEN);

  const proj = await env.DB.prepare(
    "SELECT graph_enabled, graph_reindex_available_at FROM projects WHERE id = ?",
  ).bind(projectId).first<{ graph_enabled: number; graph_reindex_available_at: string | null }>();
  if (!proj) return errorResponse(Errors.NOT_FOUND);
  if (!proj.graph_enabled) return errorResponse(Errors.FORBIDDEN);

  const now = Date.now();
  if (proj.graph_reindex_available_at) {
    const availableAt = new Date(proj.graph_reindex_available_at).getTime();
    if (now < availableAt) {
      return Response.json(
        { ok: false, error: "Rate limited", nextAvailableAt: proj.graph_reindex_available_at },
        { status: 429 },
      );
    }
  }

  const nextAvailableAt = new Date(now + REINDEX_COOLDOWN_MS).toISOString();
  // Forced rebuild: mark the index current up front (an invalidation that
  // lands mid-rebuild re-clears it, as with the claim in reindexIfStale).
  const claimedAt = new Date(now).toISOString();
  await env.DB.prepare("UPDATE projects SET graph_reindex_available_at = ?, graph_indexed_at = ? WHERE id = ?")
    .bind(nextAvailableAt, claimedAt, projectId).run();

  await runClaimedReindex(env, projectId, claimedAt);

  return okResponse({ nextAvailableAt });
}
