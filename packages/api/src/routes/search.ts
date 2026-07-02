import { okResponse, errorResponse, Errors, type Session } from "../lib";
import { sanitizeFtsQuery } from "../lib/fts";
import type { Env } from "../index";
import { resolveRole } from "../lib/access";

interface DocSearchResult {
  doc_id: string;
  title: string;
  excerpt: string;
  folder: string | null;
  updated_at: string;
}

interface FileSearchResult {
  file_id: string;
  name: string;
  mime_type: string;
  folder: string | null;
  updated_at: string;
}

interface FolderSearchResult {
  folder_id: string;
  name: string;
  parent: string | null;
}

interface TagSearchRow {
  doc_id: string;
  title: string;
  tags: string;
  folder: string | null;
  updated_at: string;
}

interface TagSearchResult {
  doc_id: string;
  title: string;
  tags: string[];
  folder: string | null;
  updated_at: string;
}

interface SearchResponse {
  docs: Array<DocSearchResult | TagSearchResult>;
  files: FileSearchResult[];
  folders: FolderSearchResult[];
}

function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, m => "\\" + m);
}

export async function handleSearch(
  request: Request,
  env: Env,
  user: Session,
  url: URL,
): Promise<Response> {
  if (request.method !== "GET") return errorResponse(Errors.NOT_FOUND);

  const projectId = url.searchParams.get("projectId");
  const q = url.searchParams.get("q")?.trim();
  const tag = url.searchParams.get("tag")?.trim();
  if (!projectId || (!q && !tag)) return errorResponse(Errors.BAD_REQUEST);

  const role = await resolveRole(env.DB, projectId, user.userId);
  if (!role) return errorResponse(Errors.FORBIDDEN);

  if (tag !== undefined && tag !== null) {
    let rows;
    if (role === "limited") {
      rows = await env.DB.prepare(`
        SELECT d.id AS doc_id, d.title, d.tags, fo.name AS folder, d.updated_at
        FROM docs d
        JOIN doc_shares ds ON ds.doc_id = d.id AND ds.user_id = ?
        LEFT JOIN folders fo ON fo.id = d.folder_id
        WHERE d.project_id = ?
          AND d.tags IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM json_each(d.tags) AS t WHERE LOWER(t.value) LIKE '%' || LOWER(?) || '%'
          )
        ORDER BY d.title COLLATE NOCASE
        LIMIT 20
      `).bind(user.userId, projectId, tag).all<TagSearchRow>();
    } else {
      rows = await env.DB.prepare(`
        SELECT d.id AS doc_id, d.title, d.tags, fo.name AS folder, d.updated_at
        FROM docs d
        LEFT JOIN folders fo ON fo.id = d.folder_id
        WHERE d.project_id = ?
          AND d.tags IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM json_each(d.tags) AS t WHERE LOWER(t.value) LIKE '%' || LOWER(?) || '%'
          )
        ORDER BY d.title COLLATE NOCASE
        LIMIT 20
      `).bind(projectId, tag).all<TagSearchRow>();
    }
    const docs: TagSearchResult[] = rows.results.map(r => ({
      doc_id: r.doc_id,
      title: r.title,
      tags: JSON.parse(r.tags) as string[],
      folder: r.folder,
      updated_at: r.updated_at,
    }));
    return okResponse({ docs, files: [], folders: [] } satisfies SearchResponse);
  }

  const ftsQuery = sanitizeFtsQuery(q!);

  let docsPromise;
  if (role === "limited") {
    docsPromise = env.DB.prepare(`
      SELECT f.doc_id, f.title,
        snippet(docs_fts, 1, '<mark>', '</mark>', '...', 24) AS excerpt,
        fo.name AS folder, d.updated_at,
        bm25(docs_fts, 5.0, 1.0) AS rank
      FROM docs_fts f
      JOIN doc_shares ds ON ds.doc_id = f.doc_id AND ds.user_id = ?
      JOIN docs d ON d.id = f.doc_id
      LEFT JOIN folders fo ON fo.id = d.folder_id
      WHERE docs_fts MATCH ?
        AND f.project_id = ?
      ORDER BY rank
      LIMIT 20
    `).bind(user.userId, ftsQuery, projectId).all<DocSearchResult>();
  } else {
    docsPromise = env.DB.prepare(`
      SELECT f.doc_id, f.title,
        snippet(docs_fts, 1, '<mark>', '</mark>', '...', 24) AS excerpt,
        fo.name AS folder, d.updated_at,
        bm25(docs_fts, 5.0, 1.0) AS rank
      FROM docs_fts f
      JOIN docs d ON d.id = f.doc_id
      LEFT JOIN folders fo ON fo.id = d.folder_id
      WHERE docs_fts MATCH ?
        AND f.project_id = ?
      ORDER BY rank
      LIMIT 20
    `).bind(ftsQuery, projectId).all<DocSearchResult>();
  }

  // Limited members have no file access at all (see routes/files.ts), so
  // filename matches are only surfaced for full members.
  const filesPromise = role === "limited"
    ? Promise.resolve({ results: [] as FileSearchResult[] })
    : env.DB.prepare(`
        SELECT fi.id AS file_id, fi.name, fi.mime_type,
          fo.name AS folder,
          COALESCE(fi.updated_at, fi.created_at) AS updated_at
        FROM files fi
        LEFT JOIN folders fo ON fo.id = fi.folder_id
        WHERE fi.project_id = ?
          AND fi.name LIKE '%' || ? || '%' ESCAPE '\\'
        ORDER BY fi.name COLLATE NOCASE
        LIMIT 10
      `).bind(projectId, escapeLike(q!)).all<FileSearchResult>();

  // Folders are hidden from limited members for the same reason as files:
  // they can only see individually shared docs, never the folder tree.
  const foldersPromise = role === "limited"
    ? Promise.resolve({ results: [] as FolderSearchResult[] })
    : env.DB.prepare(`
        SELECT fo.id AS folder_id, fo.name, p.name AS parent
        FROM folders fo
        LEFT JOIN folders p ON p.id = fo.parent_id
        WHERE fo.project_id = ?
          AND fo.name LIKE '%' || ? || '%' ESCAPE '\\'
        ORDER BY fo.name COLLATE NOCASE
        LIMIT 10
      `).bind(projectId, escapeLike(q!)).all<FolderSearchResult>();

  const [docRows, fileRows, folderRows] = await Promise.all([docsPromise, filesPromise, foldersPromise]);

  return okResponse({
    docs: docRows.results,
    files: fileRows.results,
    folders: folderRows.results,
  } satisfies SearchResponse);
}

