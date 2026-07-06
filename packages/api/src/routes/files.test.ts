import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleFiles } from "./files";

vi.mock("../lib/access", () => ({ resolveRole: vi.fn() }));
vi.mock("../lib", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib")>()),
  serveR2Object: vi.fn(),
  folderInProject: vi.fn(),
}));
vi.mock("../lib/contentToken", () => ({
  signContentToken: vi.fn(),
  verifyContentToken: vi.fn(),
}));
vi.mock("../lib/r2Presign", () => ({
  presignR2GetUrl: vi.fn(),
  PRESIGN_URL_TTL_SECONDS: 900,
}));

import { resolveRole } from "../lib/access";
import { serveR2Object, folderInProject } from "../lib";
import { signContentToken, verifyContentToken } from "../lib/contentToken";
import { presignR2GetUrl } from "../lib/r2Presign";

const EXCALIDRAW_MIME = "application/vnd.excalidraw+json";

const user = { userId: "user-1", email: "a@example.com" } as unknown as Parameters<typeof handleFiles>[2];

function makeEnv() {
  const firsts: unknown[] = [];
  const alls: unknown[] = [];
  const runs: unknown[] = [];
  const bindCalls: unknown[][] = [];
  const first = vi.fn(() => Promise.resolve(firsts.shift() ?? null));
  const all = vi.fn(() => Promise.resolve(alls.shift() ?? { results: [] }));
  const run = vi.fn(() => Promise.resolve(runs.shift() ?? { meta: { changes: 1 } }));
  const bind = vi.fn((...args: unknown[]) => { bindCalls.push(args); return { first, all, run }; });
  const prepare = vi.fn((_sql: string) => ({ bind }));
  const put = vi.fn(async () => undefined);
  const del = vi.fn(async () => undefined);
  const get = vi.fn(async () => null);
  return {
    env: {
      DB: { prepare },
      ASSETS: { put, delete: del, get },
      JWT_SECRET: "secret",
    } as unknown as Parameters<typeof handleFiles>[1],
    run,
    put,
    del,
    prepare,
    bindCalls,
    queueFirst: (v: unknown) => firsts.push(v),
    queueAll: (v: unknown) => alls.push(v),
    queueRun: (v: unknown) => runs.push(v),
  };
}

function call(
  env: Parameters<typeof handleFiles>[1],
  method: string,
  path: string,
  body?: unknown,
  u: Parameters<typeof handleFiles>[2] | null = user,
) {
  const url = new URL(`http://localhost${path}`);
  return handleFiles(
    new Request(url.toString(), {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }),
    env, u, url,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveRole).mockResolvedValue("editor");
  vi.mocked(folderInProject).mockResolvedValue(true);
  vi.mocked(verifyContentToken).mockResolvedValue(false);
  vi.mocked(signContentToken).mockResolvedValue("content-token");
  vi.mocked(presignR2GetUrl).mockResolvedValue(null);
  vi.mocked(serveR2Object).mockReturnValue(new Response("bytes", { status: 200 }) as never);
});

