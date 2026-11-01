import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleGraph, handleGraphReindex, handlePublicGraph, reindexIfStale, reindexStaleGraphs } from "./graph";
import { createSqliteD1, type SqliteD1 } from "../test/sqliteD1";
import { seedContentFixture } from "../test/contentFixture";

vi.mock("../lib/access", () => ({ resolveAccess: vi.fn() }));
vi.mock("../lib/docLinks", () => ({ reindexProject: vi.fn(async () => {}) }));

import { resolveAccess } from "../lib/access";
import { reindexProject } from "../lib/docLinks";

type Env = Parameters<typeof handleGraph>[1];
const user = { userId: "user-1", email: "a@example.com" } as unknown as Parameters<typeof handleGraph>[2];

let sql: SqliteD1;
let env: Env;

function exec(q: string, ...args: (string | number | null)[]) {
  sql.sqlite.prepare(q).run(...args);
}
function indexedAt(id = "p1"): string | null {
  return (sql.sqlite.prepare("SELECT graph_indexed_at FROM projects WHERE id = ?").get(id) as { graph_indexed_at: string | null }).graph_indexed_at;
}
function getGraph(path = "/projects/p1/graph", method = "GET") {
  return handleGraph(new Request(`http://localhost${path}`, { method }), env, user, new URL(`http://localhost${path}`));
}
function getPublicGraph(slug = "p1") {
  return handlePublicGraph(env, new URL(`http://localhost/public/projects/${slug}/graph`));
}
function postReindex() {
  const path = "/projects/p1/graph/reindex";
  return handleGraphReindex(new Request(`http://localhost${path}`, { method: "POST" }), env, user, new URL(`http://localhost${path}`));
}
type GraphJson = { data: { nodes: { id: string; links: number }[]; edges: { source: string; target: string }[]; tagColors: unknown[] } };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveAccess).mockResolvedValue({ role: "editor" } as never);
  vi.mocked(reindexProject).mockImplementation(async () => {});
  sql = createSqliteD1();
  seedContentFixture(sql.sqlite);
  // Graph on + already indexed; links d1->d2, d1->d3, d4->d5.
  exec("UPDATE projects SET graph_enabled = 1, graph_indexed_at = '2026-01-01T00:00:00.000Z', graph_tag_colors = ? WHERE id = 'p1'",
    JSON.stringify([{ tag: "x", color: "#fff" }]));
  for (const [s, t] of [["d1", "d2"], ["d1", "d3"], ["d4", "d5"]]) {
    exec("INSERT INTO doc_links (source_doc_id, target_doc_id, project_id) VALUES (?, ?, 'p1')", s, t);
  }
  exec("UPDATE docs SET tags = '[\"a\"]' WHERE id = 'd1'");
  env = { DB: sql.db } as unknown as Env;
});