export async function handlePublicSearch(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  if (request.method !== "GET") return errorResponse(Errors.NOT_FOUND);

  const projectIdOrSlug = url.searchParams.get("projectId");
  const q = url.searchParams.get("q")?.trim();
  const tag = url.searchParams.get("tag")?.trim();
  if (!projectIdOrSlug || (!q && !tag)) return errorResponse(Errors.BAD_REQUEST);

  const project = await env.DB.prepare(
    "SELECT id FROM projects WHERE (id = ? OR vanity_slug = ?) AND published_at IS NOT NULL",
  ).bind(projectIdOrSlug, projectIdOrSlug).first<{ id: string }>();
  if (!project) return errorResponse(Errors.NOT_FOUND);

  if (tag !== undefined && tag !== null) {
    const rows = await env.DB.prepare(`
      SELECT d.id AS doc_id, d.title, d.tags, fo.name AS folder, d.updated_at
      FROM docs d
      LEFT JOIN folders fo ON fo.id = d.folder_id
      WHERE d.project_id = ?
        AND d.tags IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM json_each(d.tags) AS t WHERE LOWER(t.value) LIKE '%' || LOWER(?) || '%'
        )
      ORDER BY d.title COLLATE NOCASE
      LIMIT 20
    `).bind(project.id, tag).all<TagSearchRow>();
    const docs: TagSearchResult[] = rows.results.map(r => ({
      doc_id: r.doc_id,
      title: r.title,
      tags: JSON.parse(r.tags) as string[],
      folder: r.folder,
      updated_at: r.updated_at,
    }));
    return okResponse({ docs, files: [], folders: [] } satisfies SearchResponse);
  }

  const ftsQuery = sanitizeFtsQuery(q!);

  const results = await env.DB.prepare(`
    SELECT f.doc_id, f.title,
      snippet(docs_fts, 1, '<mark>', '</mark>', '...', 24) AS excerpt,
      fo.name AS folder, d.updated_at,
      bm25(docs_fts, 5.0, 1.0) AS rank
    FROM docs_fts f
    JOIN docs d ON d.id = f.doc_id
    LEFT JOIN folders fo ON fo.id = d.folder_id
    WHERE docs_fts MATCH ?
      AND f.project_id = ?
    ORDER BY rank
    LIMIT 20
  `).bind(ftsQuery, project.id).all<DocSearchResult>();

  // Public sites expose docs only - no file browser, so no file/folder hits.
  return okResponse({ docs: results.results, files: [], folders: [] } satisfies SearchResponse);
}
