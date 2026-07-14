import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./docLinks", () => ({ indexDocLinks: vi.fn(), invalidateProjectGraphIndex: vi.fn() }));
vi.mock("./fts", () => ({ upsertFtsRow: vi.fn(), deleteFtsRow: vi.fn() }));

import { applyDocUpdate, snapshotDocRevision, latestDocRevisionContent, deleteR2Prefix, deleteDoc, pruneDocRevisions, normalizeDocSlug, syncDocSlug, type DocUpdateRow } from "./docOps";
import { indexDocLinks, invalidateProjectGraphIndex } from "./docLinks";
import { upsertFtsRow, deleteFtsRow } from "./fts";

type Env = Parameters<typeof applyDocUpdate>[0];

// Queue-based D1 mock with bind-arg capture (see memory/test-patterns) plus an
// R2 mock backed by a key→content map so reads hit the "right" object.
function makeEnv(objects: Record<string, string> = {}) {
  const firsts: unknown[] = [];
  const alls: unknown[] = [];
  const bindCalls: unknown[][] = [];
  const first = vi.fn(() => Promise.resolve(firsts.shift() ?? null));
  const all = vi.fn(() => Promise.resolve(alls.shift() ?? { results: [] }));
  const run = vi.fn(() => Promise.resolve({ meta: { changes: 1 } }));
  const bind = vi.fn((...args: unknown[]) => { bindCalls.push(args); return { first, all, run }; });
  const prepare = vi.fn((_sql: string) => ({ bind }));
  const batch = vi.fn(() => Promise.resolve([]));

  const store = { ...objects };
  const assetsGet = vi.fn(async (key: string) => (key in store ? { text: async () => store[key] } : null));
  const assetsPut = vi.fn(async (key: string, content: string) => { store[key] = content; });
  const assetsDelete = vi.fn(async (_keys: string | string[]) => undefined);
  const assetsList = vi.fn(async () => ({ objects: [] as { key: string }[], truncated: false as const, delimitedPrefixes: [] as string[] }));

  return {
    env: {
      DB: { prepare, batch },
      ASSETS: { get: assetsGet, put: assetsPut, delete: assetsDelete, list: assetsList },
    } as unknown as Env,
    prepare,
    bindCalls,
    run,
    store,
    assetsGet,
    assetsPut,
    assetsDelete,
    assetsList,
    queueFirst: (v: unknown) => firsts.push(v),
    queueAll: (v: unknown) => alls.push(v),
  };
}

