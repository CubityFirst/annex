import { okResponse, errorResponse, Errors, serveR2Object } from "../lib";
import { parseFrontmatter } from "../lib/frontmatter";
import type { Env } from "../index";

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
}

export async function handlePublic(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  if (request.method !== "GET") return errorResponse(Errors.NOT_FOUND);

  const parts = url.pathname.replace(/^\/public\/?/, "").split("/");

  // /public/site-by-host?host=docs.acme.com — resolve a mapped custom domain to
  // its (published) site so the frontend can render it at the domain root. Only
  // resolves published sites; an unpublished/unmapped host returns 404.
  if (parts[0] === "site-by-host") {
    const host = (url.searchParams.get("host") ?? "").trim().toLowerCase().replace(/\.$/, "");
    if (!host) return errorResponse(Errors.NOT_FOUND);
    const row = await env.DB.prepare(
      `SELECT p.id, p.vanity_slug, p.name
         FROM project_custom_domains cd
         JOIN projects p ON p.id = cd.project_id
        WHERE cd.hostname = ? AND p.published_at IS NOT NULL`,
    ).bind(host).first<{ id: string; vanity_slug: string | null; name: string }>();
    if (!row) return errorResponse(Errors.NOT_FOUND);
    return okResponse({ projectId: row.id, vanitySlug: row.vanity_slug, name: row.name });
  }

  // /public/projects/:id/logo/:variant — serve the site logo for a published project.
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

    return okResponse({ ...project, docs: docs.results, folders: folders.results, files: files.results });
  }

  // /public/docs/:projectId/:docId
  if (parts[0] === "docs" && parts[1] && parts[2]) {
    const projectIdOrSlug = parts[1];
    const docId = parts[2];

    const project = await env.DB.prepare(
      "SELECT id, name, published_at, vanity_slug, home_doc_id, graph_enabled, published_graph_enabled, logo_square_updated_at, logo_wide_updated_at FROM projects WHERE id = ? OR vanity_slug = ?",
    ).bind(projectIdOrSlug, projectIdOrSlug).first<Pick<PublicProject, "id" | "name" | "published_at" | "vanity_slug" | "home_doc_id" | "graph_enabled" | "published_graph_enabled" | "logo_square_updated_at" | "logo_wide_updated_at">>();
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
      files = filesResult.results;
    }

    return okResponse({
      doc: { id: doc.id, title: doc.title, display_title: fm.title ?? null, hide_title: fm.hide_title ?? null, description: fm.description ?? null, image: fm.image ?? null, content, showHeading: doc.show_heading !== 0, showLastUpdated: doc.show_last_updated !== 0, updatedAt: doc.updated_at },
      sitePublished,
      project: { id: project.id, name: project.name, vanity_slug: project.vanity_slug ?? null, home_doc_id: project.home_doc_id ?? null, graph_enabled: project.graph_enabled, published_graph_enabled: project.published_graph_enabled, logo_square_updated_at: project.logo_square_updated_at ?? null, logo_wide_updated_at: project.logo_wide_updated_at ?? null },
      docs,
      folders,
      files,
    });
  }

  // /public/files/:id/content — serve a file from a published project (images only)
  if (parts[0] === "files" && parts[1] && parts[2] === "content") {
    const fileId = parts[1];
    const contextProjectId = url.searchParams.get("projectId");
    const meta = await env.DB.prepare(
      "SELECT f.mime_type, f.name, f.size, p.published_at FROM files f JOIN projects p ON p.id = f.project_id WHERE f.id = ?" +
        (contextProjectId ? " AND (p.id = ? OR p.vanity_slug = ?)" : ""),
    ).bind(...(contextProjectId ? [fileId, contextProjectId, contextProjectId] : [fileId])).first<{ mime_type: string; name: string; size: number; published_at: string | null }>();
    if (!meta || !meta.published_at) return errorResponse(Errors.NOT_FOUND);

    return serveR2Object(env.ASSETS, `files/${fileId}`, {
      mimeType: meta.mime_type,
      filename: meta.name,
      size: meta.size,
      etag: `"${fileId}"`,
      cacheControl: "public, max-age=3600",
      request,
    });
  }

  return errorResponse(Errors.NOT_FOUND);
}
