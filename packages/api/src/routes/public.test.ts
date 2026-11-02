import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../auth", () => ({ authenticate: vi.fn() }));

import { enrichFilesWithStreamUrls, handlePublic, handlePublicReport, MAX_REPORT_NOTE_LENGTH } from "./public";
import { authenticate } from "../auth";
import { createSqliteD1 } from "../test/sqliteD1";
import type { Env } from "../index";

const PRESIGN_ENV = {
  R2_ACCESS_KEY_ID: "AKIAEXAMPLE",
  R2_SECRET_ACCESS_KEY: "secretexamplekey",
  R2_ACCOUNT_ID: "abc123account",
  R2_BUCKET_NAME: "cubedocs-assets",
} as unknown as Env;

const UNCONFIGURED_ENV = {} as unknown as Env;

function file(overrides: Partial<{ id: string; name: string; mime_type: string; size: number; folder_id: string | null }>) {
  return { id: "f1", name: "clip.mp4", mime_type: "video/mp4", size: 100, folder_id: null, ...overrides };
}

describe("enrichFilesWithStreamUrls", () => {
  it("presigns inline-safe videos when R2 is configured", async () => {
    const [row] = await enrichFilesWithStreamUrls(PRESIGN_ENV, [file({})]);
    expect(row.content_stream_url).toBeTruthy();
    const u = new URL(row.content_stream_url!);
    expect(u.host).toBe("abc123account.r2.cloudflarestorage.com");
    expect(u.pathname).toBe("/cubedocs-assets/files/f1");
    expect(u.searchParams.get("response-content-type")).toBe("video/mp4");
    expect(u.searchParams.get("response-content-disposition")).toBe('inline; filename="clip.mp4"');
    expect(u.searchParams.get("X-Amz-Signature")).toBeTruthy();
  });

  it("returns null stream url for videos when presigning is unconfigured", async () => {
    const [row] = await enrichFilesWithStreamUrls(UNCONFIGURED_ENV, [file({})]);
    expect(row.content_stream_url).toBeNull();
  });

  it("never presigns non-video files", async () => {
    const rows = await enrichFilesWithStreamUrls(PRESIGN_ENV, [
      file({ id: "img", name: "pic.png", mime_type: "image/png" }),
      file({ id: "pdf", name: "doc.pdf", mime_type: "application/pdf" }),
      file({ id: "aud", name: "song.mp3", mime_type: "audio/mpeg" }),
    ]);
    for (const r of rows) expect(r.content_stream_url).toBeUndefined();
  });

  it("never presigns non-inline-safe videos (e.g. video/x-matroska)", async () => {
    const [row] = await enrichFilesWithStreamUrls(PRESIGN_ENV, [
      file({ id: "mkv", name: "movie.mkv", mime_type: "video/x-matroska" }),
    ]);
    expect(row.content_stream_url).toBeUndefined();
  });

  it("sanitizes the filename in the content-disposition override", async () => {
    const [row] = await enrichFilesWithStreamUrls(PRESIGN_ENV, [
      file({ id: "f2", name: 'ev"il\n.mp4', mime_type: "video/webm" }),
    ]);
    const u = new URL(row.content_stream_url!);
    // Shared contentDispositionValue: ASCII-only fallback plus the RFC 5987
    // percent-encoded original (quote/newline stay encoded - no injection).
    expect(u.searchParams.get("response-content-disposition")).toBe(
      "inline; filename=\"ev_il_.mp4\"; filename*=UTF-8''ev%22il%0A.mp4",
    );
  });

  it("presigns concurrently and preserves order/other fields", async () => {
    const rows = await enrichFilesWithStreamUrls(PRESIGN_ENV, [
      file({ id: "a", mime_type: "video/mp4" }),
      file({ id: "b", name: "doc.pdf", mime_type: "application/pdf" }),
      file({ id: "c", mime_type: "video/ogg" }),
    ]);
    expect(rows.map(r => r.id)).toEqual(["a", "b", "c"]);
    expect(rows[0].content_stream_url).toBeTruthy();
    expect(rows[1].content_stream_url).toBeUndefined();
    expect(rows[2].content_stream_url).toBeTruthy();
  });
});

