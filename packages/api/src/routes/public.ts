import { okResponse, errorResponse, Errors, serveR2Object, isMutableFile, isInlineSafeMime, contentDispositionValue, fileContentEtag } from "../lib";
import { parseFrontmatter } from "../lib/frontmatter";
import { presignR2GetUrl, PRESIGN_URL_TTL_SECONDS } from "../lib/r2Presign";
import { authenticate } from "../auth";
import type { Env } from "../index";

export const MAX_REPORT_NOTE_LENGTH = 2000;

// POST /public/projects/:idOrSlug/report - file an abuse report against a
// published site from the public reading view. Anonymous by design (the
// reader may have no account), but when the caller presents a valid session
// token the report is attributed to their user id. IP-rate-limited so the
// button can't be scripted into a flood.
export async function handlePublicReport(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  // CF-Connecting-IP wins when present (edge-set, unspoofable); X-Client-IP is
  // the repo's convention for hops that drop it (frontend worker /api proxy).
  const ip = request.headers.get("CF-Connecting-IP") ?? request.headers.get("X-Client-IP");
  if (env.RATE_LIMITER_REPORT) {
    const { success } = await env.RATE_LIMITER_REPORT.limit({ key: `report:${ip ?? "unknown"}` });
    if (!success) return errorResponse(Errors.RATE_LIMITED);
  }

  let body: { note?: unknown; docId?: unknown };
  try {
    body = await request.json();
  } catch {
    return errorResponse(Errors.BAD_REQUEST);
  }
  const note = typeof body.note === "string" ? body.note.trim() : "";
  if (!note || note.length > MAX_REPORT_NOTE_LENGTH) return errorResponse(Errors.BAD_REQUEST);

  const idOrSlug = decodeURIComponent(url.pathname.split("/")[3] ?? "");
  const project = await env.DB.prepare(
    "SELECT id FROM projects WHERE (id = ? OR vanity_slug = ?) AND published_at IS NOT NULL",
  ).bind(idOrSlug, idOrSlug).first<{ id: string }>();
  if (!project) return errorResponse(Errors.NOT_FOUND);

  // The page the reporter was on, so a reviewer can jump straight to it.
  // Verified against this project (a bogus/foreign docId files as NULL rather
  // than failing the report - the note is the payload, the page is a hint).
  let docId: string | null = null;
  if (typeof body.docId === "string" && body.docId) {
    const doc = await env.DB.prepare("SELECT id FROM docs WHERE id = ? AND project_id = ?")
      .bind(body.docId, project.id).first<{ id: string }>();
    docId = doc?.id ?? null;
  }

  // Best-effort attribution: a bad/expired/disabled-account token must not
  // block the report (the public site never requires auth) - it just files
  // as anonymous.
  let reporterUserId: string | null = null;
  if (request.headers.get("Authorization")) {
    const session = await authenticate(request, env);
    if (session !== null && !(session instanceof Response)) reporterUserId = session.userId;
  }

  await env.DB.prepare(
    "INSERT INTO site_reports (id, project_id, reporter_user_id, reporter_ip, doc_id, note) VALUES (?, ?, ?, ?, ?, ?)",
  ).bind(crypto.randomUUID(), project.id, reporterUserId, ip, docId, note).run();

  return okResponse({ submitted: true }, 201);
}

interface PublicProject {
  id: string;
  name: string;
  description: string | null;
  published_at: string | null;
  vanity_slug: string | null;
  home_doc_id: string | null;
  graph_enabled: number;
  published_graph_enabled: number;
  logo_square_updated_at: string | null;
  logo_wide_updated_at: string | null;
}

interface PublicDoc {
  id: string;
  title: string;
  folder_id: string | null;
  published_at: string | null;
  is_home: number;
  sidebar_position: number | null;
}

interface PublicFolder {
  id: string;
  name: string;
  parent_id: string | null;
}

interface PublicFile {
  id: string;
  name: string;
  mime_type: string;
  size: number;
  folder_id: string | null;
  content_stream_url?: string | null;
}

