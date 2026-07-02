import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleProjects } from "./projects";

vi.mock("../lib/access", () => ({ resolveRole: vi.fn() }));
vi.mock("../lib/fts", () => ({ upsertFtsRow: vi.fn(), deleteFtsForProject: vi.fn() }));
vi.mock("../lib/customDomains", () => ({ releaseCustomDomain: vi.fn() }));

import { resolveRole } from "../lib/access";
import { releaseCustomDomain } from "../lib/customDomains";
import { upsertFtsRow } from "../lib/fts";

const user = { userId: "user-1", email: "a@example.com" } as unknown as Parameters<typeof handleProjects>[2];

function makeEnv() {
  const firsts: unknown[] = [];
  const alls: unknown[] = [];
  const runs: unknown[] = [];
  const batches: unknown[] = [];
  const bindCalls: unknown[][] = [];
  const first = vi.fn(() => Promise.resolve(firsts.shift() ?? null));
  const all = vi.fn(() => Promise.resolve(alls.shift() ?? { results: [] }));
  const run = vi.fn(() => Promise.resolve(runs.shift() ?? { meta: { changes: 1 } }));
  const bind = vi.fn((...args: unknown[]) => { bindCalls.push(args); return { first, all, run }; });
  const prepare = vi.fn((_sql: string) => ({ bind }));
  const batch = vi.fn(() => Promise.resolve(batches.shift() ?? []));
  const assetsGet = vi.fn(async () => null as unknown);
  const assetsList = vi.fn(async () => ({ objects: [] as { key: string }[], truncated: false as const, delimitedPrefixes: [] as string[] }));
  const assetsDelete = vi.fn(async (_keys: string | string[]) => undefined);
  const authFetch = vi.fn(async () => Response.json({ ok: true, data: { name: "Owner Name" } }, { status: 200 }));
  return {
    env: {
      DB: { prepare, batch },
      ASSETS: { get: assetsGet, put: vi.fn(), delete: assetsDelete, list: assetsList },
      AUTH: { fetch: authFetch },
    } as unknown as Parameters<typeof handleProjects>[1],
    run,
    batch,
    prepare,
    bindCalls,
    assetsGet,
    assetsList,
    assetsDelete,
    authFetch,
    queueFirst: (v: unknown) => firsts.push(v),
    queueAll: (v: unknown) => alls.push(v),
    queueBatch: (v: unknown) => batches.push(v),
  };
}

function call(env: Parameters<typeof handleProjects>[1], method: string, path: string, body?: unknown) {
  const url = new URL(`http://localhost${path}`);
  return handleProjects(
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
  vi.mocked(resolveRole).mockResolvedValue("owner");
});

describe("handleProjects logo routes", () => {
  it("404s an unknown variant", async () => {
    // Make the R2 object exist so the 404 pins the variant validation: without
    // it the handler would fetch the object and 200.
    const { env, assetsGet } = makeEnv();
    assetsGet.mockResolvedValue({ arrayBuffer: async () => new ArrayBuffer(4), httpMetadata: { contentType: "image/png" } });
    const res = await call(env, "GET", "/projects/p1/logo/bogus");
    expect(res.status).toBe(404);
  });

  it("404s GET for a non-member", async () => {
    vi.mocked(resolveRole).mockResolvedValue(null);
    // Make the R2 object exist so the 404 pins the membership gate: removing the
    // `role === null` check would let the bytes through with a 200.
    const { env, assetsGet } = makeEnv();
    assetsGet.mockResolvedValue({ arrayBuffer: async () => new ArrayBuffer(4), httpMetadata: { contentType: "image/png" } });
    const res = await call(env, "GET", "/projects/p1/logo/square");
    expect(res.status).toBe(404);
  });

  it("404s GET when the object is missing", async () => {
    const { env } = makeEnv(); // assetsGet → null
    const res = await call(env, "GET", "/projects/p1/logo/square");
    expect(res.status).toBe(404);
  });

  it("returns the logo bytes on GET", async () => {
    const { env, assetsGet } = makeEnv();
    assetsGet.mockResolvedValueOnce({ arrayBuffer: async () => new ArrayBuffer(4), httpMetadata: { contentType: "image/png" } });
    const res = await call(env, "GET", "/projects/p1/logo/wide");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
  });

  it("403s POST for a member below admin", async () => {
    vi.mocked(resolveRole).mockResolvedValue("editor");
    const { env } = makeEnv();
    const res = await call(env, "POST", "/projects/p1/logo/square");
    expect(res.status).toBe(403);
  });

  it("400s POST without multipart content-type", async () => {
    const { env } = makeEnv();
    const url = new URL("http://localhost/projects/p1/logo/square");
    const res = await handleProjects(new Request(url.toString(), { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }), env, user, url);
    expect(res.status).toBe(400);
  });

  it("400s POST with an invalid file type", async () => {
    const { env } = makeEnv();
    const form = new FormData();
    form.set("file", new File(["x"], "f.txt", { type: "text/plain" }));
    const url = new URL("http://localhost/projects/p1/logo/square");
    const res = await handleProjects(new Request(url.toString(), { method: "POST", body: form }), env, user, url);
    expect(res.status).toBe(400);
  });

  it("uploads the logo on POST for an admin", async () => {
    const { env, queueFirst } = makeEnv();
    const form = new FormData();
    form.set("file", new File([new Uint8Array([1, 2, 3])], "logo.png", { type: "image/png" }));
    queueFirst({ id: "p1", name: "Site" }); // updated project select
    const url = new URL("http://localhost/projects/p1/logo/square");
    const res = await handleProjects(new Request(url.toString(), { method: "POST", body: form }), env, user, url);
    expect(res.status).toBe(200);
    expect(env.ASSETS.put).toHaveBeenCalled();
  });

  it("clears the logo on DELETE for an admin", async () => {
    const { env, queueFirst } = makeEnv();
    queueFirst({ id: "p1", name: "Site" });
    const res = await call(env, "DELETE", "/projects/p1/logo/wide");
    expect(res.status).toBe(200);
    expect(env.ASSETS.delete).toHaveBeenCalled();
  });
});

