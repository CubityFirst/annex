import { parseFrontmatter } from "./frontmatter";
import type { Env } from "../index";

export interface DocRow {
  id: string;
  title: string;
  folder_id: string | null;
}

export interface FolderRow {
  id: string;
  name: string;
  parent_id: string | null;
}

const WIKILINK_RE = /\[\[([^\]#|]+?)(?:#[^\]|]+?)?(?:\|[^\]]+?)?\]\]/g;
const MD_DOC_LINK_RE = /\]\(doc:\/\/([^)\s#]+)(?:#[^)]*)?\)/g;
const MD_REL_LINK_RE = /\]\(([^)\s#]+\.md)(?:#[^)]*)?\)/g;

export function extractRefs(content: string): string[] {
  const refs: string[] = [];
  let m: RegExpExecArray | null;
  WIKILINK_RE.lastIndex = 0;
  while ((m = WIKILINK_RE.exec(content)) !== null) refs.push(m[1]);
  MD_DOC_LINK_RE.lastIndex = 0;
  while ((m = MD_DOC_LINK_RE.exec(content)) !== null) {
    try { refs.push(decodeURIComponent(m[1])); } catch { refs.push(m[1]); }
  }
  MD_REL_LINK_RE.lastIndex = 0;
  while ((m = MD_REL_LINK_RE.exec(content)) !== null) {
    let title = m[1];
    if (title.startsWith("./")) title = title.slice(2);
    if (title.endsWith(".md")) title = title.slice(0, -3);
    try { refs.push(decodeURIComponent(title)); } catch { refs.push(title); }
  }
  return refs;
}

export function buildFolderPaths(folders: FolderRow[]): Map<string, string> {
  const byId = new Map(folders.map(f => [f.id, f]));
  const cache = new Map<string, string>();
  function getPath(id: string): string {
    if (cache.has(id)) return cache.get(id)!;
    const folder = byId.get(id);
    if (!folder) return "";
    const path = folder.parent_id ? getPath(folder.parent_id) + "/" + folder.name : folder.name;
    cache.set(id, path);
    return path;
  }
  for (const f of folders) getPath(f.id);
  return cache;
}

export interface ResolutionContext {
  docs: DocRow[];
  byId: Map<string, DocRow>;
  byTitle: Map<string, DocRow>;
  fullPaths: { doc: DocRow; segments: string[] }[];
}

export function buildResolutionContext(docs: DocRow[], folders: FolderRow[]): ResolutionContext {
  const folderPaths = buildFolderPaths(folders);
  const byId = new Map<string, DocRow>(docs.map(d => [d.id, d]));
  const byTitle = new Map<string, DocRow>();
  const fullPaths: { doc: DocRow; segments: string[] }[] = [];
  for (const d of docs) {
    const key = d.title.toLowerCase().trim();
    if (!byTitle.has(key)) byTitle.set(key, d);
    const folderPath = d.folder_id ? folderPaths.get(d.folder_id) ?? "" : "";
    const fullPath = folderPath ? folderPath + "/" + d.title : d.title;
    fullPaths.push({ doc: d, segments: fullPath.toLowerCase().split("/").map(s => s.trim()) });
  }
  return { docs, byId, byTitle, fullPaths };
}

export function resolveDoc(rawTitle: string, ctx: ResolutionContext): DocRow | undefined {
  const trimmed = rawTitle.trim();
  if (!trimmed) return undefined;

  if (/^id:/i.test(trimmed)) {
    return ctx.byId.get(trimmed.slice(3).trim());
  }

  const segments = trimmed.toLowerCase().split("/").map(s => s.trim());
  if (segments.length === 1) {
    return ctx.byTitle.get(segments[0]);
  }

  for (const { doc, segments: full } of ctx.fullPaths) {
    if (segments.length > full.length) continue;
    const offset = full.length - segments.length;
    if (segments.every((seg, i) => seg === full[offset + i])) return doc;
  }
  return undefined;
}

export function computeLinksForDoc(
  sourceId: string,
  content: string,
  ctx: ResolutionContext,
): Set<string> {
  const targets = new Set<string>();
  for (const ref of extractRefs(content)) {
    const target = resolveDoc(ref, ctx);
    if (target && target.id !== sourceId) targets.add(target.id);
  }
  return targets;
}

async function fetchProjectStructure(env: Env, projectId: string): Promise<{ docs: DocRow[]; folders: FolderRow[] }> {
  const [docsResult, foldersResult] = await Promise.all([
    env.DB.prepare("SELECT id, title, folder_id FROM docs WHERE project_id = ?").bind(projectId).all<DocRow>(),
    env.DB.prepare("SELECT id, name, parent_id FROM folders WHERE project_id = ?").bind(projectId).all<FolderRow>(),
  ]);
  return { docs: docsResult.results, folders: foldersResult.results };
}

async function replaceLinksForSource(env: Env, projectId: string, sourceId: string, targets: Set<string>): Promise<void> {
  const stmts: D1PreparedStatement[] = [
    env.DB.prepare("DELETE FROM doc_links WHERE source_doc_id = ?").bind(sourceId),
  ];
  for (const t of targets) {
    stmts.push(
      env.DB.prepare("INSERT OR IGNORE INTO doc_links (source_doc_id, target_doc_id, project_id) VALUES (?, ?, ?)")
        .bind(sourceId, t, projectId),
    );
  }
  await env.DB.batch(stmts);
}

export async function indexDocLinks(env: Env, projectId: string, sourceId: string, content: string): Promise<void> {
  const { docs, folders } = await fetchProjectStructure(env, projectId);
  const ctx = buildResolutionContext(docs, folders);
  const targets = computeLinksForDoc(sourceId, content, ctx);
  await replaceLinksForSource(env, projectId, sourceId, targets);
}

// Rebuilds every doc_links row for the project from the live R2 bodies.
// Does NOT touch projects.graph_indexed_at: callers own that (routes/graph.ts
// claims the job atomically before calling this, so concurrent viewers don't
// each repeat the N R2 reads + write batch).
export async function reindexProject(env: Env, projectId: string): Promise<void> {
  const [{ docs, folders }, tagRows] = await Promise.all([
    fetchProjectStructure(env, projectId),
    env.DB.prepare("SELECT id, tags FROM docs WHERE project_id = ?").bind(projectId).all<{ id: string; tags: string | null }>(),
  ]);
  const ctx = buildResolutionContext(docs, folders);
  const storedTags = new Map(tagRows.results.map(r => [r.id, r.tags]));

  const contents = await Promise.all(
    docs.map(d => env.ASSETS.get(`${projectId}/${d.id}`).then(o => o ? o.text() : "")),
  );

  const stmts: D1PreparedStatement[] = [
    env.DB.prepare("DELETE FROM doc_links WHERE project_id = ?").bind(projectId),
  ];
  for (let i = 0; i < docs.length; i++) {
    const content = contents[i];
    const targets = computeLinksForDoc(docs[i].id, content, ctx);
    for (const t of targets) {
      stmts.push(
        env.DB.prepare("INSERT OR IGNORE INTO doc_links (source_doc_id, target_doc_id, project_id) VALUES (?, ?, ?)")
          .bind(docs[i].id, t, projectId),
      );
    }
    // Every save path (createDoc, applyDocUpdate, snapshotDocRevision) keeps
    // docs.tags in step with the body, so only write the rare row that has
    // drifted (e.g. a body last saved before tags were tracked) rather than
    // one UPDATE per doc on every reindex.
    const fmTags = parseFrontmatter(content).tags;
    const tags = fmTags ? JSON.stringify(fmTags) : null;
    if (storedTags.has(docs[i].id) && storedTags.get(docs[i].id) !== tags) {
      stmts.push(env.DB.prepare("UPDATE docs SET tags = ? WHERE id = ?").bind(tags, docs[i].id));
    }
  }
  await env.DB.batch(stmts);
}

export async function invalidateProjectGraphIndex(env: Env, projectId: string): Promise<void> {
  await env.DB.prepare("UPDATE projects SET graph_indexed_at = NULL WHERE id = ?").bind(projectId).run();
}