describe("handleFiles GET /files/:id/content", () => {
  it("404s when the file doesn't exist", async () => {
    const { env } = makeEnv(); // meta first() → null
    const res = await call(env, "GET", "/files/f1/content");
    expect(res.status).toBe(404);
  });

  it("serves a published file without a session", async () => {
    const { env, queueFirst } = makeEnv();
    queueFirst({ name: "a.png", mime_type: "image/png", size: 3, project_id: "p1", updated_at: null, published_at: "2026" });
    const res = await call(env, "GET", "/files/f1/content", undefined, null);
    expect(res.status).toBe(200);
    expect(serveR2Object).toHaveBeenCalled();
  });

  it("serves via a valid capability token without a session", async () => {
    vi.mocked(verifyContentToken).mockResolvedValue(true);
    const { env, queueFirst } = makeEnv();
    queueFirst({ name: "a.png", mime_type: "image/png", size: 3, project_id: "p1", updated_at: null, published_at: null });
    const res = await call(env, "GET", "/files/f1/content?token=t", undefined, null);
    expect(res.status).toBe(200);
    expect(serveR2Object).toHaveBeenCalled();
  });

  it("401s for an unpublished file with no token and no session", async () => {
    const { env, queueFirst } = makeEnv();
    queueFirst({ name: "a.png", mime_type: "image/png", size: 3, project_id: "p1", updated_at: null, published_at: null });
    const res = await call(env, "GET", "/files/f1/content", undefined, null);
    expect(res.status).toBe(401);
  });

  it("403s for a non-member session", async () => {
    vi.mocked(resolveRole).mockResolvedValue(null);
    const { env, queueFirst } = makeEnv();
    queueFirst({ name: "a.png", mime_type: "image/png", size: 3, project_id: "p1", updated_at: null, published_at: null });
    const res = await call(env, "GET", "/files/f1/content");
    expect(res.status).toBe(403);
  });

  it("403s a limited member with no doc share", async () => {
    vi.mocked(resolveRole).mockResolvedValue("limited");
    const { env, queueFirst } = makeEnv();
    queueFirst({ name: "a.png", mime_type: "image/png", size: 3, project_id: "p1", updated_at: null, published_at: null });
    queueFirst(null); // doc_shares lookup
    const res = await call(env, "GET", "/files/f1/content");
    expect(res.status).toBe(403);
  });

  it("serves a limited member who has a doc share", async () => {
    vi.mocked(resolveRole).mockResolvedValue("limited");
    const { env, queueFirst } = makeEnv();
    queueFirst({ name: "a.png", mime_type: "image/png", size: 3, project_id: "p1", updated_at: null, published_at: null });
    queueFirst({ id: "s1" }); // doc_shares lookup
    const res = await call(env, "GET", "/files/f1/content");
    expect(res.status).toBe(200);
    expect(serveR2Object).toHaveBeenCalled();
  });

  it("serves an authenticated member of an unpublished project", async () => {
    const { env, queueFirst } = makeEnv();
    queueFirst({ name: "a.png", mime_type: "image/png", size: 3, project_id: "p1", updated_at: null, published_at: null });
    const res = await call(env, "GET", "/files/f1/content");
    expect(res.status).toBe(200);
    expect(serveR2Object).toHaveBeenCalled();
  });
});

describe("handleFiles auth gate for non-content ops", () => {
  it("401s without a session", async () => {
    const { env } = makeEnv();
    const res = await call(env, "GET", "/files/f1", undefined, null);
    expect(res.status).toBe(401);
  });
});

describe("handleFiles GET /files/:id", () => {
  it("404s when the file is missing", async () => {
    const { env } = makeEnv();
    const res = await call(env, "GET", "/files/f1");
    expect(res.status).toBe(404);
  });

  it("403s for a non-member", async () => {
    vi.mocked(resolveRole).mockResolvedValue(null);
    const { env, queueFirst } = makeEnv();
    queueFirst({ id: "f1", name: "a.png", mime_type: "image/png", size: 3, project_id: "p1", folder_id: null, uploaded_by: "u", created_at: "x", updated_at: "y" });
    const res = await call(env, "GET", "/files/f1");
    expect(res.status).toBe(403);
  });

  it("403s for a limited member", async () => {
    vi.mocked(resolveRole).mockResolvedValue("limited");
    const { env, queueFirst } = makeEnv();
    queueFirst({ id: "f1", name: "a.png", mime_type: "image/png", size: 3, project_id: "p1", folder_id: null, uploaded_by: "u", created_at: "x", updated_at: "y" });
    const res = await call(env, "GET", "/files/f1");
    expect(res.status).toBe(403);
  });

  it("returns metadata + content token for a non-video file (no stream url)", async () => {
    const { env, queueFirst } = makeEnv();
    queueFirst({ id: "f1", name: "a.png", mime_type: "image/png", size: 3, project_id: "p1", folder_id: null, uploaded_by: "u", created_at: "x", updated_at: "y" });
    const res = await call(env, "GET", "/files/f1");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { content_token: string; content_stream_url: string | null } };
    expect(json.data.content_token).toBe("content-token");
    expect(json.data.content_stream_url).toBeNull();
    expect(presignR2GetUrl).not.toHaveBeenCalled();
  });

  it("presigns a stream url for an inline-safe video", async () => {
    vi.mocked(presignR2GetUrl).mockResolvedValue("https://r2/stream");
    const { env, queueFirst } = makeEnv();
    queueFirst({ id: "f1", name: "v.mp4", mime_type: "video/mp4", size: 3, project_id: "p1", folder_id: null, uploaded_by: "u", created_at: "x", updated_at: "y" });
    const res = await call(env, "GET", "/files/f1");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { content_stream_url: string | null } };
    expect(json.data.content_stream_url).toBe("https://r2/stream");
    expect(presignR2GetUrl).toHaveBeenCalled();
  });
});