describe("handleProjects GET list / POST create", () => {
  it("lists the caller's projects", async () => {
    const { env, queueAll } = makeEnv();
    queueAll({ results: [{ id: "p1", name: "Site", role: "owner" }] });
    const res = await call(env, "GET", "/projects");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: unknown[] };
    expect(json.data).toHaveLength(1);
  });

  it("400s POST without a name", async () => {
    const { env } = makeEnv();
    const res = await call(env, "POST", "/projects", { description: "x" });
    expect(res.status).toBe(400);
  });

  it("403s POST into an org the caller can't admin", async () => {
    const { env, queueFirst } = makeEnv();
    queueFirst({ role: "editor" }); // org role below admin
    const res = await call(env, "POST", "/projects", { name: "New", organizationId: "o1" });
    expect(res.status).toBe(403);
  });

  it("creates a project (201)", async () => {
    const { env, run } = makeEnv();
    const res = await call(env, "POST", "/projects", { name: "New Site" });
    expect(res.status).toBe(201);
    expect(run).toHaveBeenCalledTimes(2); // projects + project_members inserts
    const json = (await res.json()) as { data: { name: string } };
    expect(json.data.name).toBe("New Site");
  });

  it("creates a project inside an org for an org admin", async () => {
    const { env, queueFirst } = makeEnv();
    queueFirst({ role: "admin" }); // org role
    const res = await call(env, "POST", "/projects", { name: "Org Site", organizationId: "o1" });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { data: { organizationId: string | null } };
    expect(json.data.organizationId).toBe("o1");
  });
});

describe("handleProjects GET /projects/:id/contents", () => {
  it("404s for a non-member", async () => {
    vi.mocked(resolveRole).mockResolvedValue(null);
    const { env } = makeEnv();
    const res = await call(env, "GET", "/projects/p1/contents");
    expect(res.status).toBe(404);
  });

  it("returns the bundled folder/doc/file listing", async () => {
    vi.mocked(resolveRole).mockResolvedValue("editor");
    const { env, queueBatch } = makeEnv();
    queueBatch([
      { results: [{ id: "f1" }] }, // folders
      { results: [{ id: "d1" }] }, // docs
      { results: [] },             // files
      { results: [] },             // counts
    ]);
    const res = await call(env, "GET", "/projects/p1/contents");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { folders: unknown[]; docs: unknown[] } };
    expect(json.data.folders).toHaveLength(1);
    expect(json.data.docs).toHaveLength(1);
  });
});

describe("handleProjects GET /projects/:id", () => {
  it("404s for a non-member", async () => {
    vi.mocked(resolveRole).mockResolvedValue(null);
    // Queue the project row so the 404 pins the `role === null` gate: without it
    // the handler would find the row and 200.
    const { env, queueFirst } = makeEnv();
    queueFirst({ id: "p1", name: "Site" });
    const res = await call(env, "GET", "/projects/p1");
    expect(res.status).toBe(404);
  });

  it("404s when the row is missing", async () => {
    const { env } = makeEnv(); // first() → null
    const res = await call(env, "GET", "/projects/p1");
    expect(res.status).toBe(404);
  });

  it("returns the project with the caller's role", async () => {
    const { env, queueFirst } = makeEnv();
    queueFirst({ id: "p1", name: "Site" });
    const res = await call(env, "GET", "/projects/p1");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { role: string } };
    expect(json.data.role).toBe("owner");
  });
});

