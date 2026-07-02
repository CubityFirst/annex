import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleDocs } from "./docs";

vi.mock("../lib/access", () => ({ resolveAccess: vi.fn() }));
vi.mock("../lib", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib")>()),
  folderInProject: vi.fn(),
}));
vi.mock("../lib/docOps", () => ({
  createDoc: vi.fn(),
  applyDocUpdate: vi.fn(),
  deleteDoc: vi.fn(),
  snapshotDocRevision: vi.fn(),
}));

import { resolveAccess } from "../lib/access";
import { folderInProject } from "../lib";
import { createDoc, applyDocUpdate, deleteDoc, snapshotDocRevision } from "../lib/docOps";

const user = { userId: "user-1", email: "a@example.com" } as unknown as Parameters<typeof handleDocs>[2];

// EffectiveAccess factory - resolveAccess is always mocked, so tests pick the role.
function access(role: string) {
  return { role, name: "Caller", projectRole: role, orgRole: null, source: "project" } as unknown as Awaited<ReturnType<typeof resolveAccess>>;
}

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
  const assetsGet = vi.fn(async () => ({ text: async () => "" }));
  return {
    env: {
      DB: { prepare },
      ASSETS: { get: assetsGet, put: vi.fn(), delete: vi.fn() },
      // DOC_COLLAB intentionally undefined - the DO branches are skipped.
    } as unknown as Parameters<typeof handleDocs>[1],
    run,
    assetsGet,
    prepare,
    bindCalls,
    queueFirst: (v: unknown) => firsts.push(v),
    queueAll: (v: unknown) => alls.push(v),
  };
}

function call(env: Parameters<typeof handleDocs>[1], method: string, path: string, body?: unknown) {
  const url = new URL(`http://localhost${path}`);
  return handleDocs(
    new Request(url.toString(), {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }),
    env, user, url,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveAccess).mockResolvedValue(access("editor"));
  vi.mocked(folderInProject).mockResolvedValue(true);
  vi.mocked(createDoc).mockResolvedValue({ id: "new-doc", title: "T", content: "", projectId: "p1", authorId: "user-1", folderId: null, publishedAt: null, createdAt: "2026", updatedAt: "2026" });
  vi.mocked(applyDocUpdate).mockResolvedValue({ updated: { id: "d1", title: "T", project_id: "p1", author_id: "user-1", published_at: null, show_heading: 1, show_last_updated: 1, folder_id: null, created_at: "2026", updated_at: "2026" }, savedContent: undefined });
  vi.mocked(deleteDoc).mockResolvedValue(undefined);
  vi.mocked(snapshotDocRevision).mockResolvedValue("rev-new");
});

describe("handleDocs GET list", () => {
  it("400s without projectId", async () => {
    const { env } = makeEnv();
    const res = await call(env, "GET", "/docs");
    expect(res.status).toBe(400);
  });

  it("403s for a non-member (resolveAccess null)", async () => {
    vi.mocked(resolveAccess).mockResolvedValue(null);
    const { env } = makeEnv();
    const res = await call(env, "GET", "/docs?projectId=p1");
    expect(res.status).toBe(403);
  });

  it("returns doc rows for a member", async () => {
    const { env, queueAll } = makeEnv();
    queueAll({ results: [{ id: "d1", title: "Doc" }] });
    const res = await call(env, "GET", "/docs?projectId=p1");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: unknown[] };
    expect(json.data).toHaveLength(1);
  });

  it("supports a search query (q)", async () => {
    const { env, queueAll, prepare, bindCalls } = makeEnv();
    queueAll({ results: [{ id: "d1", title: "Match" }] });
    const res = await call(env, "GET", "/docs?projectId=p1&q=Match");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: unknown[] };
    expect(json.data).toHaveLength(1);
    // Must run the LIKE-filtered query and bind (projectId, %q%, %q%) in order
    // for a non-limited member (no leading userId for the shares JOIN).
    expect(prepare.mock.calls.some(c => (c[0] as string).includes("LIKE LOWER(?)"))).toBe(true);
    expect(bindCalls).toContainEqual(["p1", "%Match%", "%Match%"]);
  });

  it("search binds the limited viewer's userId before the LIKE params", async () => {
    vi.mocked(resolveAccess).mockResolvedValue(access("limited"));
    const { env, queueAll, prepare, bindCalls } = makeEnv();
    queueAll({ results: [{ id: "d1", title: "Match" }] });
    const res = await call(env, "GET", "/docs?projectId=p1&q=Match");
    expect(res.status).toBe(200);
    // A limited viewer's search JOINs doc_shares and binds userId first, then
    // projectId + the two LIKE patterns.
    expect(prepare.mock.calls.some(c => (c[0] as string).includes("JOIN doc_shares ds"))).toBe(true);
    expect(bindCalls).toContainEqual(["user-1", "p1", "%Match%", "%Match%"]);
  });
});

