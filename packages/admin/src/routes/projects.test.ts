import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

vi.mock("../audit", () => ({ writeAdminAudit: vi.fn() }));
vi.mock("../../../api/src/lib/fts", () => ({ upsertFtsRow: vi.fn() }));
vi.mock("../../../api/src/lib/customDomains", () => ({
  releaseCustomDomain: vi.fn(),
  removeCustomDomain: vi.fn(),
}));

import { projectsRouter, buildProjectDetails, type ProjectDetailRow } from "./projects";
import { writeAdminAudit } from "../audit";
import { releaseCustomDomain } from "../../../api/src/lib/customDomains";

const BASE_ROW: ProjectDetailRow = {
  id: "proj_1",
  name: "Acme Docs",
  description: null,
  owner_id: "user_1",
  created_at: "2024-01-01T00:00:00.000Z",
  published_at: null,
  changelog_mode: "off",
  home_doc_id: null,
  vanity_slug: null,
  logo_square_updated_at: null,
  logo_wide_updated_at: null,
  features: 0,
  ai_enabled: 0,
  ai_summarization_type: "manual",
  graph_enabled: 0,
  published_graph_enabled: 0,
  organization_id: null,
  organization_name: null,
};

// An empty project: every aggregate sub-query returns NULL sums / no rows.
function buildEmpty(row: ProjectDetailRow = BASE_ROW) {
  return buildProjectDetails({
    project: row,
    owner: null,
    customDomain: null,
    docStats: { total: 0, published: null },
    aiSummaries: { n: 0 },
    folderCount: { n: 0 },
    fileStats: { n: 0, bytes: 0 },
    memberCounts: { accepted: null, pending: null },
    byRole: [],
    members: [],
  });
}

describe("buildProjectDetails - published flag", () => {
  it("is a draft when published_at is null", () => {
    expect(buildEmpty().profile.published).toBe(false);
  });
  it("is published when published_at is set", () => {
    const d = buildEmpty({ ...BASE_ROW, published_at: "2024-02-02T00:00:00.000Z" });
    expect(d.profile.published).toBe(true);
    expect(d.profile.published_at).toBe("2024-02-02T00:00:00.000Z");
  });
});

describe("buildProjectDetails - content stats", () => {
  it("coalesces NULL aggregates to zero for an empty project", () => {
    const d = buildEmpty();
    expect(d.content.docs).toEqual({ total: 0, published: 0, drafts: 0, with_ai_summary: 0 });
    expect(d.content.folders).toBe(0);
    expect(d.content.files).toEqual({ count: 0, total_bytes: 0 });
    expect(d.members.accepted).toBe(0);
    expect(d.members.pending).toBe(0);
  });

  it("derives drafts as total minus published", () => {
    const d = buildProjectDetails({
      project: BASE_ROW,
      owner: null,
      customDomain: null,
      docStats: { total: 10, published: 4 },
      aiSummaries: { n: 3 },
      folderCount: { n: 2 },
      fileStats: { n: 5, bytes: 2048 },
      memberCounts: { accepted: 2, pending: 1 },
      byRole: [{ role: "owner", count: 1 }, { role: "editor", count: 1 }],
      members: [],
    });
    expect(d.content.docs).toEqual({ total: 10, published: 4, drafts: 6, with_ai_summary: 3 });
    expect(d.content.files).toEqual({ count: 5, total_bytes: 2048 });
    expect(d.members).toMatchObject({ accepted: 2, pending: 1 });
  });
});

describe("buildProjectDetails - ownership & organization", () => {
  it("returns a null owner when the account is gone", () => {
    expect(buildEmpty().profile.owner).toBeNull();
  });
  it("passes through the resolved owner identity", () => {
    const d = buildProjectDetails({
      ...emptyInputs(),
      owner: { id: "user_1", name: "Ada", email: "ada@example.com" },
    });
    expect(d.profile.owner).toEqual({ id: "user_1", name: "Ada", email: "ada@example.com" });
  });
  it("is standalone with no organization", () => {
    expect(buildEmpty().organization).toBeNull();
  });
  it("reports the organization the site belongs to", () => {
    const d = buildEmpty({ ...BASE_ROW, organization_id: "org_9", organization_name: "Globex" });
    expect(d.organization).toEqual({ id: "org_9", name: "Globex" });
  });
});