// env whose DB.prepare().bind().first() resolves to `row`, plus R2 creds so the
// presign path is live (mirrors PRESIGN_ENV).
function envReturning(row: unknown): Env {
  const first = vi.fn().mockResolvedValue(row);
  const bind = vi.fn().mockReturnValue({ first });
  const prepare = vi.fn().mockReturnValue({ bind });
  return { ...(PRESIGN_ENV as object), DB: { prepare } } as unknown as Env;
}

describe("GET /public/files/:id/stream-url (re-sign endpoint)", () => {
  const url = new URL("http://localhost/public/files/f1/stream-url?projectId=p1");

  it("mints a fresh presigned URL for a published inline-safe video", async () => {
    const env = envReturning({ id: "f1", name: "clip.mp4", mime_type: "video/mp4", size: 100, folder_id: null, published_at: "2026-01-01" });
    const res = await handlePublic(new Request(url), env, url);
    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean; data: { url: string | null } }>();
    expect(body.ok).toBe(true);
    expect(new URL(body.data.url!).host).toBe("abc123account.r2.cloudflarestorage.com");
  });

  it("404s when the file's project is not published", async () => {
    const env = envReturning({ id: "f1", name: "clip.mp4", mime_type: "video/mp4", size: 100, folder_id: null, published_at: null });
    const res = await handlePublic(new Request(url), env, url);
    expect(res.status).toBe(404);
  });

  it("returns url:null for a published non-video file (player keeps the Worker route)", async () => {
    const env = envReturning({ id: "f1", name: "pic.png", mime_type: "image/png", size: 100, folder_id: null, published_at: "2026-01-01" });
    const res = await handlePublic(new Request(url), env, url);
    expect(res.status).toBe(200);
    const body = await res.json<{ data: { url: string | null } }>();
    expect(body.data.url).toBeNull();
  });
});

describe("GET /public/files/:id (metadata for the file-embed widget)", () => {
  const url = new URL("http://localhost/public/files/f1?projectId=p1");

  it("returns name/mime/size for a file on a published project", async () => {
    const env = envReturning({ id: "f1", name: "report.pdf", mime_type: "application/pdf", size: 4096, published_at: "2026-01-01" });
    const res = await handlePublic(new Request(url), env, url);
    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean; data: { id: string; name: string; mime_type: string; size: number; published_at?: unknown } }>();
    expect(body.ok).toBe(true);
    expect(body.data).toEqual({ id: "f1", name: "report.pdf", mime_type: "application/pdf", size: 4096 });
  });

  it("404s when the file's project is not published", async () => {
    const env = envReturning({ id: "f1", name: "report.pdf", mime_type: "application/pdf", size: 4096, published_at: null });
    const res = await handlePublic(new Request(url), env, url);
    expect(res.status).toBe(404);
  });

  it("404s when the file does not exist", async () => {
    const env = envReturning(null);
    const res = await handlePublic(new Request(url), env, url);
    expect(res.status).toBe(404);
  });

  it("scopes the lookup to the projectId (or vanity slug) when provided", async () => {
    const env = envReturning({ id: "f1", name: "report.pdf", mime_type: "application/pdf", size: 4096, published_at: "2026-01-01" });
    await handlePublic(new Request(url), env, url);
    const prepare = (env.DB as unknown as { prepare: ReturnType<typeof vi.fn> }).prepare;
    expect(prepare.mock.calls[0][0]).toContain("p.id = ? OR p.vanity_slug = ?");
    const bind = prepare.mock.results[0].value.bind as ReturnType<typeof vi.fn>;
    expect(bind.mock.calls[0]).toEqual(["f1", "p1", "p1"]);
  });
});