describe("handleDocs POST", () => {
  it("400s without title/projectId", async () => {
    const { env } = makeEnv();
    const res = await call(env, "POST", "/docs", { title: "T" });
    expect(res.status).toBe(400);
  });

  it("403s for a non-member", async () => {
    vi.mocked(resolveAccess).mockResolvedValue(null);
    const { env } = makeEnv();
    const res = await call(env, "POST", "/docs", { title: "T", projectId: "p1" });
    expect(res.status).toBe(403);
  });

  it("403s for a viewer (below editor)", async () => {
    vi.mocked(resolveAccess).mockResolvedValue(access("viewer"));
    const { env } = makeEnv();
    const res = await call(env, "POST", "/docs", { title: "T", projectId: "p1" });
    expect(res.status).toBe(403);
  });

  it("400s when the target folder isn't in the project", async () => {
    vi.mocked(folderInProject).mockResolvedValue(false);
    const { env } = makeEnv();
    const res = await call(env, "POST", "/docs", { title: "T", projectId: "p1", folderId: "bad" });
    expect(res.status).toBe(400);
  });

  it("creates a doc (201) for an editor", async () => {
    const { env } = makeEnv();
    const res = await call(env, "POST", "/docs", { title: "T", projectId: "p1", content: "hi" });
    expect(res.status).toBe(201);
    expect(createDoc).toHaveBeenCalled();
    const json = (await res.json()) as { data: { id: string } };
    expect(json.data.id).toBe("new-doc");
  });
});

describe("handleDocs POST /docs/:id/collab/reset", () => {
  it("404s when the doc is missing", async () => {
    const { env } = makeEnv(); // meta first() → null
    const res = await call(env, "POST", "/docs/d1/collab/reset");
    expect(res.status).toBe(404);
  });

  it("404s when the project is missing", async () => {
    const { env, queueFirst } = makeEnv();
    queueFirst({ project_id: "p1" }); // meta
    queueFirst(null); // project
    const res = await call(env, "POST", "/docs/d1/collab/reset");
    expect(res.status).toBe(404);
  });

  it("403s when realtime isn't enabled", async () => {
    const { env, queueFirst } = makeEnv();
    queueFirst({ project_id: "p1" });
    queueFirst({ features: 0 }); // no REALTIME bit
    const res = await call(env, "POST", "/docs/d1/collab/reset");
    expect(res.status).toBe(403);
  });

  it("403s for a viewer when realtime is enabled", async () => {
    vi.mocked(resolveAccess).mockResolvedValue(access("viewer"));
    const { env, queueFirst } = makeEnv();
    queueFirst({ project_id: "p1" });
    queueFirst({ features: 4 }); // REALTIME
    const res = await call(env, "POST", "/docs/d1/collab/reset");
    expect(res.status).toBe(403);
  });

  it("resets the room (200) for an editor", async () => {
    const { env, queueFirst } = makeEnv();
    queueFirst({ project_id: "p1" });
    queueFirst({ features: 4 });
    const res = await call(env, "POST", "/docs/d1/collab/reset");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { ok: boolean } };
    expect(json.data.ok).toBe(true);
  });
});

