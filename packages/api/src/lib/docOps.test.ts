import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createSqliteD1 } from "../test/sqliteD1";

import { applyDocUpdate, createDoc, snapshotDocRevision, latestDocRevisionContent, deleteR2Prefix, pruneDocRevisions, normalizeDocSlug, syncDocSlug, type DocUpdateRow } from "./docOps";

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

// ── Save path against real SQLite ────────────────────────────────────────────
//
// The save path's correctness now lives in batch composition (atomicity, the
// single merged docs UPDATE, which statements are skipped), so these run the
// real statements against the real schema (test/sqliteD1.ts, batch = one
// transaction) with an instrumented DB that records every D1 round trip.

const T0 = "2026-01-01T00:00:00.000Z";

interface D1Call { kind: "single" | "batch"; sql: string[] }

// Wraps the SQLite D1 stand-in so each direct statement execution and each
// batch() is logged as one round trip.
function instrument(db: D1Database, calls: D1Call[]): D1Database {
  type AnyStmt = D1PreparedStatement & { sql: string };
  const wrap = (s: AnyStmt): AnyStmt => new Proxy(s, {
    get(target, key, receiver) {
      if (key === "bind") return (...args: unknown[]) => wrap(target.bind(...args) as AnyStmt);
      if (key === "first" || key === "all" || key === "run" || key === "raw") {
        return (...args: unknown[]) => {
          calls.push({ kind: "single", sql: [target.sql] });
          return (target[key] as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return Reflect.get(target, key, receiver);
    },
  });
  return {
    prepare: (sql: string) => wrap(db.prepare(sql) as AnyStmt),
    batch: (stmts: AnyStmt[]) => {
      calls.push({ kind: "batch", sql: stmts.map(s => s.sql) });
      return db.batch(stmts);
    },
  } as unknown as D1Database;
}

// The two project-structure reads behind doc-link resolution.
const STRUCTURE_READ = /^SELECT id, (title, folder_id|name, parent_id) FROM (docs|folders) WHERE project_id = \?$/;

function setupSqlite(objects: Record<string, string> = {}) {
  const { db, sqlite } = createSqliteD1();
  const calls: D1Call[] = [];
  const store: Record<string, string> = { ...objects };
  const assetsPut = vi.fn(async (key: string, content: string) => { store[key] = content; });
  const assetsGet = vi.fn(async (key: string) => (key in store ? { text: async () => store[key] } : null));
  const env = { DB: instrument(db, calls), ASSETS: { get: assetsGet, put: assetsPut } } as unknown as Env;

  const exec = (sql: string, ...args: (string | number | null)[]) => { sqlite.prepare(sql).run(...args); };
  const rows = (sql: string, ...args: (string | number | null)[]) => sqlite.prepare(sql).all(...args).map(r => ({ ...r }));
  const one = (sql: string, ...args: (string | number | null)[]) => rows(sql, ...args)[0] as Record<string, unknown> | undefined;

  exec("INSERT INTO projects (id, name, owner_id, created_at, graph_indexed_at) VALUES ('p1', 'Site', 'u1', ?, ?)", T0, T0);
  const seedDoc = (id: string, title: string, body: string, folderId: string | null = null) => {
    exec(
      "INSERT INTO docs (id, title, project_id, author_id, folder_id, created_at, updated_at) VALUES (?, ?, 'p1', 'author-1', ?, ?, ?)",
      id, title, folderId, T0, T0,
    );
    exec("INSERT INTO docs_fts (doc_id, project_id, title, body) VALUES (?, 'p1', ?, ?)", id, title, body);
    store[`p1/${id}`] = body;
  };
  const seedRevision = (docId: string, revId: string, body: string, createdAt = T0) => {
    exec(
      "INSERT INTO asset_revisions (id, asset_type, asset_id, project_id, editor_id, editor_name, created_at, title) VALUES (?, 'doc', ?, 'p1', 'u0', 'User Zero', ?, 'Doc Title')",
      revId, docId, createdAt,
    );
    store[`p1/${docId}/v/${revId}`] = body;
  };
  const docRow = (id = "d1") => one("SELECT * FROM docs WHERE id = ?", id) as unknown as DocUpdateRow & { slug: string | null; tags: string | null; sidebar_position: number | null };
  const ftsRow = (id = "d1") => one("SELECT title, body FROM docs_fts WHERE doc_id = ?", id);
  const revisions = (docId = "d1") => rows("SELECT * FROM asset_revisions WHERE asset_id = ? ORDER BY created_at, id", docId);
  const links = (docId = "d1") => rows("SELECT target_doc_id FROM doc_links WHERE source_doc_id = ? ORDER BY target_doc_id", docId).map(r => r.target_doc_id);
  const graphIndexedAt = () => one("SELECT graph_indexed_at FROM projects WHERE id = 'p1'")!.graph_indexed_at;
  const sqlMatching = (re: RegExp) => calls.flatMap(c => c.sql).filter(s => re.test(s));
  const putKeys = () => assetsPut.mock.calls.map(c => c[0] as string);

  return { env, sqlite, calls, store, assetsPut, assetsGet, exec, rows, one, seedDoc, seedRevision, docRow, ftsRow, revisions, links, graphIndexedAt, sqlMatching, putKeys };
}

// Makes the given table's write fail inside the batch, so atomicity can be
// observed from what is (not) left behind.
function failOn(sqlite: DatabaseSync, when: string) {
  sqlite.exec(`CREATE TRIGGER test_fail ${when} BEGIN SELECT RAISE(ABORT, 'injected failure'); END;`);
}

describe("applyDocUpdate revision baseline", () => {
  it("creates a revision when content differs from the latest revision even though it equals the live R2 body (collab-mirror case)", async () => {
    const t = setupSqlite();
    t.seedDoc("d1", "Doc Title", "mirrored by collab"); // live body already equals the incoming save
    t.seedRevision("d1", "rev-1", "older revision body");

    const result = await applyDocUpdate(t.env, t.docRow(), "u1", "User One", { content: "mirrored by collab", changelog: "my changelog" });

    expect(result.savedContent).toBe("mirrored by collab");
    const rev = t.revisions().find(r => r.id !== "rev-1")!;
    expect(rev).toMatchObject({ editor_id: "u1", editor_name: "User One", changelog: "my changelog", title: "Doc Title", contributors: null });
    // Live body + versioned snapshot both written.
    expect(t.putKeys()).toEqual(expect.arrayContaining(["p1/d1", `p1/d1/v/${rev.id}`]));
    expect(t.store[`p1/d1/v/${rev.id}`]).toBe("mirrored by collab");
  });

  it("skips revision creation when content equals the latest revision's content", async () => {
    const t = setupSqlite();
    t.seedDoc("d1", "Doc Title", "something collab mirrored"); // live body differs - must NOT be the baseline
    t.seedRevision("d1", "rev-1", "same content");
    t.exec("INSERT INTO doc_ai_summaries (doc_id, summary, version) VALUES ('d1', 'cached', ?)", T0);
    const gatherContributors = vi.fn(async () => null);

    const result = await applyDocUpdate(t.env, t.docRow(), "u1", "User One", { content: "same content" }, { gatherContributors });

    expect(result.savedContent).toBeUndefined();
    expect(t.revisions()).toHaveLength(1);
    expect(t.assetsPut).not.toHaveBeenCalled();
    expect(gatherContributors).not.toHaveBeenCalled();
    expect(t.one("SELECT summary FROM doc_ai_summaries WHERE doc_id = 'd1'")).toEqual({ summary: "cached" });
  });

  it("falls back to comparing against the live R2 body when no revisions exist (no change → skip)", async () => {
    const t = setupSqlite();
    t.seedDoc("d1", "Doc Title", "live body");

    const result = await applyDocUpdate(t.env, t.docRow(), "u1", "User One", { content: "live body" });

    expect(result.savedContent).toBeUndefined();
    expect(t.revisions()).toHaveLength(0);
  });

  it("falls back to the live R2 body when no revisions exist (changed → revision)", async () => {
    const t = setupSqlite();
    t.seedDoc("d1", "Doc Title", "live body");

    const result = await applyDocUpdate(t.env, t.docRow(), "u1", "User One", { content: "brand new body" });

    expect(result.savedContent).toBe("brand new body");
    expect(t.revisions()).toHaveLength(1);
  });

  it("records the patched title on the revision and in FTS when title and content change together", async () => {
    const t = setupSqlite();
    t.seedDoc("d1", "Doc Title", "old");
    t.seedRevision("d1", "rev-1", "old");

    await applyDocUpdate(t.env, t.docRow(), "u1", "User One", { content: "new", title: "Renamed" });

    expect(t.revisions().find(r => r.id !== "rev-1")!.title).toBe("Renamed");
    expect(t.ftsRow()).toEqual({ title: "Renamed", body: "new" });
    expect(t.rows("SELECT COUNT(*) AS n FROM docs_fts WHERE doc_id = 'd1'")[0].n).toBe(1);
  });

  it("still reindexes FTS on a title-only change, from the live body", async () => {
    const t = setupSqlite();
    t.seedDoc("d1", "Doc Title", "existing body");

    await applyDocUpdate(t.env, t.docRow(), "u1", "User One", { title: "Renamed" });

    expect(t.ftsRow()).toEqual({ title: "Renamed", body: "existing body" });
    expect(t.docRow().title).toBe("Renamed");
    expect(t.graphIndexedAt()).toBeNull();
    // Title-only: one batch, no revision.
    expect(t.calls).toHaveLength(1);
    expect(t.revisions()).toHaveLength(0);
  });

  it("calls gatherContributors exactly once on a change and stores its result", async () => {
    const t = setupSqlite();
    t.seedDoc("d1", "Doc Title", "old");
    const contributors = JSON.stringify([{ id: "u1", name: "User One" }, { id: "u2", name: "User Two" }]);
    const gatherContributors = vi.fn(async () => contributors);

    await applyDocUpdate(t.env, t.docRow(), "u1", "User One", { content: "new" }, { gatherContributors });

    expect(gatherContributors).toHaveBeenCalledTimes(1);
    expect(t.revisions()[0].contributors).toBe(contributors);
  });
});

describe("applyDocUpdate save path (batched)", () => {
  it("writes the whole side-effect chain in ONE batch after at most two reads", async () => {
    const t = setupSqlite();
    t.seedDoc("d1", "Doc Title", "old body");
    t.seedDoc("d2", "Target", "target body");
    t.seedRevision("d1", "rev-1", "old body");
    t.exec("INSERT INTO doc_ai_summaries (doc_id, summary, version) VALUES ('d1', 'cached', ?)", T0);
    const body = "---\nsidebar_position: 4\ntags: [lore]\nslug: My-Page\n---\nSee [[Target]].";

    const result = await applyDocUpdate(t.env, t.docRow(), "u1", "User One", { content: body, title: "Renamed", changelog: "cl" });

    expect(result.savedContent).toBe(body);
    // Round trips: latest-revision lookup, link-resolution structure read
    // (one batch), then one write batch.
    expect(t.calls.map(c => c.kind)).toEqual(["single", "batch", "batch"]);
    expect(t.calls[0].sql[0]).toContain("FROM asset_revisions");
    expect(t.calls[1].sql.every(s => STRUCTURE_READ.test(s))).toBe(true);
    expect(t.sqlMatching(STRUCTURE_READ)).toHaveLength(2);

    // Exactly one docs UPDATE besides the slug sync (the old path ran two).
    const write = t.calls[2].sql;
    expect(write.filter(s => /^UPDATE docs SET (?!slug)/.test(s))).toHaveLength(1);
    expect(write.filter(s => /^UPDATE docs SET slug/.test(s))).toHaveLength(1);

    const row = t.docRow();
    expect(row).toMatchObject({ title: "Renamed", sidebar_position: 4, tags: JSON.stringify(["lore"]), slug: "my-page", updated_at: result.updated.updated_at });
    expect(row.updated_at).not.toBe(T0);
    const rev = t.revisions().find(r => r.id !== "rev-1")!;
    expect(rev).toMatchObject({ title: "Renamed", changelog: "cl", created_at: result.updated.updated_at });
    expect(t.ftsRow()).toMatchObject({ title: "Renamed" });
    expect(t.links()).toEqual(["d2"]);
    expect(t.one("SELECT * FROM doc_ai_summaries WHERE doc_id = 'd1'")).toBeUndefined();
    expect(t.graphIndexedAt()).toBeNull();
  });

  it("skips the project-structure read for link-free content and clears stale links", async () => {
    const t = setupSqlite();
    t.seedDoc("d1", "Doc Title", "old [[Target]]");
    t.seedDoc("d2", "Target", "target body");
    t.exec("INSERT INTO doc_links (source_doc_id, target_doc_id, project_id) VALUES ('d1', 'd2', 'p1')");

    await applyDocUpdate(t.env, t.docRow(), "u1", "User One", { content: "no links any more" });

    expect(t.calls.map(c => c.kind)).toEqual(["single", "batch"]);
    expect(t.sqlMatching(STRUCTURE_READ)).toHaveLength(0);
    expect(t.links()).toEqual([]);
    expect(t.revisions()).toHaveLength(1);
  });

  it("is atomic: a failing statement leaves nothing half-written", async () => {
    const t = setupSqlite();
    t.seedDoc("d1", "Doc Title", "old body");
    t.seedDoc("d2", "Target", "target body");
    t.seedRevision("d1", "rev-1", "old body");
    t.exec("INSERT INTO doc_ai_summaries (doc_id, summary, version) VALUES ('d1', 'cached', ?)", T0);
    // The graph invalidation is the LAST statement in the batch - everything
    // before it must roll back.
    failOn(t.sqlite, "BEFORE UPDATE OF graph_indexed_at ON projects");

    await expect(
      applyDocUpdate(t.env, t.docRow(), "u1", "User One", { content: "---\nslug: new-slug\ntags: [x]\n---\n[[Target]] new", title: "Renamed" }),
    ).rejects.toThrow(/injected failure/);

    expect(t.revisions().map(r => r.id)).toEqual(["rev-1"]);
    expect(t.ftsRow()).toEqual({ title: "Doc Title", body: "old body" });
    expect(t.links()).toEqual([]);
    expect(t.one("SELECT summary FROM doc_ai_summaries WHERE doc_id = 'd1'")).toEqual({ summary: "cached" });
    expect(t.docRow()).toMatchObject({ title: "Doc Title", slug: null, tags: null, updated_at: T0 });
    expect(t.graphIndexedAt()).toBe(T0);
  });

  it("a no-op save (content and title unchanged) writes no FTS, revision, links or R2", async () => {
    const t = setupSqlite();
    t.seedDoc("d1", "Doc Title", "same body");
    t.seedRevision("d1", "rev-1", "same body");

    const result = await applyDocUpdate(t.env, t.docRow(), "u1", "User One", { content: "same body", title: "Doc Title" });

    expect(result.savedContent).toBeUndefined();
    expect(t.sqlMatching(/docs_fts|asset_revisions \(|doc_links|doc_ai_summaries|projects/)).toHaveLength(0);
    expect(t.assetsPut).not.toHaveBeenCalled();
    expect(t.revisions()).toHaveLength(1);
    // Revision lookup + one write batch (docs UPDATE + slug sync).
    expect(t.calls.map(c => c.kind)).toEqual(["single", "batch"]);
    expect(t.calls[1].sql).toHaveLength(2);
    // updated_at still advances, as before.
    expect(t.docRow().updated_at).toBe(result.updated.updated_at);
  });

  it("a settings-only patch issues one statement and no FTS", async () => {
    const t = setupSqlite();
    t.seedDoc("d1", "Doc Title", "body");

    await applyDocUpdate(t.env, t.docRow(), "u1", "User One", { showHeading: false });

    expect(t.calls).toEqual([{ kind: "batch", sql: [expect.stringMatching(/^UPDATE docs SET show_heading = \?, updated_at = \?/)] }]);
    expect(t.docRow().show_heading).toBe(0);
  });

  it("an unchanged-content save still resyncs a drifted slug", async () => {
    const t = setupSqlite();
    t.seedDoc("d1", "Doc Title", "---\nslug: wanted\n---\nbody");
    t.seedRevision("d1", "rev-1", "---\nslug: wanted\n---\nbody");

    await applyDocUpdate(t.env, t.docRow(), "u1", "User One", { content: "---\nslug: wanted\n---\nbody" });

    expect(t.docRow().slug).toBe("wanted");
  });

  it("keeps first-claimant-wins slug uniqueness inside the batch", async () => {
    const t = setupSqlite();
    t.seedDoc("d1", "Doc Title", "old");
    t.seedDoc("d2", "Other", "other");
    t.exec("UPDATE docs SET slug = 'mine' WHERE id = 'd1'");
    t.exec("UPDATE docs SET slug = 'taken' WHERE id = 'd2'");

    const result = await applyDocUpdate(t.env, t.docRow(), "u1", "User One", { content: "---\nslug: taken\n---\nnew" });

    expect(result.savedContent).toBeDefined();
    expect(t.docRow().slug).toBe("mine");
    expect(t.docRow("d2").slug).toBe("taken");
  });

  it("resolves links with the same semantics as before (folder paths, id: refs, self-links dropped)", async () => {
    const t = setupSqlite();
    t.exec("INSERT INTO folders (id, name, project_id, parent_id, created_at) VALUES ('f1', 'Lore', 'p1', NULL, ?)", T0);
    t.seedDoc("d1", "Doc Title", "old");
    t.seedDoc("d2", "Guide", "g", "f1");
    t.seedDoc("d3", "Third", "t");

    await applyDocUpdate(t.env, t.docRow(), "u1", "User One", {
      content: "[[Lore/Guide]] [[id:d3]] [[Doc Title]] [[Missing]] [x](doc://Guide)",
    });

    expect(t.links()).toEqual(["d2", "d3"]);
  });
});

describe("snapshotDocRevision", () => {
  it("runs the full side-effect chain in one write batch: v/ snapshot, insert, FTS, doc links, AI-summary invalidation, updated_at bump", async () => {
    const t = setupSqlite();
    t.seedDoc("d1", "Checkpoint Title", "old");
    t.seedDoc("d2", "Target", "target");
    t.exec("INSERT INTO doc_ai_summaries (doc_id, summary, version) VALUES ('d1', 'cached', ?)", T0);
    const contributors = JSON.stringify([{ id: "u2", name: "User Two" }, { id: "u3", name: "User Three" }]);

    const revisionId = await snapshotDocRevision(t.env, {
      projectId: "p1",
      docId: "d1",
      content: "checkpoint text [[Target]]",
      title: "Checkpoint Title",
      editorId: "u2",
      editorName: "User Two",
      changelog: null,
      contributors,
      now: "2026-07-01T12:00:00.000Z",
    });

    expect(revisionId).toMatch(/[0-9a-f-]{36}/);
    expect(t.assetsPut).toHaveBeenCalledWith(`p1/d1/v/${revisionId}`, "checkpoint text [[Target]]");
    // Never writes the live body - the collab DO owns that.
    expect(t.putKeys()).not.toContain("p1/d1");
    expect(t.revisions()).toEqual([expect.objectContaining({
      id: revisionId, asset_type: "doc", asset_id: "d1", project_id: "p1", editor_id: "u2", editor_name: "User Two",
      created_at: "2026-07-01T12:00:00.000Z", changelog: null, contributors, title: "Checkpoint Title",
    })]);
    expect(t.ftsRow()).toEqual({ title: "Checkpoint Title", body: "checkpoint text Target" });
    expect(t.links()).toEqual(["d2"]);
    expect(t.one("SELECT * FROM doc_ai_summaries WHERE doc_id = 'd1'")).toBeUndefined();
    expect(t.docRow()).toMatchObject({ sidebar_position: null, tags: null, updated_at: "2026-07-01T12:00:00.000Z" });
    // Structure read + one write batch.
    expect(t.calls.map(c => c.kind)).toEqual(["batch", "batch"]);
  });

  it("syncs the frontmatter-derived columns (sidebar_position, tags, slug) from the persisted body", async () => {
    const t = setupSqlite();
    t.seedDoc("d1", "T", "old");

    await snapshotDocRevision(t.env, {
      projectId: "p1",
      docId: "d1",
      content: "---\nsidebar_position: 3\ntags: [lore]\nslug: My-Page\n---\nbody",
      title: "T",
      editorId: "u1",
      editorName: "User One",
      now: "2026-07-01T12:00:00.000Z",
    });

    expect(t.docRow()).toMatchObject({ sidebar_position: 3, tags: JSON.stringify(["lore"]), slug: "my-page", updated_at: "2026-07-01T12:00:00.000Z" });
    // Link-free body: no structure read, a single write batch.
    expect(t.calls.map(c => c.kind)).toEqual(["batch"]);
  });

  it("is atomic: a failing statement leaves no revision row or index changes", async () => {
    const t = setupSqlite();
    t.seedDoc("d1", "T", "old");
    failOn(t.sqlite, "BEFORE UPDATE OF slug ON docs");

    await expect(snapshotDocRevision(t.env, {
      projectId: "p1", docId: "d1", content: "new body", title: "T", editorId: "u1", editorName: "User One",
    })).rejects.toThrow(/injected failure/);

    expect(t.revisions()).toHaveLength(0);
    expect(t.ftsRow()).toEqual({ title: "T", body: "old" });
    expect(t.docRow().updated_at).toBe(T0);
  });
});

describe("createDoc", () => {
  it("writes the row, slug, FTS and graph invalidation in one batch after the body", async () => {
    const t = setupSqlite();

    const created = await createDoc(t.env, {
      projectId: "p1", authorId: "u1", title: "New Doc", folderId: null,
      content: "---\nsidebar_position: 2\ntags: [a]\nslug: New-Doc\n---\nhello",
    });

    expect(t.store[`p1/${created.id}`]).toContain("hello");
    expect(t.calls.map(c => c.kind)).toEqual(["batch"]);
    expect(t.docRow(created.id)).toMatchObject({
      title: "New Doc", author_id: "u1", sidebar_position: 2, tags: JSON.stringify(["a"]), slug: "new-doc",
      created_at: created.createdAt, updated_at: created.updatedAt, published_at: null,
    });
    expect(t.ftsRow(created.id)).toEqual({ title: "New Doc", body: "hello" });
    expect(t.graphIndexedAt()).toBeNull();
  });

  it("drops a slug another doc already holds", async () => {
    const t = setupSqlite();
    t.seedDoc("d2", "Other", "other");
    t.exec("UPDATE docs SET slug = 'taken' WHERE id = 'd2'");

    const created = await createDoc(t.env, { projectId: "p1", authorId: "u1", title: "New", folderId: null, content: "---\nslug: taken\n---\nx" });

    expect(t.docRow(created.id).slug).toBeNull();
  });

  it("is atomic: a failing statement leaves no docs row", async () => {
    const t = setupSqlite();
    failOn(t.sqlite, "BEFORE UPDATE OF graph_indexed_at ON projects");

    await expect(createDoc(t.env, { projectId: "p1", authorId: "u1", title: "New", folderId: null, content: "x" })).rejects.toThrow(/injected failure/);

    expect(t.rows("SELECT id FROM docs")).toEqual([]);
    expect(t.rows("SELECT doc_id FROM docs_fts")).toEqual([]);
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