describe("handleProjects favourite/hidden toggles", () => {
  it("404s favourite when the caller has no membership row", async () => {
    const { env } = makeEnv(); // first() → null
    const res = await call(env, "PATCH", "/projects/p1/favourite");
    expect(res.status).toBe(404);
  });

  it("toggles favourite on", async () => {
    const { env, queueFirst, run } = makeEnv();
    queueFirst({ is_favourite: 0 });
    const res = await call(env, "PATCH", "/projects/p1/favourite");
    expect(res.status).toBe(200);
    expect(run).toHaveBeenCalled();
    const json = (await res.json()) as { data: { is_favourite: number } };
    expect(json.data.is_favourite).toBe(1);
  });

  it("toggles hidden on", async () => {
    const { env, queueFirst, run } = makeEnv();
    queueFirst({ is_hidden: 0 });
    const res = await call(env, "PATCH", "/projects/p1/hidden");
    expect(res.status).toBe(200);
    expect(run).toHaveBeenCalled();
    const json = (await res.json()) as { data: { is_hidden: number } };
    expect(json.data.is_hidden).toBe(1);
  });
});

describe("handleProjects PATCH /projects/:id", () => {
  it("404s for a non-member", async () => {
    vi.mocked(resolveRole).mockResolvedValue(null);
    const { env } = makeEnv();
    const res = await call(env, "PATCH", "/projects/p1", { name: "New" });
    expect(res.status).toBe(404);
  });

  it("403s for a member below admin", async () => {
    vi.mocked(resolveRole).mockResolvedValue("editor");
    const { env } = makeEnv();
    const res = await call(env, "PATCH", "/projects/p1", { name: "New" });
    expect(res.status).toBe(403);
  });

  it("400s on a blank name", async () => {
    const { env } = makeEnv();
    const res = await call(env, "PATCH", "/projects/p1", { name: "   " });
    expect(res.status).toBe(400);
  });

  it("400s on an invalid changelogMode", async () => {
    const { env } = makeEnv();
    const res = await call(env, "PATCH", "/projects/p1", { changelogMode: "weird" });
    expect(res.status).toBe(400);
  });

  it("400s on an invalid aiSummarizationType", async () => {
    const { env } = makeEnv();
    const res = await call(env, "PATCH", "/projects/p1", { aiSummarizationType: "sometimes" });
    expect(res.status).toBe(400);
  });

  it("400s on an invalid vanity slug", async () => {
    const { env } = makeEnv();
    const res = await call(env, "PATCH", "/projects/p1", { vanitySlug: "A b" });
    expect(res.status).toBe(400);
  });

  it("403s a vanity slug when the CUSTOM_LINK feature is off", async () => {
    const { env, queueFirst } = makeEnv();
    queueFirst({ features: 0 }); // feature lookup
    const res = await call(env, "PATCH", "/projects/p1", { vanitySlug: "my-site" });
    expect(res.status).toBe(403);
  });

  it("403s aiEnabled when the AI feature is off", async () => {
    const { env, queueFirst } = makeEnv();
    queueFirst({ features: 0 });
    const res = await call(env, "PATCH", "/projects/p1", { aiEnabled: true });
    expect(res.status).toBe(403);
  });

  it("400s when no updatable fields are supplied", async () => {
    const { env } = makeEnv();
    const res = await call(env, "PATCH", "/projects/p1", {});
    expect(res.status).toBe(400);
  });

  it("409s on a UNIQUE constraint violation", async () => {
    const { env, run } = makeEnv();
    run.mockRejectedValueOnce(new Error("UNIQUE constraint failed: projects.vanity_slug"));
    const res = await call(env, "PATCH", "/projects/p1", { name: "Dup" });
    expect(res.status).toBe(409);
  });

  it("updates the project (200)", async () => {
    const { env, queueFirst, run } = makeEnv();
    queueFirst({ id: "p1", name: "New" }); // updated select
    const res = await call(env, "PATCH", "/projects/p1", { name: "New" });
    expect(res.status).toBe(200);
    expect(run).toHaveBeenCalled();
  });
});