describe("handleDocs GET /docs/:id/revisions", () => {
  it("404s the list when the doc is missing", async () => {
    const { env } = makeEnv();
    const res = await call(env, "GET", "/docs/d1/revisions");
    expect(res.status).toBe(404);
  });

  it("403s a limited member with no doc_share", async () => {
    vi.mocked(resolveAccess).mockResolvedValue(access("limited"));
    const { env, queueFirst } = makeEnv();
    queueFirst({ project_id: "p1" }); // meta
    queueFirst(null); // share lookup
    const res = await call(env, "GET", "/docs/d1/revisions");
    expect(res.status).toBe(403);
  });

  it("lists revisions for a member with the default limit of 50 and title in the rows", async () => {
    const { env, queueFirst, queueAll, prepare, bindCalls } = makeEnv();
    queueFirst({ project_id: "p1" });
    queueAll({ results: [{ id: "r1", editor_id: "user-1", title: "Old Title" }] });
    const res = await call(env, "GET", "/docs/d1/revisions");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { title: string }[] };
    expect(json.data).toHaveLength(1);
    expect(json.data[0].title).toBe("Old Title");
    const listSql = prepare.mock.calls.map(c => c[0] as string).find(s => s.includes("FROM asset_revisions"));
    expect(listSql).toContain("title");
    expect(listSql).toContain("ORDER BY created_at DESC, id DESC LIMIT ?");
    expect(bindCalls).toContainEqual(["d1", 50]);
  });

  it("clamps limit to 1..200", async () => {
    for (const [raw, clamped] of [["999", 200], ["0", 1], ["-5", 1], ["25", 25]] as const) {
      const { env, queueFirst, bindCalls } = makeEnv();
      queueFirst({ project_id: "p1" });
      const res = await call(env, "GET", `/docs/d1/revisions?limit=${raw}`);
      expect(res.status).toBe(200);
      expect(bindCalls).toContainEqual(["d1", clamped]);
    }
  });

  it("applies the before/beforeId keyset cursor as a strict (created_at, id) < comparison", async () => {
    const { env, queueFirst, queueAll, prepare, bindCalls } = makeEnv();
    queueFirst({ project_id: "p1" });
    queueAll({ results: [] });
    const res = await call(env, "GET", "/docs/d1/revisions?limit=10&before=2026-01-02T00:00:00.000Z&beforeId=r5");
    expect(res.status).toBe(200);
    const listSql = prepare.mock.calls.map(c => c[0] as string).find(s => s.includes("FROM asset_revisions"));
    expect(listSql).toContain("(created_at < ? OR (created_at = ? AND id < ?))");
    expect(bindCalls).toContainEqual(["d1", "2026-01-02T00:00:00.000Z", "2026-01-02T00:00:00.000Z", "r5", 10]);
  });

  it("ignores an incomplete cursor (before without beforeId)", async () => {
    const { env, queueFirst, bindCalls } = makeEnv();
    queueFirst({ project_id: "p1" });
    const res = await call(env, "GET", "/docs/d1/revisions?before=2026-01-02T00:00:00.000Z");
    expect(res.status).toBe(200);
    expect(bindCalls).toContainEqual(["d1", 50]);
  });

  it("404s a single revision that doesn't exist", async () => {
    const { env, queueFirst } = makeEnv();
    queueFirst({ project_id: "p1" }); // meta
    queueFirst(null); // revision
    const res = await call(env, "GET", "/docs/d1/revisions/r9");
    expect(res.status).toBe(404);
  });

  it("returns a single revision with content and title", async () => {
    const { env, queueFirst, assetsGet } = makeEnv();
    queueFirst({ project_id: "p1" });
    queueFirst({ id: "r1", editor_id: "user-1", editor_name: "X", created_at: "2026", changelog: null, contributors: null, title: "Rev Title" });
    assetsGet.mockResolvedValueOnce({ text: async () => "body text" });
    const res = await call(env, "GET", "/docs/d1/revisions/r1");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { content: string; title: string } };
    expect(json.data.content).toBe("body text");
    expect(json.data.title).toBe("Rev Title");
  });
});