describe("buildProjectDetails - settings booleans", () => {
  it("maps the 0/1 integer toggles to booleans", () => {
    const d = buildEmpty({
      ...BASE_ROW,
      features: 5,
      ai_enabled: 1,
      ai_summarization_type: "automatic",
      graph_enabled: 1,
      published_graph_enabled: 0,
    });
    expect(d.settings).toEqual({
      features: 5,
      ai_enabled: true,
      ai_summarization_type: "automatic",
      graph_enabled: true,
      published_graph_enabled: false,
    });
  });
});

describe("buildProjectDetails - members", () => {
  it("maps the accepted integer flag to a boolean per member", () => {
    const d = buildProjectDetails({
      ...emptyInputs(),
      members: [
        { id: "m1", user_id: "u1", email: "o@x.com", name: "Owner", role: "owner", accepted: 1, created_at: "2024-01-01T00:00:00.000Z" },
        { id: "m2", user_id: "u2", email: "p@x.com", name: "Pending", role: "viewer", accepted: 0, created_at: "2024-01-02T00:00:00.000Z" },
      ],
    });
    expect(d.members.list).toEqual([
      { id: "m1", user_id: "u1", email: "o@x.com", name: "Owner", role: "owner", accepted: true, created_at: "2024-01-01T00:00:00.000Z" },
      { id: "m2", user_id: "u2", email: "p@x.com", name: "Pending", role: "viewer", accepted: false, created_at: "2024-01-02T00:00:00.000Z" },
    ]);
  });
});

describe("buildProjectDetails - branding", () => {
  it("surfaces the mapped custom domain", () => {
    const d = buildProjectDetails({
      ...emptyInputs(),
      project: { ...BASE_ROW, vanity_slug: "acme" },
      customDomain: { hostname: "docs.acme.com", status: "active" },
    });
    expect(d.branding.vanity_slug).toBe("acme");
    expect(d.branding.custom_domain).toEqual({ hostname: "docs.acme.com", status: "active" });
  });
  it("has no custom domain when unmapped", () => {
    expect(buildEmpty().branding.custom_domain).toBeNull();
  });
});

// Shared zeroed inputs so individual tests only override the field under test.
function emptyInputs() {
  return {
    project: BASE_ROW,
    owner: null,
    customDomain: null,
    docStats: { total: 0, published: null },
    aiSummaries: { n: 0 },
    folderCount: { n: 0 },
    fileStats: { n: 0, bytes: 0 },
    memberCounts: { accepted: null, pending: null },
    byRole: [] as Array<{ role: string; count: number }>,
    members: [] as Parameters<typeof buildProjectDetails>[0]["members"],
  };
}

// ---------------------------------------------------------------------------
// Router handler tests (queue-based D1 mock + captured SQL/binds, per the
// repo's admin test pattern - see oauth.test.ts).
// ---------------------------------------------------------------------------

const session = { userId: "admin-1", email: "admin@example.com" };

interface PreparedCall {
  sql: string;
  binds: unknown[];
}

function makeDb() {
  const firstQueue: unknown[] = [];
  const allQueue: unknown[][] = [];
  const calls: PreparedCall[] = [];
  const batches: PreparedCall[][] = [];

  function makeStmt(sql: string) {
    const call: PreparedCall = { sql, binds: [] };
    const stmt = {
      __call: call,
      bind: (...args: unknown[]) => {
        call.binds = args;
        return stmt;
      },
      first: async () => {
        calls.push(call);
        return firstQueue.shift() ?? null;
      },
      all: async () => {
        calls.push(call);
        return { results: allQueue.shift() ?? [] };
      },
      run: async () => {
        calls.push(call);
        return { meta: { changes: 1 } };
      },
    };
    return stmt;
  }

  const db = {
    prepare: vi.fn((sql: string) => makeStmt(sql)),
    batch: vi.fn(async (stmts: Array<{ __call: PreparedCall }>) => {
      batches.push(stmts.map(s => s.__call));
      return stmts.map(() => ({ results: [] }));
    }),
  };
  return { db, firstQueue, allQueue, calls, batches };
}

