import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

vi.mock("../audit", () => ({ writeAdminAudit: vi.fn() }));

import { reportsRouter } from "./reports";
import { writeAdminAudit } from "../audit";
import { encodeCursor } from "../lib/cursor";

const session = { userId: "admin-1", email: "admin@example.com" };

interface PreparedCall {
  sql: string;
  binds: unknown[];
}

function makeDb() {
  const firstQueue: unknown[] = [];
  const allQueue: unknown[][] = [];
  const calls: PreparedCall[] = [];

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

  const db = { prepare: vi.fn((sql: string) => makeStmt(sql)) };
  return { db, firstQueue, allQueue, calls };
}

function siteReport(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "rep-1",
    project_id: "proj-1",
    project_name: "Acme Docs",
    reporter_user_id: null,
    reporter_ip: "203.0.113.9",
    doc_id: null,
    doc_title: null,
    note: "spam",
    status: "open",
    created_at: "2026-07-01T00:00:00.000Z",
    status_changed_at: null,
    status_changed_by: null,
    ...overrides,
  };
}

function userReport(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "urep-1",
    reported_user_id: "user-bad",
    reporter_user_id: "user-good",
    reporter_ip: "203.0.113.9",
    note: "harassment",
    status: "open",
    created_at: "2026-07-01T00:00:00.000Z",
    status_changed_at: null,
    status_changed_by: null,
    ...overrides,
  };
}

function makeApp(env: Record<string, unknown>) {
  const app = new Hono<{ Variables: Record<string, unknown> }>();
  app.use("*", async (c, next) => {
    c.set("session", session);
    await next();
  });
  app.route("/", reportsRouter);
  return (path: string, init?: RequestInit) => app.request(path, init, env as never);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /sites (list site reports)", () => {
  it("defaults to the current queue (open + acknowledged), newest first", async () => {
    const { db, allQueue, calls } = makeDb();
    allQueue.push([siteReport()]);
    const authDb = makeDb().db;

    const request = makeApp({ DB: db, AUTH_DB: authDb });
    const res = await request("/sites");
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; data: { reports: unknown[]; nextCursor: string | null } };
    expect(body.ok).toBe(true);
    expect(body.data.reports).toHaveLength(1);
    expect(body.data.nextCursor).toBeNull();

    expect(calls[0].sql).toContain("FROM site_reports");
    expect(calls[0].sql).toContain("r.status IN ('open', 'acknowledged')");
    expect(calls[0].sql).toContain("ORDER BY r.created_at DESC, r.id DESC");
    // Anonymous report -> no auth-DB lookup fired.
    expect(authDb.prepare).not.toHaveBeenCalled();
  });

  it("resolves reporter identity from the auth DB for attributed reports", async () => {
    const { db, allQueue } = makeDb();
    allQueue.push([siteReport({ reporter_user_id: "user-9" })]);
    const auth = makeDb();
    auth.allQueue.push([{ id: "user-9", email: "u@example.com", name: "Uma" }]);

    const request = makeApp({ DB: db, AUTH_DB: auth.db });
    const res = await request("/sites");
    const body = await res.json() as { data: { reports: Array<{ reporter: unknown }> } };
    expect(body.data.reports[0].reporter).toEqual({ email: "u@example.com", name: "Uma" });
    expect(auth.calls[0].binds).toEqual(["user-9"]);
  });

  it("filters by a concrete status and by projectId", async () => {
    const { db, allQueue, calls } = makeDb();
    allQueue.push([]);
    const request = makeApp({ DB: db, AUTH_DB: makeDb().db });
    const res = await request("/sites?status=resolved&projectId=proj-1");
    expect(res.status).toBe(200);
    expect(calls[0].sql).toContain("r.status = ?");
    expect(calls[0].sql).toContain("r.project_id = ?");
    expect(calls[0].binds.slice(0, 2)).toEqual(["resolved", "proj-1"]);
  });

  it("rejects an unknown status filter", async () => {
    const { db } = makeDb();
    const request = makeApp({ DB: db, AUTH_DB: makeDb().db });
    const res = await request("/sites?status=bogus");
    expect(res.status).toBe(400);
  });

  it("rejects an invalid cursor and pages with a valid one", async () => {
    const { db, allQueue, calls } = makeDb();
    allQueue.push([]);
    const request = makeApp({ DB: db, AUTH_DB: makeDb().db });

    expect((await request("/sites?cursor=garbage")).status).toBe(400);

    const cursor = encodeCursor({ ts: "2026-07-01T00:00:00.000Z", id: "rep-9" });
    expect((await request(`/sites?cursor=${encodeURIComponent(cursor)}`)).status).toBe(200);
    expect(calls[0].binds).toContain("rep-9");
  });

  it("returns a nextCursor when a page overflows", async () => {
    const { db, allQueue } = makeDb();
    // 26 rows -> 25 returned + cursor pointing at the 25th.
    allQueue.push(Array.from({ length: 26 }, (_, i) => siteReport({ id: `rep-${i}` })));
    const request = makeApp({ DB: db, AUTH_DB: makeDb().db });
    const body = await (await request("/sites")).json() as { data: { reports: unknown[]; nextCursor: string | null } };
    expect(body.data.reports).toHaveLength(25);
    expect(body.data.nextCursor).not.toBeNull();
  });
});