describe("handleDocs POST /docs/:id/revisions/:revisionId/restore", () => {
  const revision = { id: "r1", title: "Rev Title", created_at: "2026-01-01T00:00:00.000Z" };

  it("404s when the doc is missing", async () => {
    const { env } = makeEnv(); // doc first() → null
    const res = await call(env, "POST", "/docs/d1/revisions/r1/restore");
    expect(res.status).toBe(404);
  });

  it("403s for a non-member", async () => {
    vi.mocked(resolveAccess).mockResolvedValue(null);
    const { env, queueFirst } = makeEnv();
    queueFirst({ id: "d1", title: "Now", project_id: "p1" }); // doc
    const res = await call(env, "POST", "/docs/d1/revisions/r1/restore");
    expect(res.status).toBe(403);
    expect(applyDocUpdate).not.toHaveBeenCalled();
  });

  it("403s a viewer without an edit doc_share", async () => {
    vi.mocked(resolveAccess).mockResolvedValue(access("viewer"));
    const { env, queueFirst } = makeEnv();
    queueFirst({ id: "d1", title: "Now", project_id: "p1" }); // doc
    queueFirst(null); // share lookup
    const res = await call(env, "POST", "/docs/d1/revisions/r1/restore");
    expect(res.status).toBe(403);
    expect(applyDocUpdate).not.toHaveBeenCalled();
  });

  it("404s an unknown revision", async () => {
    const { env, queueFirst } = makeEnv();
    queueFirst({ id: "d1", title: "Now", project_id: "p1" }); // doc
    queueFirst(null); // revision
    const res = await call(env, "POST", "/docs/d1/revisions/r9/restore");
    expect(res.status).toBe(404);
    expect(applyDocUpdate).not.toHaveBeenCalled();
  });

  it("restores content + title with an auto changelog for an editor", async () => {
    const { env, queueFirst, assetsGet } = makeEnv();
    queueFirst({ id: "d1", title: "Now", project_id: "p1" }); // doc
    queueFirst(revision);
    assetsGet.mockResolvedValueOnce({ text: async () => "old body" });
    const res = await call(env, "POST", "/docs/d1/revisions/r1/restore");
    expect(res.status).toBe(200);
    expect(applyDocUpdate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: "d1" }),
      "user-1",
      "Caller",
      { content: "old body", changelog: "Restored version from 2026-01-01T00:00:00.000Z", title: "Rev Title" },
      expect.objectContaining({ gatherContributors: expect.any(Function) }),
    );
  });

  it("restores for a viewer uplifted by an edit doc_share", async () => {
    vi.mocked(resolveAccess).mockResolvedValue(access("viewer"));
    const { env, queueFirst, assetsGet } = makeEnv();
    queueFirst({ id: "d1", title: "Now", project_id: "p1" }); // doc
    queueFirst({ permission: "edit" }); // share lookup
    queueFirst(revision);
    assetsGet.mockResolvedValueOnce({ text: async () => "old body" });
    const res = await call(env, "POST", "/docs/d1/revisions/r1/restore");
    expect(res.status).toBe(200);
    expect(applyDocUpdate).toHaveBeenCalled();
  });

  it("uses a provided changelog instead of the auto one", async () => {
    const { env, queueFirst, assetsGet } = makeEnv();
    queueFirst({ id: "d1", title: "Now", project_id: "p1" });
    queueFirst(revision);
    assetsGet.mockResolvedValueOnce({ text: async () => "old body" });
    const res = await call(env, "POST", "/docs/d1/revisions/r1/restore", { changelog: "roll back vandalism" });
    expect(res.status).toBe(200);
    const patch = vi.mocked(applyDocUpdate).mock.calls[0][4];
    expect(patch.changelog).toBe("roll back vandalism");
  });

  it("omits title from the patch for a pre-title (NULL) revision", async () => {
    const { env, queueFirst, assetsGet } = makeEnv();
    queueFirst({ id: "d1", title: "Now", project_id: "p1" });
    queueFirst({ ...revision, title: null });
    assetsGet.mockResolvedValueOnce({ text: async () => "old body" });
    const res = await call(env, "POST", "/docs/d1/revisions/r1/restore");
    expect(res.status).toBe(200);
    const patch = vi.mocked(applyDocUpdate).mock.calls[0][4];
    expect("title" in patch).toBe(false);
  });

  it("echoes content when the restore actually changed the body", async () => {
    vi.mocked(applyDocUpdate).mockResolvedValue({ updated: { id: "d1", title: "Rev Title", project_id: "p1", author_id: "user-1", published_at: null, show_heading: 1, show_last_updated: 1, folder_id: null, created_at: "2026", updated_at: "2026" }, savedContent: "old body" });
    const { env, queueFirst, assetsGet } = makeEnv();
    queueFirst({ id: "d1", title: "Now", project_id: "p1" });
    queueFirst(revision);
    assetsGet.mockResolvedValueOnce({ text: async () => "old body" });
    const res = await call(env, "POST", "/docs/d1/revisions/r1/restore");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { content: string } };
    expect(json.data.content).toBe("old body");
  });

  it("returns the doc without content and writes nothing when content AND title are already current (true no-op)", async () => {
    const { env, queueFirst, assetsGet } = makeEnv();
    queueFirst({ id: "d1", title: "Rev Title", project_id: "p1" }); // title already matches the revision
    queueFirst(revision);
    assetsGet.mockResolvedValueOnce({ text: async () => "old body" });
    const res = await call(env, "POST", "/docs/d1/revisions/r1/restore");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { content?: string } };
    expect(json.data.content).toBeUndefined();
    expect(snapshotDocRevision).not.toHaveBeenCalled();
  });

  it("records a revision for a title-only restore (content unchanged, title differs)", async () => {
    // applyDocUpdate's default mock returns savedContent: undefined - the
    // content-equal case. The title still changed, so the restore must leave
    // a history entry carrying the changelog.
    const { env, queueFirst, assetsGet } = makeEnv();
    queueFirst({ id: "d1", title: "Now", project_id: "p1" });
    queueFirst(revision);
    assetsGet.mockResolvedValueOnce({ text: async () => "old body" });
    const res = await call(env, "POST", "/docs/d1/revisions/r1/restore");
    expect(res.status).toBe(200);
    expect(snapshotDocRevision).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        docId: "d1",
        projectId: "p1",
        content: "old body",
        title: "Rev Title",
        changelog: "Restored version from 2026-01-01T00:00:00.000Z",
      }),
    );
  });

  it("404s instead of restoring empty content when the revision's R2 snapshot is missing", async () => {
    const { env, queueFirst, assetsGet } = makeEnv();
    queueFirst({ id: "d1", title: "Now", project_id: "p1" });
    queueFirst(revision);
    assetsGet.mockResolvedValueOnce(null as never); // orphaned row - object gone
    const res = await call(env, "POST", "/docs/d1/revisions/r1/restore");
    expect(res.status).toBe(404);
    expect(applyDocUpdate).not.toHaveBeenCalled();
  });
});