// Enrich a list of published-site file rows with a presigned direct-from-R2
// stream URL for inline-safe videos (mirrors the authenticated GET /files/:id
// path). Non-video / non-inline-safe rows are returned untouched. Presigning
// returns null when R2 creds are unconfigured, so consumers fall back to the
// in-Worker /public/files/:id/content streaming route. Rows are presigned
// concurrently rather than serially.
export async function enrichFilesWithStreamUrls(env: Env, files: PublicFile[]): Promise<PublicFile[]> {
  return Promise.all(
    files.map(async (f) => {
      if (!(f.mime_type.startsWith("video/") && isInlineSafeMime(f.mime_type))) return f;
      // A presign failure must degrade to the in-Worker route for that one file
      // (content_stream_url: null), never reject the whole list - otherwise a
      // single signing error would 500 the entire published page (nav + docs +
      // files), not just the offending video.
      try {
        // Force a Worker-controlled Content-Type/Disposition on the header-less
        // direct R2 path; contentDispositionValue handles quoting, control
        // chars, and non-ASCII names (RFC 5987).
        const content_stream_url = await presignR2GetUrl(env, `files/${f.id}`, PRESIGN_URL_TTL_SECONDS, {
          contentType: f.mime_type,
          contentDisposition: contentDispositionValue("inline", f.name),
        });
        return { ...f, content_stream_url };
      } catch {
        return { ...f, content_stream_url: null };
      }
    }),
  );
}