describe("handleFiles GET /files (list)", () => {
  it("400s without projectId", async () => {
    const { env } = makeEnv();
    const res = await call(env, "GET", "/files");
    expect(res.status).toBe(400);
  });

  it("403s for a non-member", async () => {
    vi.mocked(resolveRole).mockResolvedValue(null);
    const { env } = makeEnv();
    const res = await call(env, "GET", "/files?projectId=p1");
    expect(res.status).toBe(403);
  });

  it("403s for a limited member", async () => {
    vi.mocked(resolveRole).mockResolvedValue("limited");
    const { env } = makeEnv();
    const res = await call(env, "GET", "/files?projectId=p1");
    expect(res.status).toBe(403);
  });

  it("lists all files for a member", async () => {
    const { env, queueAll } = makeEnv();
    queueAll({ results: [{ id: "f1" }, { id: "f2" }] });
    const res = await call(env, "GET", "/files?projectId=p1");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: unknown[] };
    expect(json.data).toHaveLength(2);
  });

  it("lists files within a folder", async () => {
    const { env, queueAll, prepare, bindCalls } = makeEnv();
    queueAll({ results: [{ id: "f1" }] });
    const res = await call(env, "GET", "/files?projectId=p1&folderId=fl1");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: unknown[] };
    expect(json.data).toHaveLength(1);
    // The folder-scoped branch must filter on the folder column with both binds.
    expect(prepare.mock.calls.some(c => (c[0] as string).includes("f.folder_id = ?"))).toBe(true);
    expect(bindCalls).toContainEqual(["p1", "fl1"]);
  });

  it("lists root files when folderId is present but empty", async () => {
    const { env, queueAll, prepare, bindCalls } = makeEnv();
    queueAll({ results: [] });
    const res = await call(env, "GET", "/files?projectId=p1&folderId=");
    expect(res.status).toBe(200);
    // Empty folderId means "root files" - IS NULL filter, never an equality bind.
    const listSql = prepare.mock.calls.map(c => c[0] as string).filter(s => s.includes("FROM files f"));
    expect(listSql.some(s => s.includes("f.folder_id IS NULL"))).toBe(true);
    expect(listSql.some(s => s.includes("f.folder_id = ?"))).toBe(false);
    expect(bindCalls).toContainEqual(["p1"]);
  });
});