describe("handleDocs GET /docs/:id", () => {
  it("404s when the doc is missing", async () => {
    const { env } = makeEnv(); // meta first() → null
    const res = await call(env, "GET", "/docs/d1");
    expect(res.status).toBe(404);
  });

  it("403s for a non-member", async () => {
    vi.mocked(resolveAccess).mockResolvedValue(null);
    const { env, queueFirst } = makeEnv();
    queueFirst({ project_id: "p1" }); // meta
    const res = await call(env, "GET", "/docs/d1");
    expect(res.status).toBe(403);
  });

  it("403s a limited member with no doc_share", async () => {
    vi.mocked(resolveAccess).mockResolvedValue(access("limited"));
    const { env, queueFirst } = makeEnv();
    queueFirst({ project_id: "p1" }); // meta
    queueFirst(null); // share lookup
    const res = await call(env, "GET", "/docs/d1");
    expect(res.status).toBe(403);
  });

  it("404s when the doc row is missing after the meta check", async () => {
    const { env, queueFirst } = makeEnv();
    queueFirst({ project_id: "p1" }); // meta
    queueFirst(null); // full row
    const res = await call(env, "GET", "/docs/d1");
    expect(res.status).toBe(404);
  });

  it("returns the doc with content for an editor", async () => {
    const { env, queueFirst, assetsGet } = makeEnv();
    queueFirst({ project_id: "p1" }); // meta
    queueFirst({ id: "d1", title: "Doc", project_id: "p1" }); // full row
    assetsGet.mockResolvedValueOnce({ text: async () => "hello" });
    const res = await call(env, "GET", "/docs/d1");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { content: string; myRole: string } };
    expect(json.data.content).toBe("hello");
    expect(json.data.myRole).toBe("editor");
  });
});