describe("GET /public/projects/:idOrSlug/logo/:variant", () => {
  const pngObject = { arrayBuffer: async () => new ArrayBuffer(4), httpMetadata: { contentType: "image/png" } };

  // envReturning + an ASSETS binding whose get() resolves to `obj`.
  function logoEnv(row: unknown, obj: unknown = pngObject) {
    const env = envReturning(row) as Env & { ASSETS: { get: ReturnType<typeof vi.fn> } };
    (env as { ASSETS?: unknown }).ASSETS = { get: vi.fn().mockResolvedValue(obj) };
    return env;
  }

  function logoUrl(variant: string) {
    return new URL(`http://localhost/public/projects/p1/logo/${variant}`);
  }

  it("serves the logo bytes with public caching", async () => {
    const env = logoEnv({ id: "proj-1" });
    const url = logoUrl("square");
    const res = await handlePublic(new Request(url), env, url);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=3600");
    // R2 key uses the resolved project id (slug lookups must not key by slug).
    expect(env.ASSETS.get).toHaveBeenCalledWith("site-logos/proj-1-square");
  });

  it("404s an unknown variant before touching the DB", async () => {
    const env = logoEnv({ id: "proj-1" });
    const url = logoUrl("bogus");
    const res = await handlePublic(new Request(url), env, url);
    expect(res.status).toBe(404);
    expect((env.DB as unknown as { prepare: ReturnType<typeof vi.fn> }).prepare).not.toHaveBeenCalled();
  });

  it("404s when no publicly reachable project matches", async () => {
    const env = logoEnv(null);
    const url = logoUrl("square");
    const res = await handlePublic(new Request(url), env, url);
    expect(res.status).toBe(404);
    expect(env.ASSETS.get).not.toHaveBeenCalled();
  });

  it("404s when the R2 object is missing", async () => {
    const env = logoEnv({ id: "proj-1" }, null);
    const url = logoUrl("square");
    const res = await handlePublic(new Request(url), env, url);
    expect(res.status).toBe(404);
  });

  it("gates on site publish OR a solo-published doc, never site publish alone", async () => {
    // A solo-published doc exposes the standalone public doc page - whose header
    // renders this logo - for an UNPUBLISHED site, so the gate must accept
    // "unpublished site with at least one published doc". A regression back to
    // a bare `published_at IS NOT NULL` broke exactly this (logo uploaded, one
    // doc shared, site never published -> broken image). Real SQLite, so the
    // gate's SQL is actually evaluated.
    const { db, sqlite } = createSqliteD1();
    const T0 = "2026-01-01T00:00:00.000Z";
    const exec = (sql: string, ...args: (string | null)[]) => sqlite.prepare(sql).run(...args);
    exec("INSERT INTO projects (id, name, owner_id, created_at, vanity_slug, logo_wide_updated_at) VALUES ('solo', 'S', 'u1', ?, 'solo-slug', ?)", T0, T0);
    exec("INSERT INTO docs (id, title, project_id, author_id, created_at, updated_at, published_at) VALUES ('d1', 'D', 'solo', 'u1', ?, ?, ?)", T0, T0, T0);
    exec("INSERT INTO projects (id, name, owner_id, created_at, logo_wide_updated_at) VALUES ('private', 'P', 'u1', ?, ?)", T0, T0);
    exec("INSERT INTO docs (id, title, project_id, author_id, created_at, updated_at) VALUES ('d2', 'D', 'private', 'u1', ?, ?)", T0, T0);
    exec("INSERT INTO projects (id, name, owner_id, created_at, published_at) VALUES ('nologo', 'N', 'u1', ?, ?)", T0, T0);
    const env = { ...logoEnv(null), DB: db } as unknown as Env & { ASSETS: { get: ReturnType<typeof vi.fn> } };
    const get = (idOrSlug: string, variant = "wide") => {
      const url = new URL(`http://localhost/public/projects/${idOrSlug}/logo/${variant}`);
      return handlePublic(new Request(url), env, url);
    };

    expect((await get("solo")).status).toBe(200);
    expect((await get("solo-slug")).status).toBe(200);
    expect(env.ASSETS.get).toHaveBeenLastCalledWith("site-logos/solo-wide");
    expect((await get("private")).status).toBe(404); // unpublished, no published doc
    expect((await get("nologo")).status).toBe(404); // published, but no wide logo uploaded
    expect((await get("solo", "square")).status).toBe(404); // only the wide variant exists
  });
});