describe("GET /users (list user reports)", () => {
  it("resolves both the reported and reporting users' identities", async () => {
    const { db, allQueue, calls } = makeDb();
    allQueue.push([userReport()]);
    const auth = makeDb();
    auth.allQueue.push([
      { id: "user-bad", email: "bad@example.com", name: "Bad Actor" },
      { id: "user-good", email: "good@example.com", name: "Good Citizen" },
    ]);

    const request = makeApp({ DB: db, AUTH_DB: auth.db });
    const res = await request("/users");
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { reports: Array<{ reported: unknown; reporter: unknown }> } };
    expect(body.data.reports[0].reported).toEqual({ email: "bad@example.com", name: "Bad Actor" });
    expect(body.data.reports[0].reporter).toEqual({ email: "good@example.com", name: "Good Citizen" });

    expect(calls[0].sql).toContain("FROM user_reports");
    expect(calls[0].sql).toContain("r.status IN ('open', 'acknowledged')");
    // Both ids resolved in one chunk.
    expect(auth.calls[0].binds).toEqual(["user-bad", "user-good"]);
  });

  it("filters to reports against one user via userId", async () => {
    const { db, allQueue, calls } = makeDb();
    allQueue.push([]);
    const request = makeApp({ DB: db, AUTH_DB: makeDb().db });
    const res = await request("/users?userId=user-bad");
    expect(res.status).toBe(200);
    expect(calls[0].sql).toContain("r.reported_user_id = ?");
    expect(calls[0].binds[0]).toBe("user-bad");
  });

  it("leaves identities null for deleted accounts", async () => {
    const { db, allQueue } = makeDb();
    allQueue.push([userReport()]);
    const auth = makeDb();
    auth.allQueue.push([]); // neither user found

    const request = makeApp({ DB: db, AUTH_DB: auth.db });
    const body = await (await request("/users")).json() as { data: { reports: Array<{ reported: unknown; reporter: unknown }> } };
    expect(body.data.reports[0].reported).toBeNull();
    expect(body.data.reports[0].reporter).toBeNull();
  });
});

describe("PATCH /sites/:id and /users/:id (triage)", () => {
  it("acknowledges an open site report and audits the transition with its target", async () => {
    const { db, firstQueue, calls } = makeDb();
    firstQueue.push({ id: "rep-1", status: "open", target: "proj-1" });

    const request = makeApp({ DB: db, AUTH_DB: makeDb().db });
    const res = await request("/sites/rep-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "acknowledged" }),
    });
    expect(res.status).toBe(200);

    expect(calls[0].sql).toContain("FROM site_reports");
    expect(calls[0].sql).toContain("project_id AS target");
    const update = calls.find(c => c.sql.includes("UPDATE site_reports"));
    expect(update).toBeDefined();
    expect(update!.sql).toContain("status_changed_by = ?");
    expect(update!.binds).toEqual(["acknowledged", "admin-1", "rep-1"]);
    expect(writeAdminAudit).toHaveBeenCalledWith(
      expect.anything(), session, "report.status.update", "report", "rep-1",
      { kind: "site", target: "proj-1", from: "open", to: "acknowledged" },
    );
  });

  it("resolves a user report against the user_reports table", async () => {
    const { db, firstQueue, calls } = makeDb();
    firstQueue.push({ id: "urep-1", status: "acknowledged", target: "user-bad" });

    const request = makeApp({ DB: db, AUTH_DB: makeDb().db });
    const res = await request("/users/urep-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "resolved" }),
    });
    expect(res.status).toBe(200);

    const update = calls.find(c => c.sql.includes("UPDATE user_reports"));
    expect(update).toBeDefined();
    expect(update!.binds).toEqual(["resolved", "admin-1", "urep-1"]);
    expect(writeAdminAudit).toHaveBeenCalledWith(
      expect.anything(), session, "report.status.update", "report", "urep-1",
      { kind: "user", target: "user-bad", from: "acknowledged", to: "resolved" },
    );
  });

  it("404s on an unknown report id without auditing", async () => {
    const { db } = makeDb();
    const request = makeApp({ DB: db, AUTH_DB: makeDb().db });
    const res = await request("/sites/rep-missing", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "resolved" }),
    });
    expect(res.status).toBe(404);
    expect(writeAdminAudit).not.toHaveBeenCalled();
  });

  it("rejects an invalid target status", async () => {
    const { db, calls } = makeDb();
    const request = makeApp({ DB: db, AUTH_DB: makeDb().db });
    const res = await request("/users/urep-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "deleted" }),
    });
    expect(res.status).toBe(400);
    expect(calls.length).toBe(0);
  });
});