interface R2Mock {
  listPages: Array<{ objects: Array<{ key: string }>; truncated: boolean; cursor?: string }>;
  deletes: Array<string | string[]>;
  list: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
}

function makeR2(): R2Mock {
  const mock: R2Mock = {
    listPages: [],
    deletes: [],
    list: vi.fn(async () => mock.listPages.shift() ?? { objects: [], truncated: false }),
    delete: vi.fn(async (keys: string | string[]) => {
      mock.deletes.push(keys);
    }),
    get: vi.fn(async () => null),
  };
  return mock;
}
let r2: R2Mock;

function makeApp(env: Record<string, unknown>) {
  const app = new Hono<{ Variables: Record<string, unknown> }>();
  app.use("*", async (c, next) => {
    c.set("session", session);
    await next();
  });
  app.route("/", projectsRouter);
  return (path: string, init?: RequestInit) => app.request(path, init, env as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  r2 = makeR2();
});

describe("DELETE /:id - scale safety (AB-H1)", () => {
  it("deletes a 150-doc project with chunked SQL and a prefix sweep", async () => {
    const { db, firstQueue, allQueue, calls, batches } = makeDb();
    const docIds = Array.from({ length: 150 }, (_, i) => ({ id: `doc-${i}` }));
    const files = Array.from({ length: 3 }, (_, i) => ({ id: `file-${i}` }));
    firstQueue.push({ id: "proj-1" }); // existence check
    allQueue.push(docIds, files);
    // Two R2 list pages so the sweep pagination is exercised too.
    r2.listPages.push(
      { objects: docIds.slice(0, 100).map(d => ({ key: `proj-1/${d.id}` })), truncated: true, cursor: "c1" },
      { objects: docIds.slice(100).map(d => ({ key: `proj-1/${d.id}` })), truncated: false },
    );

    const request = makeApp({ DB: db, ASSETS: r2 });
    const res = await request("/proj-1", { method: "DELETE" });
    expect(res.status).toBe(200);

    // Prefix sweep: list + array delete, not one delete per doc row.
    expect(r2.list).toHaveBeenCalledTimes(2);
    // 2 sweep pages + 1 batched delete of files + logos.
    expect(r2.deletes.length).toBe(3);
    expect(r2.deletes[2]).toEqual([
      "files/file-0", "files/file-1", "files/file-2",
      "site-logos/proj-1-square", "site-logos/proj-1-wide",
    ]);

    // 150 docs -> three 50-id chunks of (asset_revisions + doc_shares), then
    // the final fts+projects batch.
    expect(batches.length).toBe(4);
    for (const batch of batches.slice(0, 3)) {
      expect(batch[0].sql).toContain("asset_revisions");
      expect(batch[1].sql).toContain("doc_shares");
      // The whole point: never more than 50 bound params per statement.
      expect(batch[0].binds.length).toBeLessThanOrEqual(50);
      expect(batch[1].binds.length).toBeLessThanOrEqual(50);
    }
    const chunkBinds = batches.slice(0, 3).flatMap(b => b[0].binds);
    expect(chunkBinds).toEqual(docIds.map(d => d.id));

    const finalBatch = batches[3];
    expect(finalBatch[0].sql).toContain("docs_fts");
    expect(finalBatch[1].sql).toContain("DELETE FROM projects");
    expect(finalBatch[1].binds).toEqual(["proj-1"]);

    expect(releaseCustomDomain).toHaveBeenCalledWith(expect.anything(), "proj-1");
    expect(writeAdminAudit).toHaveBeenCalledTimes(1);
    expect(writeAdminAudit).toHaveBeenCalledWith(
      expect.anything(), session, "project.delete", "project", "proj-1", { docs: 150, files: 3 },
    );
    // Existence check ran against the projects table first.
    expect(calls[0].sql).toContain("FROM projects");
  });

  it("404s (and writes NO audit row) for a nonexistent project", async () => {
    const { db, firstQueue } = makeDb();
    firstQueue.push(null);
    const request = makeApp({ DB: db, ASSETS: r2 });
    const res = await request("/ghost", { method: "DELETE" });
    expect(res.status).toBe(404);
    expect(writeAdminAudit).not.toHaveBeenCalled();
    expect(r2.delete).not.toHaveBeenCalled();
  });
});