describe("handleFiles POST /files (upload)", () => {
  function uploadReq(env: Parameters<typeof handleFiles>[1], form: FormData) {
    const url = new URL("http://localhost/files");
    return handleFiles(new Request(url.toString(), { method: "POST", body: form }), env, user, url);
  }

  it("400s when not multipart", async () => {
    const { env } = makeEnv();
    const res = await call(env, "POST", "/files", { projectId: "p1" });
    expect(res.status).toBe(400);
  });

  it("400s when file or projectId is missing", async () => {
    const { env } = makeEnv();
    const form = new FormData();
    form.set("projectId", "p1");
    const res = await uploadReq(env, form);
    expect(res.status).toBe(400);
  });

  it("400s when the file exceeds the size limit", async () => {
    const { env } = makeEnv();
    const form = new FormData();
    form.set("file", new File([new Uint8Array(50 * 1024 * 1024 + 1)], "big.bin", { type: "application/octet-stream" }));
    form.set("projectId", "p1");
    const res = await uploadReq(env, form);
    expect(res.status).toBe(400);
  });

  it("403s for a viewer (below editor)", async () => {
    vi.mocked(resolveRole).mockResolvedValue("viewer");
    const { env } = makeEnv();
    const form = new FormData();
    form.set("file", new File([new Uint8Array(8)], "a.png", { type: "image/png" }));
    form.set("projectId", "p1");
    const res = await uploadReq(env, form);
    expect(res.status).toBe(403);
  });

  it("403s for a non-member", async () => {
    vi.mocked(resolveRole).mockResolvedValue(null);
    const { env } = makeEnv();
    const form = new FormData();
    form.set("file", new File([new Uint8Array(8)], "a.png", { type: "image/png" }));
    form.set("projectId", "p1");
    const res = await uploadReq(env, form);
    expect(res.status).toBe(403);
  });

  it("uploads a file (201) for an editor", async () => {
    const { env, put, run } = makeEnv();
    const form = new FormData();
    form.set("file", new File([new Uint8Array(8)], "a.png", { type: "image/png" }));
    form.set("projectId", "p1");
    const res = await uploadReq(env, form);
    expect(res.status).toBe(201);
    expect(put).toHaveBeenCalled();
    expect(run).toHaveBeenCalled();
    const json = (await res.json()) as { data: { name: string; project_id: string } };
    expect(json.data.name).toBe("a.png");
    expect(json.data.project_id).toBe("p1");
  });

  // Server-side MIME derivation (SC-H3): the client-declared file.type must
  // never be stored - the extension (+ magic-byte sniff for raster images)
  // decides. See deriveUploadMime in ../lib.
  const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

  async function uploadedMime(env: ReturnType<typeof makeEnv>["env"], name: string, bytes: Uint8Array, declaredType: string) {
    const form = new FormData();
    form.set("file", new File([bytes as BlobPart], name, { type: declaredType }));
    form.set("projectId", "p1");
    const res = await uploadReq(env, form);
    expect(res.status).toBe(201);
    const json = (await res.json()) as { data: { mime_type: string } };
    return json.data.mime_type;
  }

  it("stores a real PNG named *.png as image/png even when the client lies about the type", async () => {
    const { env, put } = makeEnv();
    expect(await uploadedMime(env, "paste.png", PNG_BYTES, "text/html")).toBe("image/png");
    // The derived MIME (not the declared one) also goes to R2's httpMetadata.
    expect((put.mock.calls[0] as unknown[])[2]).toEqual({ httpMetadata: { contentType: "image/png" } });
  });

  it("refuses an inline-safe image MIME when the magic bytes don't match (payload named *.png)", async () => {
    const { env, bindCalls } = makeEnv();
    const html = new TextEncoder().encode("<script>alert(1)</script>");
    expect(await uploadedMime(env, "evil.png", html, "image/png")).toBe("application/octet-stream");
    // The INSERT must carry the derived MIME, not the declared image/png.
    expect(bindCalls.some((c) => c.includes("application/octet-stream"))).toBe(true);
    expect(bindCalls.some((c) => c.includes("image/png"))).toBe(false);
  });

  it("stores .excalidraw uploads under the vendor MIME (mutability keys off it)", async () => {
    const { env } = makeEnv();
    const scene = new TextEncoder().encode('{"type":"excalidraw"}');
    expect(await uploadedMime(env, "sketch.excalidraw", scene, "application/json")).toBe(EXCALIDRAW_MIME);
  });

  // Upload names are SANITIZED (not rejected like rename) - an OS filename with
  // control chars / separators / absurd length isn't the uploader's fault, but
  // it must never reach the DB verbatim (it feeds Content-Disposition and
  // every rendering surface).
  async function uploadedName(env: ReturnType<typeof makeEnv>["env"], name: string) {
    const form = new FormData();
    form.set("file", new File([new Uint8Array(8)], name, { type: "application/octet-stream" }));
    form.set("projectId", "p1");
    const res = await uploadReq(env, form);
    expect(res.status).toBe(201);
    const json = (await res.json()) as { data: { name: string } };
    return json.data.name;
  }

  it("strips control chars and replaces path separators in upload names", async () => {
    const { env } = makeEnv();
    expect(await uploadedName(env, "a\nb.bin")).toBe("ab.bin");
    expect(await uploadedName(env, "dir/sub\\file.bin")).toBe("dir_sub_file.bin");
  });

  it("truncates a 10k-char upload name to 255", async () => {
    const { env } = makeEnv();
    const stored = await uploadedName(env, "x".repeat(10_000) + ".bin");
    expect(stored.length).toBe(255);
  });

  it("falls back to 'untitled' when the sanitized name is empty", async () => {
    const { env } = makeEnv();
    expect(await uploadedName(env, "")).toBe("untitled");
  });

  it("stores unknown extensions as application/octet-stream ignoring the declared type", async () => {
    const { env } = makeEnv();
    expect(await uploadedMime(env, "payload.xyz", PNG_BYTES, "image/png")).toBe("application/octet-stream");
  });
});