describe("handleProjects POST /projects/:id/reindex", () => {
  it("403s for a non-owner", async () => {
    vi.mocked(resolveRole).mockResolvedValue("admin");
    const { env } = makeEnv();
    const res = await call(env, "POST", "/projects/p1/reindex");
    expect(res.status).toBe(403);
  });

  it("returns indexed:0 for an empty project", async () => {
    const { env, queueAll } = makeEnv();
    queueAll({ results: [] }); // docs
    const res = await call(env, "POST", "/projects/p1/reindex");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { indexed: number } };
    expect(json.data.indexed).toBe(0);
  });

  it("reindexes every doc and counts them", async () => {
    const { env, queueAll, assetsGet } = makeEnv();
    queueAll({ results: [{ id: "d1", title: "A" }, { id: "d2", title: "B" }, { id: "d3", title: "C" }] }); // docs
    assetsGet.mockResolvedValue({ text: async () => "# body" }); // R2 content per doc
    const res = await call(env, "POST", "/projects/p1/reindex");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { indexed: number } };
    expect(json.data.indexed).toBe(3);
    // One FTS upsert per doc - a dropped loop body would not satisfy this.
    expect(upsertFtsRow).toHaveBeenCalledTimes(3);
  });
});

describe("handleProjects DELETE /projects/:id", () => {
  it("404s for a non-owner", async () => {
    vi.mocked(resolveRole).mockResolvedValue("admin");
    const { env } = makeEnv();
    const res = await call(env, "DELETE", "/projects/p1");
    expect(res.status).toBe(404);
  });

  it("deletes the project for the owner", async () => {
    const { env, queueAll, run } = makeEnv();
    queueAll({ results: [] }); // docs
    queueAll({ results: [] }); // files
    const res = await call(env, "DELETE", "/projects/p1");
    expect(res.status).toBe(200);
    expect(releaseCustomDomain).toHaveBeenCalled();
    expect(run).toHaveBeenCalled(); // DELETE projects
    const json = (await res.json()) as { data: { deleted: boolean } };
    expect(json.data.deleted).toBe(true);
  });

  it("deletes doc/revision R2 objects via a paged prefix sweep, not per-D1-row", async () => {
    const { env, queueAll, assetsList, assetsDelete } = makeEnv();
    queueAll({ results: [{ id: "d1" }] }); // docs
    queueAll({ results: [{ id: "f1" }, { id: "f2" }] }); // files
    // Two list pages under the project prefix - the second must be fetched via the cursor.
    assetsList
      .mockResolvedValueOnce({ objects: [{ key: "p1/d1" }, { key: "p1/d1/v/r1" }], truncated: true, cursor: "cur-1", delimitedPrefixes: [] } as never)
      .mockResolvedValueOnce({ objects: [{ key: "p1/d1/v/r2" }], truncated: false, delimitedPrefixes: [] } as never);

    const res = await call(env, "DELETE", "/projects/p1");
    expect(res.status).toBe(200);

    expect(assetsList).toHaveBeenNthCalledWith(1, { prefix: "p1/", cursor: undefined });
    expect(assetsList).toHaveBeenNthCalledWith(2, { prefix: "p1/", cursor: "cur-1" });
    // Batched array deletes: one per list page, plus one for files + logos.
    expect(assetsDelete.mock.calls.map(c => c[0])).toEqual([
      ["p1/d1", "p1/d1/v/r1"],
      ["p1/d1/v/r2"],
      ["files/f1", "files/f2", "site-logos/p1-square", "site-logos/p1-wide"],
    ]);
  });

  it("chunks the asset_revisions row delete to 50 doc ids per statement", async () => {
    const { env, queueAll, prepare, bindCalls } = makeEnv();
    const docIds = Array.from({ length: 60 }, (_, i) => `d${i}`);
    queueAll({ results: docIds.map(id => ({ id })) }); // docs
    queueAll({ results: [] }); // files
    const res = await call(env, "DELETE", "/projects/p1");
    expect(res.status).toBe(200);

    const revisionDeletes = prepare.mock.calls
      .map(c => c[0] as string)
      .filter(sql => sql.includes("DELETE FROM asset_revisions"));
    expect(revisionDeletes).toHaveLength(2);
    // 50 + 10 placeholders, and the bound ids match the chunks.
    expect(revisionDeletes[0].match(/\?/g)).toHaveLength(50);
    expect(revisionDeletes[1].match(/\?/g)).toHaveLength(10);
    expect(bindCalls).toContainEqual(docIds.slice(0, 50));
    expect(bindCalls).toContainEqual(docIds.slice(50));
  });
});

describe("handleProjects fallthrough", () => {
  it("404s an unknown method", async () => {
    const { env } = makeEnv();
    const res = await call(env, "PUT", "/projects/p1");
    expect(res.status).toBe(404);
  });
});