describe("handleGraph", () => {
  it("404s on a non-GET method before touching access or the DB", async () => {
    const res = await getGraph("/projects/p1/graph", "POST");
    expect(res.status).toBe(404);
    expect(resolveAccess).not.toHaveBeenCalled();
  });

  it("403s when the caller has no access to the project", async () => {
    vi.mocked(resolveAccess).mockResolvedValue(null);
    expect((await getGraph()).status).toBe(403);
  });

  it("404s when the project row is missing", async () => {
    expect((await getGraph("/projects/nope/graph")).status).toBe(404);
  });

  it("403s when graph is disabled for the project", async () => {
    exec("UPDATE projects SET graph_enabled = 0 WHERE id = 'p1'");
    expect((await getGraph()).status).toBe(403);
  });

  it("returns nodes + edges + tagColors without reindexing an indexed site", async () => {
    const res = await getGraph();
    expect(res.status).toBe(200);
    const json = (await res.json()) as GraphJson;
    expect(json.data.nodes).toHaveLength(7);
    expect(json.data.edges).toHaveLength(3);
    expect(json.data.tagColors).toEqual([{ tag: "x", color: "#fff" }]);
    expect(reindexProject).not.toHaveBeenCalled();
  });

  it("limits a limited member to their in-site shares (and edges between them)", async () => {
    vi.mocked(resolveAccess).mockResolvedValue({ role: "limited" } as never);
    const json = (await (await getGraph()).json()) as GraphJson;
    // d1/d2/d4 only - not user-2's d3, nor the stray p2 share x1.
    expect(json.data.nodes.map(n => n.id).sort()).toEqual(["d1", "d2", "d4"]);
    expect(json.data.edges).toEqual([{ source: "d1", target: "d2" }]);
  });

  it("reindexes a stale site once, even for concurrent viewers", async () => {
    exec("UPDATE projects SET graph_indexed_at = NULL WHERE id = 'p1'");
    let release!: () => void;
    vi.mocked(reindexProject).mockImplementation(() => new Promise<void>(r => { release = r; }));
    const views = [getGraph(), getGraph(), getGraph()];
    // Let every view get as far as the claim before the one rebuild finishes.
    await vi.waitFor(() => expect(reindexProject).toHaveBeenCalled());
    await new Promise(r => setTimeout(r, 10));
    release();
    const results = await Promise.all(views);
    expect(results.map(r => r.status)).toEqual([200, 200, 200]);
    expect(reindexProject).toHaveBeenCalledTimes(1);
    expect(indexedAt()).not.toBeNull();
  });

  it("releases the claim and still serves the stored links when the rebuild fails", async () => {
    exec("UPDATE projects SET graph_indexed_at = NULL WHERE id = 'p1'");
    vi.mocked(reindexProject).mockRejectedValue(new Error("r2 down"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await getGraph();
    err.mockRestore();
    expect(res.status).toBe(200);
    expect(((await res.json()) as GraphJson).data.edges).toHaveLength(3);
    expect(indexedAt()).toBeNull(); // the next viewer / cron retries
  });

  it("keeps an invalidation that lands mid-rebuild", async () => {
    exec("UPDATE projects SET graph_indexed_at = NULL WHERE id = 'p1'");
    vi.mocked(reindexProject).mockImplementation(async () => {
      // e.g. a doc rename while the rebuild is reading R2
      exec("UPDATE projects SET graph_indexed_at = NULL WHERE id = 'p1'");
    });
    expect((await getGraph()).status).toBe(200);
    expect(indexedAt()).toBeNull();
  });
});

describe("handlePublicGraph", () => {
  beforeEach(() => {
    exec("UPDATE projects SET published_at = '2026-01-01T00:00:00.000Z', published_graph_enabled = 1 WHERE id = 'p1'");
  });

  it("serves the stored links for a stale site without reindexing or writing", async () => {
    exec("UPDATE projects SET graph_indexed_at = NULL WHERE id = 'p1'");
    const before = sql.sqlite.prepare("SELECT total_changes() AS n").get() as { n: number };
    const res = await getPublicGraph();
    const after = sql.sqlite.prepare("SELECT total_changes() AS n").get() as { n: number };
    expect(res.status).toBe(200);
    const json = (await res.json()) as GraphJson;
    expect(json.data.nodes).toHaveLength(7);
    expect(json.data.edges).toHaveLength(3);
    expect(reindexProject).not.toHaveBeenCalled();
    expect(after.n).toBe(before.n);
    expect(indexedAt()).toBeNull();
  });

  it("403s when the published graph is off", async () => {
    exec("UPDATE projects SET published_graph_enabled = 0 WHERE id = 'p1'");
    expect((await getPublicGraph()).status).toBe(403);
  });
});

describe("reindexIfStale", () => {
  it("only the caller that flips graph_indexed_at does the work", async () => {
    exec("UPDATE projects SET graph_indexed_at = NULL WHERE id = 'p1'");
    expect(await reindexIfStale(env, "p1")).toBe(true);
    expect(await reindexIfStale(env, "p1")).toBe(false);
    expect(reindexProject).toHaveBeenCalledTimes(1);
  });
});

describe("reindexStaleGraphs (daily cron)", () => {
  it("rebuilds only stale graph-enabled sites, each once", async () => {
    exec("UPDATE projects SET graph_indexed_at = NULL WHERE id = 'p1'");
    // p2: stale but the graph is off - left alone.
    exec("UPDATE projects SET graph_enabled = 0, graph_indexed_at = NULL WHERE id = 'p2'");
    // p3: graph on and already indexed - left alone.
    exec("INSERT INTO projects (id, name, owner_id, created_at, graph_enabled, graph_indexed_at) VALUES ('p3', 'Third', 'owner', '2026', 1, '2026')");
    expect(await reindexStaleGraphs(env)).toBe(1);
    expect(vi.mocked(reindexProject).mock.calls.map(c => c[1])).toEqual(["p1"]);
    expect(indexedAt("p1")).not.toBeNull();
    expect(indexedAt("p2")).toBeNull();
    // Nothing stale left: a second pass is a no-op.
    expect(await reindexStaleGraphs(env)).toBe(0);
    expect(reindexProject).toHaveBeenCalledTimes(1);
  });

  it("keeps going past a failing site and leaves it stale for the next run", async () => {
    exec("UPDATE projects SET graph_indexed_at = NULL WHERE id = 'p1'");
    exec("INSERT INTO projects (id, name, owner_id, created_at, graph_enabled) VALUES ('p3', 'Third', 'owner', '2026', 1)");
    vi.mocked(reindexProject).mockImplementation(async (_env, id) => { if (id === "p1") throw new Error("boom"); });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await reindexStaleGraphs(env)).toBe(1);
    err.mockRestore();
    expect(indexedAt("p1")).toBeNull();
    expect(indexedAt("p3")).not.toBeNull();
  });
});

describe("handleGraphReindex", () => {
  it("403s for a non-admin caller", async () => {
    expect((await postReindex()).status).toBe(403);
  });

  it("429s when still within the reindex cooldown", async () => {
    vi.mocked(resolveAccess).mockResolvedValue({ role: "admin" } as never);
    exec("UPDATE projects SET graph_reindex_available_at = ? WHERE id = 'p1'", new Date(Date.now() + 60_000).toISOString());
    expect((await postReindex()).status).toBe(429);
    expect(reindexProject).not.toHaveBeenCalled();
  });

  it("reindexes, marks the graph indexed and returns the next-available time", async () => {
    vi.mocked(resolveAccess).mockResolvedValue({ role: "admin" } as never);
    exec("UPDATE projects SET graph_indexed_at = NULL WHERE id = 'p1'");
    const res = await postReindex();
    expect(res.status).toBe(200);
    expect(reindexProject).toHaveBeenCalledWith(env, "p1");
    const json = (await res.json()) as { data: { nextAvailableAt: string } };
    expect(json.data.nextAvailableAt).toBeTruthy();
    expect(indexedAt()).not.toBeNull();
  });
});