describe("GET /public/files/:id/content (header-image fallback for solo-published docs)", () => {
  const PUBLISHED_META = { mime_type: "image/png", name: "banner.png", size: 5, updated_at: null, project_id: "proj-1", published_at: "2026-01-01" };
  const UNPUBLISHED_META = { ...PUBLISHED_META, published_at: null };

  // env for the content route: one meta .first(), one docs-list .all(), and an
  // ASSETS.get that serves file bytes for `files/*` keys and doc content (with
  // frontmatter) for `<projectId>/<docId>` keys.
  function contentEnv(opts: { meta: unknown; docs?: { id: string }[]; docContents?: Record<string, string> }) {
    const preparedSql: string[] = [];
    const bindCalls: unknown[][] = [];
    const first = vi.fn().mockResolvedValue(opts.meta);
    const all = vi.fn().mockResolvedValue({ results: opts.docs ?? [] });
    const bind = vi.fn((...args: unknown[]) => { bindCalls.push(args); return { first, all }; });
    const prepare = vi.fn((sql: string) => { preparedSql.push(sql); return { bind }; });
    const get = vi.fn(async (key: string) => {
      if (key.startsWith("files/")) return { body: "bytes" };
      const content = opts.docContents?.[key];
      return content === undefined ? null : { text: async () => content };
    });
    return { env: { DB: { prepare }, ASSETS: { get } } as unknown as Env, preparedSql, bindCalls, get };
  }

  const contentUrl = new URL("http://localhost/public/files/f1/content?projectId=p1");

  it("serves a published project's file without scanning docs", async () => {
    const { env, preparedSql } = contentEnv({ meta: PUBLISHED_META });
    const res = await handlePublic(new Request(contentUrl), env, contentUrl);
    expect(res.status).toBe(200);
    expect(preparedSql).toHaveLength(1); // meta lookup only - no docs query
  });

  it("serves an unpublished project's file referenced by a published doc's cover", async () => {
    const { env, preparedSql, bindCalls, get } = contentEnv({
      meta: UNPUBLISHED_META,
      docs: [{ id: "doc-1" }],
      docContents: { "proj-1/doc-1": "---\ntitle: Changelog\ncover: /api/files/f1/content\n---\nbody" },
    });
    const res = await handlePublic(new Request(contentUrl), env, contentUrl);
    expect(res.status).toBe(200);
    // The scan only trusts PUBLISHED docs of the file's own project.
    expect(preparedSql[1].replace(/\s+/g, " ")).toContain("published_at IS NOT NULL");
    expect(bindCalls[1][0]).toBe("proj-1");
    // Doc heads are range-read, not fetched whole.
    expect(get).toHaveBeenCalledWith("proj-1/doc-1", { range: { offset: 0, length: 8192 } });
  });

  it("accepts a share-preview `image:` reference too", async () => {
    const { env } = contentEnv({
      meta: UNPUBLISHED_META,
      docs: [{ id: "doc-1" }],
      docContents: { "proj-1/doc-1": "---\nimage: /api/files/f1/content\n---\nbody" },
    });
    const res = await handlePublic(new Request(contentUrl), env, contentUrl);
    expect(res.status).toBe(200);
  });

  it("404s when published docs reference only other files", async () => {
    const { env } = contentEnv({
      meta: UNPUBLISHED_META,
      docs: [{ id: "doc-1" }],
      docContents: { "proj-1/doc-1": "---\ncover: /api/files/OTHER/content\n---\nbody" },
    });
    const res = await handlePublic(new Request(contentUrl), env, contentUrl);
    expect(res.status).toBe(404);
  });

  it("404s when the project has no published docs, without touching R2", async () => {
    const { env, get } = contentEnv({ meta: UNPUBLISHED_META, docs: [] });
    const res = await handlePublic(new Request(contentUrl), env, contentUrl);
    expect(res.status).toBe(404);
    expect(get).not.toHaveBeenCalled();
  });

  it("survives an unreadable doc object and still matches a later doc", async () => {
    const { env } = contentEnv({
      meta: UNPUBLISHED_META,
      docs: [{ id: "doc-gone" }, { id: "doc-1" }], // doc-gone has no R2 object
      docContents: { "proj-1/doc-1": "---\ncover: /api/files/f1/content\n---\nbody" },
    });
    const res = await handlePublic(new Request(contentUrl), env, contentUrl);
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// POST /public/projects/:idOrSlug/report
// ---------------------------------------------------------------------------

interface PreparedCall {
  sql: string;
  binds: unknown[];
}

// Queue-based D1 mock: the report handler runs a project .first() lookup then
// an INSERT .run(); each prepared statement records its SQL + binds.
function makeReportEnv(opts: {
  project?: { id: string } | null;
  limiterSuccess?: boolean;
  hasLimiter?: boolean;
}) {
  const calls: PreparedCall[] = [];
  // Handler order: project lookup, then (only when a docId was sent) the
  // doc-belongs-to-project check. Tests push the doc row when they need it.
  const firstQueue: unknown[] = [opts.project ?? null];
  function makeStmt(sql: string) {
    const call: PreparedCall = { sql, binds: [] };
    const stmt = {
      bind: (...args: unknown[]) => {
        call.binds = args;
        return stmt;
      },
      first: async () => {
        calls.push(call);
        return firstQueue.shift() ?? null;
      },
      run: async () => {
        calls.push(call);
        return { meta: { changes: 1 } };
      },
    };
    return stmt;
  }
  const limit = vi.fn().mockResolvedValue({ success: opts.limiterSuccess ?? true });
  const env = {
    DB: { prepare: vi.fn((sql: string) => makeStmt(sql)) },
    ...(opts.hasLimiter === false ? {} : { RATE_LIMITER_REPORT: { limit } }),
  } as unknown as Env;
  return { env, calls, limit, firstQueue };
}

function reportRequest(body: unknown, headers: Record<string, string> = {}) {
  const url = new URL("http://localhost/public/projects/p1/report");
  const request = new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { request, url };
}

describe("POST /public/projects/:idOrSlug/report", () => {
  beforeEach(() => {
    vi.mocked(authenticate).mockReset();
    vi.mocked(authenticate).mockResolvedValue(null);
  });

  it("files an anonymous report against a published site", async () => {
    const { env, calls } = makeReportEnv({ project: { id: "proj-1" } });
    const { request, url } = reportRequest({ note: "  This site hosts spam.  " }, { "CF-Connecting-IP": "203.0.113.9" });
    const res = await handlePublicReport(request, env, url);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true, data: { submitted: true } });

    // Published-only lookup, by id or vanity slug.
    expect(calls[0].sql).toContain("published_at IS NOT NULL");
    expect(calls[0].binds).toEqual(["p1", "p1"]);
    // Insert: trimmed note, no user attribution, edge IP captured, no page.
    expect(calls[1].sql).toContain("INSERT INTO site_reports");
    const [, projectId, userId, ip, docId, note] = calls[1].binds;
    expect(projectId).toBe("proj-1");
    expect(userId).toBeNull();
    expect(ip).toBe("203.0.113.9");
    expect(docId).toBeNull();
    expect(note).toBe("This site hosts spam.");
    expect(calls[1].binds[6]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    // No Authorization header -> authenticate is never consulted.
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("stores the page the reporter was on after verifying it belongs to the site", async () => {
    const { env, calls, firstQueue } = makeReportEnv({ project: { id: "proj-1" } });
    firstQueue.push({ id: "doc-7" });
    const { request, url } = reportRequest({ note: "this page is spam", docId: "doc-7" });
    const res = await handlePublicReport(request, env, url);
    expect(res.status).toBe(201);
    // Doc verified against the project the report targets.
    expect(calls[1].sql).toContain("FROM docs WHERE id = ? AND project_id = ?");
    expect(calls[1].binds).toEqual(["doc-7", "proj-1"]);
    expect(calls[2].binds[4]).toBe("doc-7");
  });

  it("files with a NULL page when the docId doesn't belong to the site", async () => {
    const { env, calls, firstQueue } = makeReportEnv({ project: { id: "proj-1" } });
    firstQueue.push(null); // doc lookup misses
    const { request, url } = reportRequest({ note: "report", docId: "doc-of-another-site" });
    const res = await handlePublicReport(request, env, url);
    expect(res.status).toBe(201);
    expect(calls[2].binds[4]).toBeNull();
  });

  it("attributes the report when the caller presents a valid session token", async () => {
    vi.mocked(authenticate).mockResolvedValue({ userId: "user-9", email: "u@example.com" } as never);
    const { env, calls } = makeReportEnv({ project: { id: "proj-1" } });
    const { request, url } = reportRequest({ note: "bad content" }, { Authorization: "Bearer tok" });
    const res = await handlePublicReport(request, env, url);
    expect(res.status).toBe(201);
    expect(calls[1].binds[2]).toBe("user-9");
  });

  it("still files anonymously when the token is invalid (auth must not block reporting)", async () => {
    vi.mocked(authenticate).mockResolvedValue(new Response(null, { status: 403 }));
    const { env, calls } = makeReportEnv({ project: { id: "proj-1" } });
    const { request, url } = reportRequest({ note: "bad content" }, { Authorization: "Bearer expired" });
    const res = await handlePublicReport(request, env, url);
    expect(res.status).toBe(201);
    expect(calls[1].binds[2]).toBeNull();
  });

  it("400s on a missing, empty, or oversized note", async () => {
    for (const body of [{}, { note: "   " }, { note: "x".repeat(MAX_REPORT_NOTE_LENGTH + 1) }]) {
      const { env } = makeReportEnv({ project: { id: "proj-1" } });
      const { request, url } = reportRequest(body);
      const res = await handlePublicReport(request, env, url);
      expect(res.status).toBe(400);
    }
  });

  it("404s when the site does not exist or is not published", async () => {
    const { env, calls } = makeReportEnv({ project: null });
    const { request, url } = reportRequest({ note: "report" });
    const res = await handlePublicReport(request, env, url);
    expect(res.status).toBe(404);
    // Nothing inserted.
    expect(calls.some(c => c.sql.includes("INSERT"))).toBe(false);
  });

  it("429s when the per-IP limiter trips, before touching the DB", async () => {
    const { env, calls, limit } = makeReportEnv({ project: { id: "proj-1" }, limiterSuccess: false });
    const { request, url } = reportRequest({ note: "report" }, { "CF-Connecting-IP": "203.0.113.9" });
    const res = await handlePublicReport(request, env, url);
    expect(res.status).toBe(429);
    expect(limit).toHaveBeenCalledWith({ key: "report:203.0.113.9" });
    expect(calls.length).toBe(0);
  });

  it("fails open when the limiter binding is absent (local dev)", async () => {
    const { env } = makeReportEnv({ project: { id: "proj-1" }, hasLimiter: false });
    const { request, url } = reportRequest({ note: "report" });
    const res = await handlePublicReport(request, env, url);
    expect(res.status).toBe(201);
  });

  it("stores created_at as an ISO timestamp, not the zone-less column default", async () => {
    // Real SQLite: the column default would write "YYYY-MM-DD HH:MM:SS".
    const { db, sqlite } = createSqliteD1();
    sqlite.prepare("INSERT INTO projects (id, name, owner_id, created_at, published_at) VALUES ('p1', 'S', 'u1', ?, ?)")
      .run("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    const env = { DB: db } as unknown as Env;
    const { request, url } = reportRequest({ note: "spam" });
    const res = await handlePublicReport(request, env, url);
    expect(res.status).toBe(201);
    const row = sqlite.prepare("SELECT created_at FROM site_reports").get() as { created_at: string };
    expect(row.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});

// ---------------------------------------------------------------------------
// GET /public/docs/:site/:idOrSlug and GET /public/projects/:idOrSlug -
// real SQLite, so the batched statements (and the published_at filters baked
// into them) are actually evaluated.
// ---------------------------------------------------------------------------

describe("public site reads (batched)", () => {
  const T0 = "2026-01-01T00:00:00.000Z";

  function setup() {
    const { db, sqlite } = createSqliteD1();
    const exec = (sql: string, ...args: (string | number | null)[]) => sqlite.prepare(sql).run(...args);
    const project = (id: string, opts: { published?: boolean; slug?: string; home?: string } = {}) =>
      exec("INSERT INTO projects (id, name, owner_id, created_at, published_at, vanity_slug, home_doc_id) VALUES (?, ?, 'u1', ?, ?, ?, ?)",
        id, `Site ${id}`, T0, opts.published ? T0 : null, opts.slug ?? null, opts.home ?? null);
    const doc = (id: string, projectId: string, opts: { title?: string; slug?: string; published?: boolean; position?: number } = {}) =>
      exec("INSERT INTO docs (id, title, project_id, author_id, created_at, updated_at, published_at, slug, sidebar_position) VALUES (?, ?, ?, 'u1', ?, ?, ?, ?, ?)",
        id, opts.title ?? id, projectId, T0, T0, opts.published ? T0 : null, opts.slug ?? null, opts.position ?? null);
    const folder = (id: string, projectId: string) =>
      exec("INSERT INTO folders (id, name, project_id, created_at) VALUES (?, ?, ?, ?)", id, `Folder ${id}`, projectId, T0);
    const file = (id: string, projectId: string) =>
      exec("INSERT INTO files (id, name, mime_type, size, project_id, uploaded_by, created_at) VALUES (?, ?, 'image/png', 1, ?, 'u1', ?)", id, `${id}.png`, projectId, T0);

    // Published site with an active custom domain, nav, and a home doc.
    project("pub", { published: true, slug: "pub-slug", home: "home" });
    exec("INSERT INTO project_custom_domains (project_id, hostname, status) VALUES ('pub', 'docs.example.com', 'active')");
    doc("home", "pub", { title: "Home", slug: "welcome" });
    doc("second", "pub", { title: "Second", position: 1 });
    folder("pub-folder", "pub");
    file("pub-file", "pub");

    // Unpublished site: one solo-published doc, one private doc, private nav.
    project("priv");
    doc("solo", "priv", { title: "Solo", slug: "solo-slug", published: true });
    doc("secret", "priv", { title: "Secret doc" });
    folder("secret-folder", "priv");
    file("secret-file", "priv");

    const ASSETS = { get: vi.fn(async (key: string) => ({ text: async () => `---\ntitle: Display ${key}\n---\nbody of ${key}` })) };
    const batch = vi.spyOn(db, "batch");
    // Every Stmt shares one prototype: spying on it catches any read issued
    // outside the batch (a regression back to sequential round trips).
    const stmtProto = Object.getPrototypeOf(db.prepare("SELECT 1")) as { first: () => unknown; all: () => unknown };
    const directFirst = vi.spyOn(stmtProto, "first");
    const directAll = vi.spyOn(stmtProto, "all");
    const env = { DB: db, ASSETS } as unknown as Env;
    const get = async (path: string) => {
      const url = new URL(`http://localhost/public/${path}`);
      const res = await handlePublic(new Request(url), env, url);
      return { res, body: res.status === 200 ? await res.json<{ data: Record<string, unknown> }>() : null };
    };
    // Row counts each batched statement returned for the last request - an
    // unpublished site's nav rows must never leave the DB, not just be dropped.
    const lastBatchRows = async () => {
      const results = (await batch.mock.results[batch.mock.results.length - 1].value) as { results: unknown[] }[];
      return results.map(r => r.results.length);
    };
    return { get, batch, directFirst, directAll, ASSETS, lastBatchRows, project, doc };
  }

  afterEach(() => vi.restoreAllMocks());

  describe("GET /public/docs/:site/:idOrSlug", () => {
    it("serves a published site's doc and nav in one D1 batch", async () => {
      const { get, batch, directFirst, directAll, ASSETS } = setup();
      const { res, body } = await get("docs/pub/home");
      expect(res.status).toBe(200);
      expect(batch).toHaveBeenCalledTimes(1);
      expect(directFirst).not.toHaveBeenCalled();
      expect(directAll).not.toHaveBeenCalled();
      expect(ASSETS.get).toHaveBeenCalledWith("pub/home");

      const data = body!.data as {
        doc: { id: string; slug: string; display_title: string };
        sitePublished: boolean;
        project: { id: string; custom_domain: string | null; home_doc_id: string };
        docs: { id: string; is_home: number }[];
        folders: { id: string }[];
        files: { id: string }[];
      };
      expect(data.sitePublished).toBe(true);
      expect(data.doc).toMatchObject({ id: "home", slug: "welcome", display_title: "Display pub/home" });
      expect(data.project).toMatchObject({ id: "pub", custom_domain: "docs.example.com", home_doc_id: "home" });
      // Sidebar order (positioned first, then by title) and the home flag.
      expect(data.docs.map(d => [d.id, d.is_home])).toEqual([["second", 0], ["home", 1]]);
      expect(data.folders.map(f => f.id)).toEqual(["pub-folder"]);
      expect(data.files.map(f => f.id)).toEqual(["pub-file"]);
    });

    it("resolves the site by vanity slug and the doc by its custom slug", async () => {
      const { get, ASSETS } = setup();
      const { res, body } = await get("docs/pub-slug/welcome");
      expect(res.status).toBe(200);
      expect((body!.data.doc as { id: string }).id).toBe("home");
      // R2 is keyed by the resolved ids, never by the URL segments.
      expect(ASSETS.get).toHaveBeenCalledWith("pub/home");
    });

    it("serves a solo-published doc on an unpublished site without any nav data", async () => {
      const { get, lastBatchRows } = setup();
      for (const path of ["docs/priv/solo", "docs/priv/solo-slug"]) {
        const { res, body } = await get(path);
        expect(res.status).toBe(200);
        expect(body!.data).toMatchObject({ sitePublished: false, docs: null, folders: null, files: null });
        // [project, doc, nav docs, nav folders, nav files]
        expect(await lastBatchRows()).toEqual([1, 1, 0, 0, 0]);
        expect(JSON.stringify(body)).not.toContain("secret");
      }
    });

    it("404s an unpublished doc on an unpublished site, without reading R2", async () => {
      const { get, ASSETS, lastBatchRows } = setup();
      const { res } = await get("docs/priv/secret");
      expect(res.status).toBe(404);
      expect(ASSETS.get).not.toHaveBeenCalled();
      expect(await lastBatchRows()).toEqual([1, 1, 0, 0, 0]);
    });

    it("404s an unknown site, an unknown doc, and another site's doc", async () => {
      const { get, ASSETS } = setup();
      expect((await get("docs/nope/home")).res.status).toBe(404);
      expect((await get("docs/pub/nope")).res.status).toBe(404);
      // A doc id from a different site never resolves under this one.
      expect((await get("docs/pub/solo")).res.status).toBe(404);
      expect(ASSETS.get).not.toHaveBeenCalled();
    });

    it("prefers an exact site id over another site's identical vanity slug, in every statement", async () => {
      const { get, project, doc } = setup();
      // Vanity slugs may be uuid-shaped, so an id and a slug can collide.
      project("shared", { published: true });
      doc("shared-doc", "shared", { title: "Shared", slug: "intro" });
      project("other", { published: true, slug: "shared" });
      doc("other-doc", "other", { title: "Other", slug: "intro" });
      const { res, body } = await get("docs/shared/intro");
      expect(res.status).toBe(200);
      const data = body!.data as { doc: { id: string }; project: { id: string }; docs: { id: string }[] };
      expect(data.doc.id).toBe("shared-doc");
      expect(data.project.id).toBe("shared");
      expect(data.docs.map(d => d.id)).toEqual(["shared-doc"]);
    });
  });

  describe("GET /public/projects/:idOrSlug", () => {
    it("returns a published site with its nav in one D1 batch", async () => {
      const { get, batch, directFirst, directAll } = setup();
      for (const key of ["pub", "pub-slug"]) {
        const { res, body } = await get(`projects/${key}`);
        expect(res.status).toBe(200);
        const data = body!.data as { id: string; docs: { id: string; is_home: number }[]; folders: { id: string }[]; files: { id: string }[] };
        expect(data.id).toBe("pub");
        expect(data.docs.map(d => [d.id, d.is_home])).toEqual([["second", 0], ["home", 1]]);
        expect(data.folders.map(f => f.id)).toEqual(["pub-folder"]);
        expect(data.files.map(f => f.id)).toEqual(["pub-file"]);
      }
      expect(batch).toHaveBeenCalledTimes(2);
      expect(directFirst).not.toHaveBeenCalled();
      expect(directAll).not.toHaveBeenCalled();
    });

    it("404s an unpublished site and never reads its nav rows", async () => {
      const { get, lastBatchRows } = setup();
      const { res } = await get("projects/priv");
      expect(res.status).toBe(404);
      // [project, nav docs, nav folders, nav files]
      expect(await lastBatchRows()).toEqual([0, 0, 0, 0]);
    });

    it("falls through to a published vanity-slug match when the id match is unpublished", async () => {
      // Same outcome as the old `(id = ? OR vanity_slug = ?) AND published_at IS NOT NULL`.
      const { get, project, doc } = setup();
      project("shared");
      doc("hidden-doc", "shared");
      project("other", { published: true, slug: "shared" });
      doc("other-doc", "other");
      const { res, body } = await get("projects/shared");
      expect(res.status).toBe(200);
      const data = body!.data as { id: string; docs: { id: string }[] };
      expect(data.id).toBe("other");
      expect(data.docs.map(d => d.id)).toEqual(["other-doc"]);
    });
  });
});