const doc: DocUpdateRow = {
  id: "d1",
  title: "Doc Title",
  project_id: "p1",
  author_id: "author-1",
  published_at: null,
  show_heading: 1,
  show_last_updated: 1,
  folder_id: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

function preparedSql(prepare: ReturnType<typeof makeEnv>["prepare"]): string[] {
  return prepare.mock.calls.map(c => c[0] as string);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("latestDocRevisionContent", () => {
  it("returns null when the doc has no revisions", async () => {
    const { env, queueFirst, prepare } = makeEnv();
    queueFirst(null);
    expect(await latestDocRevisionContent(env, "p1", "d1")).toBeNull();
    expect(preparedSql(prepare)[0]).toContain("ORDER BY created_at DESC, id DESC LIMIT 1");
  });

  it("returns the newest revision's R2 snapshot content", async () => {
    const { env, queueFirst } = makeEnv({ "p1/d1/v/rev-9": "latest revision body" });
    queueFirst({ id: "rev-9" });
    expect(await latestDocRevisionContent(env, "p1", "d1")).toBe("latest revision body");
  });

  it("returns empty string when the revision row exists but the object is gone", async () => {
    const { env, queueFirst } = makeEnv();
    queueFirst({ id: "rev-9" });
    expect(await latestDocRevisionContent(env, "p1", "d1")).toBe("");
  });
});

describe("applyDocUpdate revision baseline", () => {
  it("creates a revision when content differs from the latest revision even though it equals the live R2 body (collab-mirror case)", async () => {
    const { env, queueFirst, prepare, bindCalls, assetsPut } = makeEnv({
      "p1/d1": "mirrored by collab", // live body already equals the incoming save
      "p1/d1/v/rev-1": "older revision body",
    });
    queueFirst({ id: "rev-1" }); // latest-revision lookup

    const result = await applyDocUpdate(env, doc, "u1", "User One", { content: "mirrored by collab", changelog: "my changelog" });

    expect(result.savedContent).toBe("mirrored by collab");
    const insertIdx = preparedSql(prepare).findIndex(s => s.includes("INSERT INTO asset_revisions"));
    expect(insertIdx).toBeGreaterThanOrEqual(0);
    expect(preparedSql(prepare)[insertIdx]).toContain("title");
    // (revisionId, docId, projectId, editorId, editorName, now, changelog, contributors, title)
    const insertBinds = bindCalls.find(b => b[1] === "d1" && b.length === 9)!;
    expect(insertBinds[6]).toBe("my changelog");
    expect(insertBinds[8]).toBe("Doc Title");
    // Live body + versioned snapshot both written.
    const putKeys = assetsPut.mock.calls.map(c => c[0] as string);
    expect(putKeys).toContain("p1/d1");
    expect(putKeys.some(k => k.startsWith("p1/d1/v/"))).toBe(true);
  });

  it("skips revision creation when content equals the latest revision's content", async () => {
    const { env, queueFirst, prepare, assetsPut } = makeEnv({
      "p1/d1": "something collab mirrored", // live body differs - must NOT be the baseline
      "p1/d1/v/rev-1": "same content",
    });
    queueFirst({ id: "rev-1" });

    const result = await applyDocUpdate(env, doc, "u1", "User One", { content: "same content" });

    expect(result.savedContent).toBeUndefined();
    expect(preparedSql(prepare).some(s => s.includes("INSERT INTO asset_revisions"))).toBe(false);
    expect(assetsPut).not.toHaveBeenCalled();
    expect(indexDocLinks).not.toHaveBeenCalled();
    expect(preparedSql(prepare).some(s => s.includes("DELETE FROM doc_ai_summaries"))).toBe(false);
  });

  it("falls back to comparing against the live R2 body when no revisions exist (no change → skip)", async () => {
    const { env, queueFirst, prepare } = makeEnv({ "p1/d1": "live body" });
    queueFirst(null); // no revisions

    const result = await applyDocUpdate(env, doc, "u1", "User One", { content: "live body" });

    expect(result.savedContent).toBeUndefined();
    expect(preparedSql(prepare).some(s => s.includes("INSERT INTO asset_revisions"))).toBe(false);
  });

  it("falls back to the live R2 body when no revisions exist (changed → revision)", async () => {
    const { env, queueFirst, prepare } = makeEnv({ "p1/d1": "live body" });
    queueFirst(null); // no revisions

    const result = await applyDocUpdate(env, doc, "u1", "User One", { content: "brand new body" });

    expect(result.savedContent).toBe("brand new body");
    expect(preparedSql(prepare).some(s => s.includes("INSERT INTO asset_revisions"))).toBe(true);
  });

  it("records the patched title on the revision when title and content change together", async () => {
    const { env, queueFirst, bindCalls } = makeEnv({ "p1/d1/v/rev-1": "old" });
    queueFirst({ id: "rev-1" });

    await applyDocUpdate(env, doc, "u1", "User One", { content: "new", title: "Renamed" });

    const insertBinds = bindCalls.find(b => b[1] === "d1" && b.length === 9)!;
    expect(insertBinds[8]).toBe("Renamed");
    expect(upsertFtsRow).toHaveBeenCalledWith(expect.anything(), "d1", "p1", "Renamed", "new");
  });

  it("still reindexes FTS on a title-only change", async () => {
    const { env } = makeEnv({ "p1/d1": "existing body" });

    await applyDocUpdate(env, doc, "u1", "User One", { title: "Renamed" });

    expect(upsertFtsRow).toHaveBeenCalledWith(expect.anything(), "d1", "p1", "Renamed", "existing body");
    expect(invalidateProjectGraphIndex).toHaveBeenCalled();
  });
});

describe("snapshotDocRevision", () => {
  it("runs the full side-effect chain: v/ snapshot, insert, FTS, doc links, AI-summary invalidation, updated_at bump", async () => {
    const { env, prepare, bindCalls, assetsPut } = makeEnv();

    const revisionId = await snapshotDocRevision(env, {
      projectId: "p1",
      docId: "d1",
      content: "checkpoint text",
      title: "Checkpoint Title",
      editorId: "u2",
      editorName: "User Two",
      changelog: null,
      contributors: JSON.stringify([{ id: "u2", name: "User Two" }, { id: "u3", name: "User Three" }]),
      now: "2026-07-01T12:00:00.000Z",
    });

    expect(revisionId).toMatch(/[0-9a-f-]{36}/);
    expect(assetsPut).toHaveBeenCalledWith(`p1/d1/v/${revisionId}`, "checkpoint text");

    const sql = preparedSql(prepare);
    const insertIdx = sql.findIndex(s => s.includes("INSERT INTO asset_revisions"));
    expect(insertIdx).toBeGreaterThanOrEqual(0);
    expect(bindCalls[insertIdx]).toEqual([
      revisionId, "d1", "p1", "u2", "User Two", "2026-07-01T12:00:00.000Z",
      null, JSON.stringify([{ id: "u2", name: "User Two" }, { id: "u3", name: "User Three" }]), "Checkpoint Title",
    ]);

    expect(upsertFtsRow).toHaveBeenCalledWith(expect.anything(), "d1", "p1", "Checkpoint Title", "checkpoint text");
    expect(indexDocLinks).toHaveBeenCalledWith(env, "p1", "d1", "checkpoint text");

    const aiIdx = sql.findIndex(s => s.includes("DELETE FROM doc_ai_summaries"));
    expect(aiIdx).toBeGreaterThanOrEqual(0);
    expect(bindCalls[aiIdx]).toEqual(["d1"]);

    const bumpIdx = sql.findIndex(s => s.includes("UPDATE docs SET sidebar_position"));
    expect(bumpIdx).toBeGreaterThanOrEqual(0);
    // Plain body → sidebar_position/tags sync to NULL alongside the updated_at bump.
    expect(bindCalls[bumpIdx]).toEqual([null, null, "2026-07-01T12:00:00.000Z", "d1"]);
  });

  it("syncs the frontmatter-derived columns (sidebar_position, tags, slug) from the persisted body", async () => {
    const { env, prepare, bindCalls } = makeEnv();

    await snapshotDocRevision(env, {
      projectId: "p1",
      docId: "d1",
      content: "---\nsidebar_position: 3\ntags: [lore]\nslug: My-Page\n---\nbody",
      title: "T",
      editorId: "u1",
      editorName: "User One",
      now: "2026-07-01T12:00:00.000Z",
    });

    const sql = preparedSql(prepare);
    const colIdx = sql.findIndex(s => s.includes("UPDATE docs SET sidebar_position"));
    expect(bindCalls[colIdx]).toEqual([3, JSON.stringify(["lore"]), "2026-07-01T12:00:00.000Z", "d1"]);
    const slugIdx = sql.findIndex(s => s.includes("UPDATE docs SET slug"));
    expect(slugIdx).toBeGreaterThanOrEqual(0);
    expect(bindCalls[slugIdx]).toEqual(["d1", "my-page", "p1"]);
  });
});

describe("normalizeDocSlug", () => {
  it("lowercases and accepts alphanumerics with inner hyphens", () => {
    expect(normalizeDocSlug("Getting-Started")).toBe("getting-started");
    expect(normalizeDocSlug("  page2  ")).toBe("page2");
    expect(normalizeDocSlug("a")).toBe("a");
  });

  it("rejects empty, overlong, and malformed values", () => {
    expect(normalizeDocSlug(undefined)).toBeNull();
    expect(normalizeDocSlug("")).toBeNull();
    expect(normalizeDocSlug("a".repeat(101))).toBeNull();
    expect(normalizeDocSlug("-leading")).toBeNull();
    expect(normalizeDocSlug("trailing-")).toBeNull();
    expect(normalizeDocSlug("has space")).toBeNull();
    expect(normalizeDocSlug("uni/code")).toBeNull();
    expect(normalizeDocSlug("under_score")).toBeNull();
  });

  it("rejects reserved segments and UUID-shaped slugs (which would shadow doc-id URLs)", () => {
    expect(normalizeDocSlug("graph")).toBeNull();
    expect(normalizeDocSlug("123e4567-e89b-42d3-a456-426614174000")).toBeNull();
  });
});

describe("syncDocSlug", () => {
  it("writes the normalized slug guarded against another doc already holding it", async () => {
    const { env, prepare, bindCalls } = makeEnv();
    await syncDocSlug(env, "p1", "d1", "My-Slug");
    const sql = preparedSql(prepare)[0];
    expect(sql).toContain("UPDATE docs SET slug");
    expect(sql).toContain("NOT EXISTS");
    expect(bindCalls[0]).toEqual(["d1", "my-slug", "p1"]);
  });

  it("clears the slug when the frontmatter value is absent or invalid", async () => {
    const { env, bindCalls } = makeEnv();
    await syncDocSlug(env, "p1", "d1", undefined);
    await syncDocSlug(env, "p1", "d1", "not a valid slug!");
    expect(bindCalls[0]).toEqual(["d1", null, "p1"]);
    expect(bindCalls[1]).toEqual(["d1", null, "p1"]);
  });
});

describe("deleteR2Prefix", () => {
  it("pages through the listing and deletes each page's keys in one array call", async () => {
    const { env, assetsList, assetsDelete } = makeEnv();
    assetsList
      .mockResolvedValueOnce({ objects: [{ key: "p1/d1/v/a" }, { key: "p1/d1/v/b" }], truncated: true, cursor: "c1", delimitedPrefixes: [] } as never)
      .mockResolvedValueOnce({ objects: [{ key: "p1/d1/v/c" }], truncated: false, delimitedPrefixes: [] } as never);

    await deleteR2Prefix(env.ASSETS, "p1/d1/v/");

    expect(assetsList).toHaveBeenNthCalledWith(1, { prefix: "p1/d1/v/", cursor: undefined });
    expect(assetsList).toHaveBeenNthCalledWith(2, { prefix: "p1/d1/v/", cursor: "c1" });
    expect(assetsDelete.mock.calls.map(c => c[0])).toEqual([["p1/d1/v/a", "p1/d1/v/b"], ["p1/d1/v/c"]]);
  });

  it("issues no delete for an empty listing", async () => {
    const { env, assetsDelete } = makeEnv();
    await deleteR2Prefix(env.ASSETS, "p1/d1/v/");
    expect(assetsDelete).not.toHaveBeenCalled();
  });
});

describe("deleteDoc", () => {
  it("deletes the body by key and the revision objects by prefix sweep, then cleans D1/FTS/graph", async () => {
    const { env, prepare, assetsList, assetsDelete } = makeEnv();
    assetsList.mockResolvedValueOnce({ objects: [{ key: "p1/d1/v/r1" }, { key: "p1/d1/v/r2" }], truncated: false, delimitedPrefixes: [] } as never);

    await deleteDoc(env, "d1", "p1");

    expect(assetsDelete).toHaveBeenCalledWith("p1/d1");
    expect(assetsList).toHaveBeenCalledWith({ prefix: "p1/d1/v/", cursor: undefined });
    expect(assetsDelete).toHaveBeenCalledWith(["p1/d1/v/r1", "p1/d1/v/r2"]);

    const sql = preparedSql(prepare);
    expect(sql.some(s => s.includes("DELETE FROM docs"))).toBe(true);
    expect(sql.some(s => s.includes("DELETE FROM asset_revisions"))).toBe(true);
    expect(sql.some(s => s.includes("DELETE FROM doc_shares"))).toBe(true);
    // No per-revision D1 SELECT needed anymore.
    expect(sql.some(s => s.includes("SELECT id FROM asset_revisions"))).toBe(false);
    expect(deleteFtsRow).toHaveBeenCalledWith(expect.anything(), "d1");
    expect(invalidateProjectGraphIndex).toHaveBeenCalledWith(env, "p1");
  });
});

describe("pruneDocRevisions", () => {
  const oldRev = (n: number) => ({ id: `r${n}`, project_id: "p1", asset_id: "d1" });

  it("selects only non-newest revisions older than the 90-day cutoff", async () => {
    const { env, prepare, bindCalls, queueAll } = makeEnv();
    queueAll({ results: [] });
    const now = new Date("2026-07-01T00:00:00.000Z");

    const pruned = await pruneDocRevisions(env, { now });

    expect(pruned).toBe(0);
    const sql = preparedSql(prepare)[0];
    expect(sql).toContain("ROW_NUMBER() OVER (PARTITION BY asset_id ORDER BY created_at DESC, id DESC)");
    expect(sql).toContain("rn > 1 AND created_at < ?");
    // 90 days before `now`.
    expect(bindCalls[0][0]).toBe("2026-04-02T00:00:00.000Z");
    expect(bindCalls[0][1]).toBe(500);
  });

  it("deletes R2 snapshots in one array call and rows in <=50-id chunks", async () => {
    const { env, prepare, bindCalls, queueAll, assetsDelete } = makeEnv();
    const rows = Array.from({ length: 60 }, (_, i) => oldRev(i));
    queueAll({ results: rows });
    // Short page (60 < 500) ends the loop after one pass.

    const pruned = await pruneDocRevisions(env, { now: new Date("2026-07-01T00:00:00.000Z") });

    expect(pruned).toBe(60);
    expect(assetsDelete).toHaveBeenCalledTimes(1);
    expect(assetsDelete).toHaveBeenCalledWith(rows.map(r => `p1/d1/v/${r.id}`));
    const deletes = preparedSql(prepare).filter(s => s.includes("DELETE FROM asset_revisions WHERE id IN"));
    expect(deletes).toHaveLength(2); // 50 + 10
    const deleteBinds = bindCalls.slice(1);
    expect(deleteBinds[0]).toHaveLength(50);
    expect(deleteBinds[1]).toHaveLength(10);
  });

  it("loops full pages and stops at maxBatches", async () => {
    const { env, queueAll, assetsDelete } = makeEnv();
    const fullPage = Array.from({ length: 5 }, (_, i) => oldRev(i));
    // Queue more full pages than maxBatches allows - the cap must stop it.
    for (let i = 0; i < 10; i++) queueAll({ results: fullPage });

    const pruned = await pruneDocRevisions(env, { now: new Date("2026-07-01T00:00:00.000Z"), batch: 5, maxBatches: 3 });

    expect(pruned).toBe(15);
    expect(assetsDelete).toHaveBeenCalledTimes(3);
  });
});