describe("handleDocs PUT /docs/:id", () => {
  it("404s when the doc is missing", async () => {
    const { env } = makeEnv(); // first() → null
    const res = await call(env, "PUT", "/docs/d1", { title: "New" });
    expect(res.status).toBe(404);
  });

  it("403s for a non-member", async () => {
    vi.mocked(resolveAccess).mockResolvedValue(null);
    const { env, queueFirst } = makeEnv();
    queueFirst({ id: "d1", project_id: "p1" });
    const res = await call(env, "PUT", "/docs/d1", { title: "New" });
    expect(res.status).toBe(403);
  });

  it("403s an uplifted viewer without an edit doc_share", async () => {
    vi.mocked(resolveAccess).mockResolvedValue(access("viewer"));
    const { env, queueFirst } = makeEnv();
    queueFirst({ id: "d1", project_id: "p1" }); // doc
    queueFirst(null); // share lookup
    const res = await call(env, "PUT", "/docs/d1", { content: "x" });
    expect(res.status).toBe(403);
  });

  it("400s when moving to a folder outside the project", async () => {
    vi.mocked(folderInProject).mockResolvedValue(false);
    const { env, queueFirst } = makeEnv();
    queueFirst({ id: "d1", project_id: "p1" });
    const res = await call(env, "PUT", "/docs/d1", { folderId: "bad" });
    expect(res.status).toBe(400);
  });

  it("updates the doc for an editor", async () => {
    const { env, queueFirst } = makeEnv();
    queueFirst({ id: "d1", title: "Old", project_id: "p1" });
    const res = await call(env, "PUT", "/docs/d1", { title: "New" });
    expect(res.status).toBe(200);
    expect(applyDocUpdate).toHaveBeenCalled();
  });

  it("echoes content when the body changed", async () => {
    vi.mocked(applyDocUpdate).mockResolvedValue({ updated: { id: "d1", title: "T", project_id: "p1", author_id: "user-1", published_at: null, show_heading: 1, show_last_updated: 1, folder_id: null, created_at: "2026", updated_at: "2026" }, savedContent: "fresh" });
    const { env, queueFirst } = makeEnv();
    queueFirst({ id: "d1", title: "Old", project_id: "p1" });
    const res = await call(env, "PUT", "/docs/d1", { content: "fresh" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { content: string } };
    expect(json.data.content).toBe("fresh");
  });
});

describe("handleDocs DELETE /docs/:id", () => {
  it("404s when the doc is missing", async () => {
    const { env } = makeEnv();
    const res = await call(env, "DELETE", "/docs/d1");
    expect(res.status).toBe(404);
  });

  it("403s for a non-member", async () => {
    vi.mocked(resolveAccess).mockResolvedValue(null);
    const { env, queueFirst } = makeEnv();
    queueFirst({ project_id: "p1" });
    const res = await call(env, "DELETE", "/docs/d1");
    expect(res.status).toBe(403);
  });

  it("403s for a viewer (below editor)", async () => {
    vi.mocked(resolveAccess).mockResolvedValue(access("viewer"));
    const { env, queueFirst } = makeEnv();
    queueFirst({ project_id: "p1" });
    const res = await call(env, "DELETE", "/docs/d1");
    expect(res.status).toBe(403);
  });

  it("403s when the doc is the project's home doc", async () => {
    const { env, queueFirst } = makeEnv();
    queueFirst({ project_id: "p1" }); // doc
    queueFirst({ home_doc_id: "d1" }); // project
    const res = await call(env, "DELETE", "/docs/d1");
    expect(res.status).toBe(403);
  });

  it("deletes the doc for an editor", async () => {
    const { env, queueFirst } = makeEnv();
    queueFirst({ project_id: "p1" }); // doc
    queueFirst({ home_doc_id: null }); // project
    const res = await call(env, "DELETE", "/docs/d1");
    expect(res.status).toBe(200);
    expect(deleteDoc).toHaveBeenCalled();
  });
});

describe("handleDocs fallthrough", () => {
  it("404s an unknown method/path", async () => {
    const { env } = makeEnv();
    const res = await call(env, "PATCH", "/docs/d1");
    expect(res.status).toBe(404);
  });
});