describe("handleFiles PUT /files/:id/content (overwrite drawing)", () => {
  function putContent(env: Parameters<typeof handleFiles>[1], id: string, bytes: Uint8Array, headers?: Record<string, string>) {
    const url = new URL(`http://localhost/files/${id}/content`);
    return handleFiles(new Request(url.toString(), { method: "PUT", body: bytes as BodyInit, headers }), env, user, url);
  }

  it("404s when the file is missing", async () => {
    const { env } = makeEnv();
    const res = await putContent(env, "f1", new Uint8Array([1]));
    expect(res.status).toBe(404);
  });

  it("400s for an immutable (non-drawing) file", async () => {
    const { env, queueFirst } = makeEnv();
    queueFirst({ name: "a.png", mime_type: "image/png", project_id: "p1", updated_at: null });
    const res = await putContent(env, "f1", new Uint8Array([1]));
    expect(res.status).toBe(400);
  });

  it("403s for a viewer", async () => {
    vi.mocked(resolveRole).mockResolvedValue("viewer");
    const { env, queueFirst } = makeEnv();
    queueFirst({ name: "d.excalidraw", mime_type: EXCALIDRAW_MIME, project_id: "p1", updated_at: null });
    const res = await putContent(env, "f1", new Uint8Array([1]));
    expect(res.status).toBe(403);
  });

  it("overwrites a drawing (200) for an editor", async () => {
    const { env, queueFirst, put, run } = makeEnv();
    queueFirst({ name: "d.excalidraw", mime_type: EXCALIDRAW_MIME, project_id: "p1", updated_at: null });
    const res = await putContent(env, "f1", new Uint8Array([1, 2, 3]));
    expect(res.status).toBe(200);
    expect(put).toHaveBeenCalled();
    expect(run).toHaveBeenCalled();
    const json = (await res.json()) as { data: { id: string; size: number } };
    expect(json.data.size).toBe(3);
  });

  // Optimistic concurrency (SC-H4): If-Match carries the content ETag the
  // client loaded ("<id>-<updated_at ms>", the GET path's formula).
  const UPDATED_AT = "2026-01-01T00:00:00.000Z";
  const VERSION = new Date(UPDATED_AT).getTime();

  it("succeeds when If-Match equals the current content ETag", async () => {
    const { env, queueFirst, put } = makeEnv();
    queueFirst({ name: "d.excalidraw", mime_type: EXCALIDRAW_MIME, project_id: "p1", updated_at: UPDATED_AT });
    const res = await putContent(env, "f1", new Uint8Array([1]), { "If-Match": `"f1-${VERSION}"` });
    expect(res.status).toBe(200);
    expect(put).toHaveBeenCalled();
  });

  it("412s a stale If-Match and does NOT write", async () => {
    const { env, queueFirst, put, run } = makeEnv();
    queueFirst({ name: "d.excalidraw", mime_type: EXCALIDRAW_MIME, project_id: "p1", updated_at: UPDATED_AT });
    const res = await putContent(env, "f1", new Uint8Array([1]), { "If-Match": `"f1-${VERSION - 1000}"` });
    expect(res.status).toBe(412);
    const json = (await res.json()) as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain("modified by someone else");
    expect(put).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("keeps last-write-wins when the header is absent (older clients)", async () => {
    const { env, queueFirst, put } = makeEnv();
    queueFirst({ name: "d.excalidraw", mime_type: EXCALIDRAW_MIME, project_id: "p1", updated_at: UPDATED_AT });
    const res = await putContent(env, "f1", new Uint8Array([1]));
    expect(res.status).toBe(200);
    expect(put).toHaveBeenCalled();
  });

  it("treats If-Match: * as matching any current representation (RFC 7232)", async () => {
    const { env, queueFirst, put } = makeEnv();
    queueFirst({ name: "d.excalidraw", mime_type: EXCALIDRAW_MIME, project_id: "p1", updated_at: UPDATED_AT });
    const res = await putContent(env, "f1", new Uint8Array([1]), { "If-Match": "*" });
    expect(res.status).toBe(200);
    expect(put).toHaveBeenCalled();
  });

  it("412s when a concurrent save lands during the body read (conditional UPDATE misses)", async () => {
    const { env, queueFirst, queueRun, put } = makeEnv();
    queueFirst({ name: "d.excalidraw", mime_type: EXCALIDRAW_MIME, project_id: "p1", updated_at: UPDATED_AT });
    // The header precondition passes, but the serializing UPDATE's
    // `WHERE updated_at IS ?` guard matches 0 rows - someone saved in between.
    queueRun({ meta: { changes: 0 } });
    const res = await putContent(env, "f1", new Uint8Array([1]), { "If-Match": `"f1-${VERSION}"` });
    expect(res.status).toBe(412);
    // The conflict is discovered BEFORE the blob write - the loser must not
    // have overwritten the winner's bytes.
    expect(put).not.toHaveBeenCalled();
  });

  it("returns the new content ETag as a response header on save", async () => {
    const { env, queueFirst } = makeEnv();
    queueFirst({ name: "d.excalidraw", mime_type: EXCALIDRAW_MIME, project_id: "p1", updated_at: UPDATED_AT });
    const res = await putContent(env, "f1", new Uint8Array([1]), { "If-Match": `"f1-${VERSION}"` });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { updated_at: string } };
    expect(res.headers.get("ETag")).toBe(`"f1-${new Date(json.data.updated_at).getTime()}"`);
  });

  it("400s from the declared Content-Length before buffering the body (SC-L6)", async () => {
    const { env, queueFirst, put, run } = makeEnv();
    queueFirst({ name: "d.excalidraw", mime_type: EXCALIDRAW_MIME, project_id: "p1", updated_at: null });
    const res = await putContent(env, "f1", new Uint8Array([1]), { "Content-Length": String(50 * 1024 * 1024 + 1) });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { ok: boolean; error: string };
    expect(json.error).toContain("too large");
    expect(put).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });
});

describe("handleFiles PUT /files/:id (move/rename)", () => {
  it("404s when the file is missing", async () => {
    const { env } = makeEnv();
    const res = await call(env, "PUT", "/files/f1", { name: "new" });
    expect(res.status).toBe(404);
  });

  it("403s for a viewer", async () => {
    vi.mocked(resolveRole).mockResolvedValue("viewer");
    const { env, queueFirst } = makeEnv();
    queueFirst({ project_id: "p1" });
    const res = await call(env, "PUT", "/files/f1", { name: "new" });
    expect(res.status).toBe(403);
  });

  it("400s when moving to a folder outside the project", async () => {
    vi.mocked(folderInProject).mockResolvedValue(false);
    const { env, queueFirst } = makeEnv();
    queueFirst({ project_id: "p1" });
    const res = await call(env, "PUT", "/files/f1", { folderId: "bad" });
    expect(res.status).toBe(400);
  });

  it("renames a file for an editor", async () => {
    const { env, queueFirst, run, prepare, bindCalls } = makeEnv();
    queueFirst({ project_id: "p1" }); // meta
    queueFirst({ id: "f1", name: "new" }); // updated select
    const res = await call(env, "PUT", "/files/f1", { name: "new" });
    expect(res.status).toBe(200);
    expect(run).toHaveBeenCalled();
    const json = (await res.json()) as { data: { name: string } };
    expect(json.data.name).toBe("new");
    // The rename must issue a name UPDATE bound to (name, id) - not just echo the select.
    expect(prepare.mock.calls.some(c => (c[0] as string).includes("UPDATE files SET name = ?"))).toBe(true);
    expect(bindCalls).toContainEqual(["new", "f1"]);
  });

  // Rename validation (SC-M6): the name is echoed into Content-Disposition and
  // rendered everywhere, so empty / control chars / path separators / over-long
  // names are refused before touching D1.
  async function expectRenameRejected(name: string) {
    const { env, queueFirst, run } = makeEnv();
    queueFirst({ project_id: "p1" });
    const res = await call(env, "PUT", "/files/f1", { name });
    expect(res.status).toBe(400);
    expect(run).not.toHaveBeenCalled();
  }

  it("400s an empty / whitespace-only rename", async () => {
    await expectRenameRejected("");
    await expectRenameRejected("   ");
  });

  it("400s a rename containing control characters", async () => {
    await expectRenameRejected("a\u0000b.png");
    await expectRenameRejected("a\nb.png");
    await expectRenameRejected("a\u007fb.png");
  });

  it("400s a rename containing path separators", async () => {
    await expectRenameRejected("a/b.png");
    await expectRenameRejected("a\\b.png");
  });

  it("400s a rename longer than 255 characters", async () => {
    await expectRenameRejected("x".repeat(256));
  });

  it("trims and stores a valid rename", async () => {
    const { env, queueFirst, bindCalls } = makeEnv();
    queueFirst({ project_id: "p1" }); // meta
    queueFirst({ id: "f1", name: "ok.png" }); // updated select
    const res = await call(env, "PUT", "/files/f1", { name: "  ok.png  " });
    expect(res.status).toBe(200);
    expect(bindCalls).toContainEqual(["ok.png", "f1"]);
  });

  it("moves a file to a valid folder", async () => {
    const { env, queueFirst, run, prepare, bindCalls } = makeEnv();
    queueFirst({ project_id: "p1" });
    queueFirst({ id: "f1", folder_id: "fl1" });
    const res = await call(env, "PUT", "/files/f1", { folderId: "fl1" });
    expect(res.status).toBe(200);
    expect(run).toHaveBeenCalled();
    // The move must issue a folder_id UPDATE bound to (folderId, id).
    expect(prepare.mock.calls.some(c => (c[0] as string).includes("UPDATE files SET folder_id = ?"))).toBe(true);
    expect(bindCalls).toContainEqual(["fl1", "f1"]);
  });
});

describe("handleFiles DELETE /files/:id", () => {
  it("404s when the file is missing", async () => {
    const { env } = makeEnv();
    const res = await call(env, "DELETE", "/files/f1");
    expect(res.status).toBe(404);
  });

  it("403s for a viewer", async () => {
    vi.mocked(resolveRole).mockResolvedValue("viewer");
    const { env, queueFirst } = makeEnv();
    queueFirst({ project_id: "p1" });
    const res = await call(env, "DELETE", "/files/f1");
    expect(res.status).toBe(403);
  });

  it("deletes the file + R2 blob for an editor", async () => {
    const { env, queueFirst, del, run } = makeEnv();
    queueFirst({ project_id: "p1" });
    const res = await call(env, "DELETE", "/files/f1");
    expect(res.status).toBe(200);
    expect(del).toHaveBeenCalledWith("files/f1");
    expect(run).toHaveBeenCalled();
  });
});

describe("handleFiles unknown route", () => {
  it("404s an unsupported method", async () => {
    const { env, queueFirst } = makeEnv();
    queueFirst({ project_id: "p1" });
    const res = await call(env, "PATCH", "/files/f1");
    expect(res.status).toBe(404);
  });
});
