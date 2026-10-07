import { Zip, ZipPassThrough } from "fflate";
import { errorResponse, Errors, ROLE_RANK, contentDispositionValue, type Role, type Session } from "../lib";
import type { Env } from "../index";
import { resolveRole } from "../lib/access";

function sanitizeSegment(name: string): string {
  const cleaned = name
    .replace(/[/\\:*?"<>|]/g, "_")
    .replace(/[\x00-\x1f\x7f]/g, "_")
    .replace(/[. ]+$/, "")
    .slice(0, 200);
  return cleaned || "untitled";
}

function buildFolderPaths(folders: { id: string; name: string; parent_id: string | null }[]): Map<string, string> {
  const byId = new Map(folders.map(f => [f.id, f]));
  const paths = new Map<string, string>();

  function getPath(id: string): string {
    if (paths.has(id)) return paths.get(id)!;
    const folder = byId.get(id);
    if (!folder) return "";
    const segment = sanitizeSegment(folder.name);
    const path = folder.parent_id ? `${getPath(folder.parent_id)}/${segment}` : segment;
    paths.set(id, path);
    return path;
  }

  for (const f of folders) getPath(f.id);
  return paths;
}

function deduplicateName(dirCounts: Map<string, Map<string, number>>, dir: string, name: string): string {
  if (!dirCounts.has(dir)) dirCounts.set(dir, new Map());
  const counts = dirCounts.get(dir)!;
  const lower = name.toLowerCase();
  if (!counts.has(lower)) {
    counts.set(lower, 1);
    return name;
  }
  const n = counts.get(lower)! + 1;
  counts.set(lower, n);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
}

export async function handleProjectExport(
  request: Request,
  env: Env,
  user: Session,
  url: URL,
): Promise<Response> {
  if (request.method !== "GET") return errorResponse(Errors.NOT_FOUND);

  const projectId = url.pathname.replace(/^\/projects\//, "").replace(/\/export$/, "");
  if (!projectId) return errorResponse(Errors.BAD_REQUEST);

  const role = await resolveRole(env.DB, projectId, user.userId);
  if (role === null) return errorResponse(Errors.NOT_FOUND);
  if (ROLE_RANK[role] < ROLE_RANK["admin"]) return errorResponse(Errors.FORBIDDEN);

  const [projectRow, docsResult, filesResult, foldersResult] = await Promise.all([
    env.DB.prepare("SELECT name FROM projects WHERE id = ?").bind(projectId).first<{ name: string }>(),
    env.DB.prepare("SELECT id, title, folder_id FROM docs WHERE project_id = ?").bind(projectId).all<{ id: string; title: string; folder_id: string | null }>(),
    env.DB.prepare("SELECT id, name, folder_id FROM files WHERE project_id = ?").bind(projectId).all<{ id: string; name: string; folder_id: string | null }>(),
    env.DB.prepare("SELECT id, name, parent_id, type FROM folders WHERE project_id = ?").bind(projectId).all<{ id: string; name: string; parent_id: string | null; type: string }>(),
  ]);

  if (!projectRow) return errorResponse(Errors.NOT_FOUND);

  const docFolders = foldersResult.results.filter(f => f.type === "docs");
  const fileFolders = foldersResult.results.filter(f => f.type === "files");
  const docFolderPaths = buildFolderPaths(docFolders);
  const fileFolderPaths = buildFolderPaths(fileFolders);

  const zipName = sanitizeSegment(projectRow.name);
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();

  const zip = new Zip((err, data, final) => {
    if (err) {
      writer.abort(err);
      return;
    }
    writer.write(data);
    if (final) writer.close();
  });

  // Stream the zip asynchronously; return the readable side immediately
  (async () => {
    const dirCounts = new Map<string, Map<string, number>>();

    for (const doc of docsResult.results) {
      const dir = doc.folder_id ? (docFolderPaths.get(doc.folder_id) ?? "") : "";
      const rawName = `${sanitizeSegment(doc.title)}.md`;
      const entryName = deduplicateName(dirCounts, dir, rawName);
      const entryPath = dir ? `${dir}/${entryName}` : entryName;

      const file = new ZipPassThrough(entryPath);
      zip.add(file);

      const obj = await env.ASSETS.get(`${projectId}/${doc.id}`);
      if (obj) {
        const reader = obj.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          file.push(value, false);
        }
      }
      file.push(new Uint8Array(0), true);
    }

    for (const f of filesResult.results) {
      const dir = f.folder_id ? (fileFolderPaths.get(f.folder_id) ?? "") : "";
      const entryName = deduplicateName(dirCounts, dir, f.name || "untitled");
      const entryPath = dir ? `${dir}/${entryName}` : entryName;

      const file = new ZipPassThrough(entryPath);
      zip.add(file);

      const obj = await env.ASSETS.get(`files/${f.id}`);
      if (obj) {
        const reader = obj.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          file.push(value, false);
        }
      }
      file.push(new Uint8Array(0), true);
    }

    zip.end();
  })().catch(err => writer.abort(err));

  return new Response(readable, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": contentDispositionValue("attachment", `${zipName}.zip`),
    },
  });
}