describe("PATCH /:id/features (AB-M4 + bounds)", () => {
  async function patchFeatures(env: Record<string, unknown>, id: string, features: unknown) {
    const request = makeApp(env);
    return request(`/${id}/features`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ features }),
    });
  }

  it("404s (no audit) when the project does not exist", async () => {
    const { db, firstQueue } = makeDb();
    firstQueue.push(null);
    const res = await patchFeatures({ DB: db }, "ghost", 3);
    expect(res.status).toBe(404);
    expect(writeAdminAudit).not.toHaveBeenCalled();
  });

  it("updates + audits exactly once for a real project", async () => {
    const { db, firstQueue, calls } = makeDb();
    firstQueue.push({ id: "proj-1" });
    const res = await patchFeatures({ DB: db }, "proj-1", 5);
    expect(res.status).toBe(200);
    const update = calls.find(c => c.sql.includes("UPDATE projects"));
    expect(update?.binds).toEqual([5, "proj-1"]);
    expect(writeAdminAudit).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["negative", -1],
    ["above the known bits", 8],
    ["past int32 (would coerce through a mask-only check)", 2 ** 32 + 3],
    ["non-integer", 1.5],
    ["missing", undefined],
  ])("rejects %s feature values with 400", async (_label, features) => {
    const { db } = makeDb();
    const res = await patchFeatures({ DB: db }, "proj-1", features);
    expect(res.status).toBe(400);
    expect(writeAdminAudit).not.toHaveBeenCalled();
  });
});

describe("POST /:id/reindex (AB-H2)", () => {
  it("refuses projects over the doc cap with 409 instead of dying mid-loop", async () => {
    const { db, firstQueue, allQueue } = makeDb();
    firstQueue.push({ id: "proj-1" });
    allQueue.push(Array.from({ length: 401 }, (_, i) => ({ id: `d${i}`, title: `t${i}` })));
    const request = makeApp({ DB: db, ASSETS: r2 });
    const res = await request("/proj-1/reindex", { method: "POST" });
    expect(res.status).toBe(409);
    expect(writeAdminAudit).not.toHaveBeenCalled();
  });

  it("reindexes a small project and audits after success", async () => {
    const { db, firstQueue, allQueue } = makeDb();
    firstQueue.push({ id: "proj-1" });
    allQueue.push([{ id: "d1", title: "One" }, { id: "d2", title: "Two" }]);
    const request = makeApp({ DB: db, ASSETS: r2 });
    const res = await request("/proj-1/reindex", { method: "POST" });
    expect(res.status).toBe(200);
    expect(writeAdminAudit).toHaveBeenCalledWith(
      expect.anything(), session, "project.reindex", "project", "proj-1", { indexed: 2 },
    );
  });
});

describe("GET / - LIKE escaping", () => {
  it("escapes % and _ in the name filter and pairs it with ESCAPE", async () => {
    const { db, allQueue, calls } = makeDb();
    allQueue.push([]);
    const request = makeApp({ DB: db });
    const res = await request("/?q=50%25_off");
    expect(res.status).toBe(200);
    const listCall = calls.find(c => c.sql.includes("LIKE"));
    expect(listCall?.sql).toContain("ESCAPE");
    expect(listCall?.binds[0]).toBe("%50\\%\\_off%");
  });
});