export async function handlePublic(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  if (request.method !== "GET") return errorResponse(Errors.NOT_FOUND);

  const parts = url.pathname.replace(/^\/public\/?/, "").split("/");

  // /public/site-by-host?host=docs.acme.com - resolve a mapped custom domain to
  // its (published) site so the frontend can render it at the domain root. Only
  // resolves published sites; an unpublished/unmapped host returns 404.
  if (parts[0] === "site-by-host") {
    const host = (url.searchParams.get("host") ?? "").trim().toLowerCase().replace(/\.$/, "");
    if (!host) return errorResponse(Errors.NOT_FOUND);
    const row = await env.DB.prepare(
      `SELECT p.id, p.vanity_slug, p.name, p.home_doc_id
         FROM project_custom_domains cd
         JOIN projects p ON p.id = cd.project_id
        WHERE cd.hostname = ? AND p.published_at IS NOT NULL`,
    ).bind(host).first<{ id: string; vanity_slug: string | null; name: string; home_doc_id: string | null }>();
    if (!row) return errorResponse(Errors.NOT_FOUND);
    // Every visit to a custom domain resolves the host before anything renders,
    // so let edges/browsers reuse the answer briefly.
    const res = okResponse({ projectId: row.id, vanitySlug: row.vanity_slug, name: row.name, homeDocId: row.home_doc_id });
    res.headers.set("Cache-Control", "public, max-age=60");
    return res;
  }

  // /public/projects/:id/logo/:variant - serve the site logo for a published project.
  // variant ∈ {"square","wide"}.
  if (parts[0] === "projects" && parts[1] && parts[2] === "logo" && parts[3]) {
    const variant = parts[3];
    if (variant !== "square" && variant !== "wide") return errorResponse(Errors.NOT_FOUND);
    const projectIdOrSlug = parts[1];
    const column = variant === "square" ? "logo_square_updated_at" : "logo_wide_updated_at";
    const project = await env.DB.prepare(
      `SELECT id FROM projects WHERE (id = ? OR vanity_slug = ?) AND published_at IS NOT NULL AND ${column} IS NOT NULL`,
    ).bind(projectIdOrSlug, projectIdOrSlug).first<{ id: string }>();
    if (!project) return errorResponse(Errors.NOT_FOUND);
    const obj = await env.ASSETS.get(`site-logos/${project.id}-${variant}`);
    if (!obj) return errorResponse(Errors.NOT_FOUND);
    return new Response(await obj.arrayBuffer(), {
      status: 200,
      headers: {
        "Content-Type": obj.httpMetadata?.contentType ?? "application/octet-stream",
        "Cache-Control": "public, max-age=3600",
      },
    });
  }

  // /public/projects/:id
  if (parts[0] === "projects" && parts[1]) {
    const projectId = parts[1];
    const project = await env.DB.prepare(
      "SELECT id, name, description, published_at, vanity_slug, home_doc_id, graph_enabled, published_graph_enabled, logo_square_updated_at, logo_wide_updated_at FROM projects WHERE (id = ? OR vanity_slug = ?) AND published_at IS NOT NULL",
    ).bind(projectId, projectId).first<PublicProject>();
    if (!project) return errorResponse(Errors.NOT_FOUND);

    const docs = await env.DB.prepare(
      "SELECT id, title, folder_id, sidebar_position, CASE WHEN ? = id THEN 1 ELSE 0 END AS is_home FROM docs WHERE project_id = ? ORDER BY CASE WHEN sidebar_position IS NULL THEN 1 ELSE 0 END, sidebar_position ASC, title ASC",
    ).bind(project.home_doc_id ?? "", project.id).all<Pick<PublicDoc, "id" | "title" | "folder_id" | "sidebar_position" | "is_home">>();

    const folders = await env.DB.prepare(
      "SELECT id, name, parent_id FROM folders WHERE project_id = ? ORDER BY name ASC",
    ).bind(project.id).all<PublicFolder>();

    const files = await env.DB.prepare(
      "SELECT id, name, mime_type, size, folder_id FROM files WHERE project_id = ? ORDER BY name ASC",
    ).bind(project.id).all<PublicFile>();
    const enrichedFiles = await enrichFilesWithStreamUrls(env, files.results);

    return okResponse({ ...project, docs: docs.results, folders: folders.results, files: enrichedFiles });
  }

  // /public/docs/:projectId/:docId
  if (parts[0] === "docs" && parts[1] && parts[2]) {
    const projectIdOrSlug = parts[1];
    const docId = parts[2];

    const project = await env.DB.prepare(
      `SELECT p.id, p.name, p.published_at, p.vanity_slug, p.home_doc_id, p.graph_enabled, p.published_graph_enabled, p.logo_square_updated_at, p.logo_wide_updated_at,
              CASE WHEN cd.status = 'active' THEN cd.hostname END AS custom_domain
         FROM projects p LEFT JOIN project_custom_domains cd ON cd.project_id = p.id
        WHERE p.id = ? OR p.vanity_slug = ?`,
    ).bind(projectIdOrSlug, projectIdOrSlug).first<Pick<PublicProject, "id" | "name" | "published_at" | "vanity_slug" | "home_doc_id" | "graph_enabled" | "published_graph_enabled" | "logo_square_updated_at" | "logo_wide_updated_at"> & { custom_domain: string | null }>();
    if (!project) return errorResponse(Errors.NOT_FOUND);
    const projectId = project.id;

    const doc = await env.DB.prepare(
      "SELECT id, title, published_at, show_last_updated, show_heading, updated_at FROM docs WHERE id = ? AND project_id = ?",
    ).bind(docId, projectId).first<PublicDoc & { show_last_updated: number; show_heading: number; updated_at: string }>();
    if (!doc) return errorResponse(Errors.NOT_FOUND);

    const sitePublished = project.published_at !== null;
    const docPublished = doc.published_at !== null;
    // A published site intentionally exposes all of its docs regardless of
    // their per-doc published_at (the per-doc flag exists for other reasons).
    // Only block when neither the site nor the doc is published.
    if (!sitePublished && !docPublished) return errorResponse(Errors.NOT_FOUND);

    const r2Object = await env.ASSETS.get(`${projectId}/${docId}`);
    const content = r2Object ? await r2Object.text() : "";
    const fm = parseFrontmatter(content);

    let docs: Pick<PublicDoc, "id" | "title" | "folder_id">[] | null = null;
    let folders: PublicFolder[] | null = null;
    let files: PublicFile[] | null = null;
    if (sitePublished) {
      const docsResult = await env.DB.prepare(
        "SELECT id, title, folder_id, sidebar_position, CASE WHEN ? = id THEN 1 ELSE 0 END AS is_home FROM docs WHERE project_id = ? ORDER BY CASE WHEN sidebar_position IS NULL THEN 1 ELSE 0 END, sidebar_position ASC, title ASC",
      ).bind(project.home_doc_id ?? "", projectId).all<Pick<PublicDoc, "id" | "title" | "folder_id" | "sidebar_position" | "is_home">>();
      docs = docsResult.results;

      const foldersResult = await env.DB.prepare(
        "SELECT id, name, parent_id FROM folders WHERE project_id = ? ORDER BY name ASC",
      ).bind(projectId).all<PublicFolder>();
      folders = foldersResult.results;

      const filesResult = await env.DB.prepare(
        "SELECT id, name, mime_type, size, folder_id FROM files WHERE project_id = ? ORDER BY name ASC",
      ).bind(projectId).all<PublicFile>();
      files = await enrichFilesWithStreamUrls(env, filesResult.results);
    }

    return okResponse({
      doc: { id: doc.id, title: doc.title, display_title: fm.title ?? null, hide_title: fm.hide_title ?? null, description: fm.description ?? null, image: fm.image ?? null, content, showHeading: doc.show_heading !== 0, showLastUpdated: doc.show_last_updated !== 0, updatedAt: doc.updated_at },
      sitePublished,
      project: { id: project.id, name: project.name, vanity_slug: project.vanity_slug ?? null, home_doc_id: project.home_doc_id ?? null, graph_enabled: project.graph_enabled, published_graph_enabled: project.published_graph_enabled, logo_square_updated_at: project.logo_square_updated_at ?? null, logo_wide_updated_at: project.logo_wide_updated_at ?? null, custom_domain: project.custom_domain ?? null },
      docs,
      folders,
      files,
    });
  }

  // /public/files/:id/stream-url - mint a FRESH presigned direct-from-R2 URL for
  // an inline-safe video on a published site. The URLs baked into the file lists
  // carry the PRESIGN_URL_TTL_SECONDS (3h) TTL and a published page can sit open
  // longer than that, so the player re-signs here on a playback error instead of
  // dropping to the in-Worker route. Returns { url: null } when presign is off or
  // the file isn't an inline-safe video (the player keeps the Worker route).
  if (parts[0] === "files" && parts[1] && parts[2] === "stream-url") {
    const fileId = parts[1];
    const contextProjectId = url.searchParams.get("projectId");
    const meta = await env.DB.prepare(
      "SELECT f.id, f.name, f.mime_type, f.size, f.folder_id, p.published_at FROM files f JOIN projects p ON p.id = f.project_id WHERE f.id = ?" +
        (contextProjectId ? " AND (p.id = ? OR p.vanity_slug = ?)" : ""),
    ).bind(...(contextProjectId ? [fileId, contextProjectId, contextProjectId] : [fileId])).first<PublicFile & { published_at: string | null }>();
    if (!meta || !meta.published_at) return errorResponse(Errors.NOT_FOUND);

    const [enriched] = await enrichFilesWithStreamUrls(env, [
      { id: meta.id, name: meta.name, mime_type: meta.mime_type, size: meta.size, folder_id: meta.folder_id },
    ]);
    return okResponse({ url: enriched.content_stream_url ?? null });
  }

  // /public/files/:id?projectId= - file metadata (name/mime/size) from a
  // published project. Used by the document file-embed widget (```file fence)
  // to label its download card on the published site, where the authenticated
  // GET /files/:id is unavailable.
  if (parts[0] === "files" && parts[1] && !parts[2]) {
    const fileId = parts[1];
    const contextProjectId = url.searchParams.get("projectId");
    const meta = await env.DB.prepare(
      "SELECT f.id, f.name, f.mime_type, f.size, p.published_at FROM files f JOIN projects p ON p.id = f.project_id WHERE f.id = ?" +
        (contextProjectId ? " AND (p.id = ? OR p.vanity_slug = ?)" : ""),
    ).bind(...(contextProjectId ? [fileId, contextProjectId, contextProjectId] : [fileId])).first<{ id: string; name: string; mime_type: string; size: number; published_at: string | null }>();
    if (!meta || !meta.published_at) return errorResponse(Errors.NOT_FOUND);
    return okResponse({ id: meta.id, name: meta.name, mime_type: meta.mime_type, size: meta.size });
  }

  // /public/files/:id/content - serve a file from a published project. Drawings
  // (mutable files) version their ETag with updated_at and serve no-cache so an
  // edit shows up on the published site; immutable media keep the long cache.
  if (parts[0] === "files" && parts[1] && parts[2] === "content") {
    const fileId = parts[1];
    const contextProjectId = url.searchParams.get("projectId");
    const meta = await env.DB.prepare(
      "SELECT f.mime_type, f.name, f.size, f.updated_at, p.published_at FROM files f JOIN projects p ON p.id = f.project_id WHERE f.id = ?" +
        (contextProjectId ? " AND (p.id = ? OR p.vanity_slug = ?)" : ""),
    ).bind(...(contextProjectId ? [fileId, contextProjectId, contextProjectId] : [fileId])).first<{ mime_type: string; name: string; size: number; updated_at: string | null; published_at: string | null }>();
    if (!meta || !meta.published_at) return errorResponse(Errors.NOT_FOUND);

    const mutable = isMutableFile(meta.mime_type);
    return serveR2Object(env.ASSETS, `files/${fileId}`, {
      mimeType: meta.mime_type,
      filename: meta.name,
      size: meta.size,
      etag: fileContentEtag(fileId, meta.updated_at),
      cacheControl: mutable ? "public, no-cache" : "public, max-age=3600",
      request,
    });
  }

  return errorResponse(Errors.NOT_FOUND);
}
