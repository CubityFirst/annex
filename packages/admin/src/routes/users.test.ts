import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { fileURLToPath } from "node:url";
import { createSqliteD1 } from "../../../api/src/test/sqliteD1";

const AUTH_MIGRATIONS = fileURLToPath(new URL("../../../auth/migrations", import.meta.url));

vi.mock("../audit", () => ({ writeAdminAudit: vi.fn() }));

import {
  usersRouter,
  getModerationAction,
  getCurrentStatus,
  buildBillingDetails,
  buildUserStatusClause,
  buildUserSearchQuery,
  exactUserMatch,
  type BillingRow,
} from "./users";
import { writeAdminAudit } from "../audit";

const EMPTY_BILLING: BillingRow = {
  stripe_customer_id: null,
  stripe_subscription_id: null,
  personal_plan: null,
  personal_plan_status: null,
  personal_plan_started_at: null,
  personal_plan_cancel_at: null,
  personal_plan_style: null,
  personal_presence_color: null,
  personal_crit_sparkles: null,
  granted_plan: null,
  granted_plan_expires_at: null,
  granted_plan_started_at: null,
  granted_plan_reason: null,
};

describe("getModerationAction", () => {
  it("maps 0 to re_enabled", () => {
    expect(getModerationAction(0)).toBe("re_enabled");
  });
  it("maps -1 to disabled", () => {
    expect(getModerationAction(-1)).toBe("disabled");
  });
  it("maps a future timestamp to suspended", () => {
    expect(getModerationAction(Math.floor(Date.now() / 1000) + 3600)).toBe("suspended");
  });
});

describe("getCurrentStatus", () => {
  it("is disabled for -1", () => {
    expect(getCurrentStatus(-1)).toBe("disabled");
  });
  it("is suspended while the suspension is in the future", () => {
    expect(getCurrentStatus(Math.floor(Date.now() / 1000) + 3600)).toBe("suspended");
  });
  it("is active once a past suspension has elapsed", () => {
    expect(getCurrentStatus(Math.floor(Date.now() / 1000) - 3600)).toBe("active");
  });
  it("is active for 0", () => {
    expect(getCurrentStatus(0)).toBe("active");
  });
});

describe("buildUserStatusClause", () => {
  const NOW = 1_700_000_000;

  it("returns an empty clause for null status", () => {
    expect(buildUserStatusClause(null, NOW)).toEqual({ sql: "", binds: [] });
  });

  it("returns an empty clause for an empty or unknown status", () => {
    expect(buildUserStatusClause("", NOW)).toEqual({ sql: "", binds: [] });
    expect(buildUserStatusClause("bogus", NOW)).toEqual({ sql: "", binds: [] });
  });

  it("partitions users by moderation state when run against the real schema", () => {
    // Evaluate each predicate in real SQLite: whether an elapsed suspension
    // counts as active (and not suspended) only shows up when the SQL runs.
    const { sqlite } = createSqliteD1(AUTH_MIGRATIONS);
    const add = sqlite.prepare("INSERT INTO users (id, email, name, password_hash, created_at, moderation) VALUES (?, ?, 'U', 'x', datetime('now'), ?)");
    add.run("active", "a@x.com", 0);
    add.run("disabled", "d@x.com", -1);
    add.run("suspended", "s@x.com", NOW + 3600);
    add.run("suspension-elapsed", "e@x.com", NOW - 3600);
    const matching = (status: string) => {
      const { sql, binds } = buildUserStatusClause(status, NOW);
      return sqlite.prepare(`SELECT id FROM users u WHERE ${sql} ORDER BY id`).all(...binds).map(r => r.id);
    };
    expect(matching("active")).toEqual(["active", "suspension-elapsed"]);
    expect(matching("disabled")).toEqual(["disabled"]);
    expect(matching("suspended")).toEqual(["suspended"]);
  });
});

describe("buildBillingDetails", () => {
  it("resolves a row with no billing/grant to the free plan", () => {
    const d = buildBillingDetails(EMPTY_BILLING);
    expect(d.resolved_plan).toBe("free");
    expect(d.via).toBe("free");
    expect(d.granted).toBeNull();
    expect(d.stripe).toEqual({ customer_id: null, subscription_id: null });
  });

  it("treats an active manual grant as granted ink", () => {
    const d = buildBillingDetails({
      ...EMPTY_BILLING,
      granted_plan: "ink",
      granted_plan_started_at: Date.now() - 1000,
      granted_plan_reason: "comp",
    });
    expect(d.resolved_plan).toBe("ink");
    expect(d.via).toBe("granted");
    expect(d.granted).toEqual({ plan: "ink", expires_at: null, reason: "comp" });
  });

  it("passes through stripe identifiers", () => {
    const d = buildBillingDetails({
      ...EMPTY_BILLING,
      stripe_customer_id: "cus_123",
      stripe_subscription_id: "sub_456",
    });
    expect(d.stripe).toEqual({ customer_id: "cus_123", subscription_id: "sub_456" });
  });
});

// ---------------------------------------------------------------------------
// Router handler tests (queue-based D1 mock, per the admin test pattern).
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
  // meta.changes reported by each successive batch (default 1) - lets a test
  // simulate a guarded write that matched nothing.
  const batchChanges: number[] = [];

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

  return {
    firstQueue,
    allQueue,
    calls,
    batches,
    batchChanges,
    prepare: vi.fn((sql: string) => makeStmt(sql)),
    batch: vi.fn(async (stmts: Array<{ __call: PreparedCall }>) => {
      batches.push(stmts.map(s => s.__call));
      const changes = batchChanges.shift() ?? 1;
      return stmts.map(() => ({ results: [], meta: { changes } }));
    }),
  };
}

function makeUsersApp(env: Record<string, unknown>) {
  const app = new Hono<{ Variables: Record<string, unknown> }>();
  app.use("*", async (c, next) => {
    c.set("session", session);
    await next();
  });
  app.route("/", usersRouter);
  return (path: string, init?: RequestInit) => app.request(path, init, env as never);
}

function makeEnv() {
  return {
    AUTH_DB: makeDb(),
    DB: makeDb(),
    ASSETS: { delete: vi.fn(async () => undefined), get: vi.fn(async () => null) },
    STRIPE_SECRET_KEY: "sk_test_x",
  };
}

const realFetch = globalThis.fetch;
beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("audit emission - every mutation writes exactly one row, none on 404 (AB-M4 doctrine)", () => {
  // [label, seed existing user into AUTH_DB.firstQueue?, request]
  const MUTATIONS: Array<[string, (env: ReturnType<typeof makeEnv>) => void, string, RequestInit]> = [
    [
      "PATCH /:id (moderation)",
      env => env.AUTH_DB.firstQueue.push({ "1": 1 }),
      "/u-1",
      { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ moderation: -1, reason: "spam" }) },
    ],
    [
      "PATCH /:id/badges",
      env => env.AUTH_DB.firstQueue.push({ "1": 1 }),
      "/u-1/badges",
      { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ badges: 1 }) },
    ],
    [
      "PATCH /:id/handle",
      env => env.AUTH_DB.firstQueue.push({ id: "u-1", handle: null, handle_locked: 0 }),
      "/u-1/handle",
      { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ handle: null, locked: true }) },
    ],
    [
      "POST /:id/force-password-change",
      env => env.AUTH_DB.firstQueue.push({ "1": 1 }),
      "/u-1/force-password-change",
      { method: "POST" },
    ],
    [
      "DELETE /:id/avatar",
      env => env.AUTH_DB.firstQueue.push({ "1": 1 }),
      "/u-1/avatar",
      { method: "DELETE" },
    ],
    [
      "POST /:id/grant-ink",
      env => env.AUTH_DB.firstQueue.push({ "1": 1 }),
      "/u-1/grant-ink",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason: "vip" }) },
    ],
    [
      "DELETE /:id/grant-ink",
      env => env.AUTH_DB.firstQueue.push({ "1": 1 }),
      "/u-1/grant-ink",
      { method: "DELETE" },
    ],
    [
      "POST /:id/resync-name",
      env => env.AUTH_DB.firstQueue.push({ name: "Real Name" }),
      "/u-1/resync-name",
      { method: "POST" },
    ],
  ];

  it.each(MUTATIONS)("%s: success -> exactly one audit row", async (_label, seed, path, init) => {
    const env = makeEnv();
    seed(env);
    const request = makeUsersApp(env);
    const res = await request(path, init);
    expect(res.status).toBe(200);
    expect(writeAdminAudit).toHaveBeenCalledTimes(1);
  });

  it.each(MUTATIONS)("%s: unknown user -> 404 and NO audit row", async (_label, _seed, path, init) => {
    const env = makeEnv();
    // firstQueue left empty -> existence check returns null.
    const request = makeUsersApp(env);
    const res = await request(path, init);
    expect(res.status).toBe(404);
    expect(writeAdminAudit).not.toHaveBeenCalled();
  });
});

describe("POST /:id/resync-name", () => {
  it("rewrites both membership tables from the canonical users.name", async () => {
    const env = makeEnv();
    env.AUTH_DB.firstQueue.push({ name: "Real Name" });
    const request = makeUsersApp(env);
    const res = await request("/u-1/resync-name", { method: "POST" });
    expect(res.status).toBe(200);
    const batch = env.DB.batches[0];
    expect(batch).toHaveLength(2);
    expect(batch[0].sql).toContain("UPDATE project_members SET name = ?");
    // The guard bind (name <> ?) keeps the reported changes count to rows
    // that were actually wrong.
    expect(batch[0].binds).toEqual(["Real Name", "u-1", "Real Name"]);
    expect(batch[1].sql).toContain("UPDATE organization_members SET name = ?");
    expect(batch[1].binds).toEqual(["Real Name", "u-1", "Real Name"]);
  });
});

describe("PATCH /:id/badges - int32 coercion bound", () => {
  it("rejects 2^32 + allowed (which passes a mask-only check via ToInt32)", async () => {
    const env = makeEnv();
    env.AUTH_DB.firstQueue.push({ "1": 1 });
    const request = makeUsersApp(env);
    const res = await request("/u-1/badges", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ badges: 2 ** 32 + 1 }),
    });
    expect(res.status).toBe(400);
    expect(writeAdminAudit).not.toHaveBeenCalled();
  });
});

describe("POST /:id/gift-month - Stripe idempotency (AB-M3)", () => {
  it("sends an Idempotency-Key scoped to (admin, user, billing period)", async () => {
    const env = makeEnv();
    env.AUTH_DB.firstQueue.push({ stripe_customer_id: "cus_1", stripe_subscription_id: "sub_1" });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({
        cancel_at_period_end: false,
        current_period_end: 1_700_000_000,
        items: { data: [{ price: { unit_amount: 500, currency: "usd" } }] },
      }))
      .mockResolvedValueOnce(Response.json({ id: "cbtxn_1" }));
    globalThis.fetch = fetchMock as typeof fetch;

    const request = makeUsersApp(env);
    const res = await request("/u-1/gift-month", { method: "POST" });
    expect(res.status).toBe(200);

    const creditInit = fetchMock.mock.calls[1][1] as RequestInit;
    const headers = new Headers(creditInit.headers);
    expect(headers.get("Idempotency-Key")).toBe("gift-month:admin-1:u-1:1700000000");
    expect(writeAdminAudit).toHaveBeenCalledTimes(1);
  });

  it("does not audit when the Stripe credit fails", async () => {
    const env = makeEnv();
    env.AUTH_DB.firstQueue.push({ stripe_customer_id: "cus_1", stripe_subscription_id: "sub_1" });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({
        cancel_at_period_end: false,
        current_period_end: 1_700_000_000,
        items: { data: [{ price: { unit_amount: 500, currency: "usd" } }] },
      }))
      .mockResolvedValueOnce(new Response("stripe exploded", { status: 500 }));
    globalThis.fetch = fetchMock as typeof fetch;

    const request = makeUsersApp(env);
    const res = await request("/u-1/gift-month", { method: "POST" });
    expect(res.status).toBe(502);
    expect(writeAdminAudit).not.toHaveBeenCalled();
  });
});

describe("GET /search - LIKE escaping", () => {
  it("escapes wildcards in the email search and pairs with ESCAPE", async () => {
    const env = makeEnv();
    env.AUTH_DB.allQueue.push([]);
    const request = makeUsersApp(env);
    const res = await request("/search?q=a_b%25");
    expect(res.status).toBe(200);
    const call = env.AUTH_DB.calls.find(c => c.sql.includes("LIKE"));
    expect(call?.sql).toContain("ESCAPE");
    expect(call?.binds[0]).toBe("%a\\_b\\%%");
  });

  it("selects email_verified so the dashboard can render the indicator", async () => {
    const env = makeEnv();
    env.AUTH_DB.allQueue.push([]);
    const request = makeUsersApp(env);
    const res = await request("/search?q=");
    expect(res.status).toBe(200);
    const call = env.AUTH_DB.calls.find(c => c.sql.includes("FROM users"));
    expect(call?.sql).toContain("u.email_verified");
  });
});

describe("PATCH /:id - self-protection", () => {
  it("refuses to disable the caller's own account", async () => {
    const env = makeEnv();
    env.AUTH_DB.firstQueue.push({ "1": 1 });
    const res = await makeUsersApp(env)("/admin-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ moderation: -1, reason: "oops" }),
    });
    expect(res.status).toBe(400);
    expect(env.AUTH_DB.batch).not.toHaveBeenCalled();
    expect(writeAdminAudit).not.toHaveBeenCalled();
  });
});

describe("POST /delete-preview", () => {
  function post(request: ReturnType<typeof makeUsersApp>, ids: unknown) {
    return request("/delete-preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    });
  }

  it("groups owned sites/orgs per user and flags self + admins as blocked", async () => {
    const env = makeEnv();
    env.AUTH_DB.allQueue.push([
      { id: "u-1", email: "a@x.com", name: "A", is_admin: 0, stripe_customer_id: "cus_1", stripe_subscription_id: "sub_1" },
      { id: "u-2", email: "b@x.com", name: "B", is_admin: 1, stripe_customer_id: null, stripe_subscription_id: null },
      { id: "admin-1", email: "admin@example.com", name: "Me", is_admin: 1, stripe_customer_id: null, stripe_subscription_id: null },
      { id: "u-3", email: "c@x.com", name: "C", is_admin: 0, stripe_customer_id: null, stripe_subscription_id: null, scheduled: 1 },
    ]);
    env.DB.allQueue.push(
      [{ id: "p-1", name: "Site", owner_id: "u-1", published_at: "2026-01-01", docs: 12, other_members: 2 }],
      [{ id: "o-1", name: "Org", owner_id: "u-1", sites: 1, other_members: 0 }],
    );
    const request = makeUsersApp(env);
    const res = await post(request, ["admin-1", "u-1", "u-2", "u-3", "ghost"]);
    expect(res.status).toBe(200);
    const { data } = await res.json() as { data: { users: Array<Record<string, unknown>> } };
    // Selection order kept; unknown ids dropped.
    expect(data.users.map(u => u.id)).toEqual(["admin-1", "u-1", "u-2", "u-3"]);
    expect(data.users[0].blocked).toBe("self");
    expect(data.users[2].blocked).toBe("admin");
    expect(data.users[3].blocked).toBe("scheduled");
    expect(data.users[1]).toMatchObject({
      blocked: null,
      has_stripe_customer: true,
      has_subscription: true,
      owned_sites: [{ id: "p-1", name: "Site", docs: 12, other_members: 2, published: true }],
      owned_orgs: [{ id: "o-1", name: "Org", sites: 1, other_members: 0 }],
    });
    expect(writeAdminAudit).not.toHaveBeenCalled();
  });

  it("rejects an empty or oversized selection", async () => {
    const request = makeUsersApp(makeEnv());
    expect((await post(request, [])).status).toBe(400);
    expect((await post(request, Array.from({ length: 51 }, (_, i) => `u-${i}`))).status).toBe(400);
  });
});

describe("POST /:id/deletion - schedule (never deletes)", () => {
  function schedule(env: ReturnType<typeof makeEnv>, id: string, body: Record<string, unknown> = {}) {
    return makeUsersApp(env)(`/${id}/deletion`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }
  const scheduled = (env: ReturnType<typeof makeEnv>) =>
    env.AUTH_DB.batches.some(b => b.some(c => c.sql.includes("INSERT INTO user_deletions")));
  const destructive = (env: ReturnType<typeof makeEnv>) =>
    [...env.AUTH_DB.calls, ...env.DB.calls, ...env.AUTH_DB.batches.flat(), ...env.DB.batches.flat()]
      .some(c => /DELETE FROM (users|projects|organizations|project_members)/.test(c.sql));

  it("refuses the caller's own account", async () => {
    const env = makeEnv();
    expect((await schedule(env, "admin-1")).status).toBe(400);
    expect(scheduled(env)).toBe(false);
  });

  it("404s an unknown user and refuses admins / already-scheduled accounts", async () => {
    let env = makeEnv();
    expect((await schedule(env, "ghost")).status).toBe(404);
    env = makeEnv();
    env.AUTH_DB.firstQueue.push({ id: "u-1", email: "a@x.com", is_admin: 1, moderation: 0, scheduled: 0 });
    expect((await schedule(env, "u-1")).status).toBe(409);
    env = makeEnv();
    env.AUTH_DB.firstQueue.push({ id: "u-1", email: "a@x.com", is_admin: 0, moderation: 0, scheduled: 1 });
    expect((await schedule(env, "u-1")).status).toBe(409);
    expect(scheduled(env)).toBe(false);
    expect(writeAdminAudit).not.toHaveBeenCalled();
  });

  it("refuses when owned sites weren't confirmed", async () => {
    const env = makeEnv();
    env.AUTH_DB.firstQueue.push({ id: "u-1", email: "a@x.com", is_admin: 0, moderation: 0, scheduled: 0 });
    env.DB.allQueue.push([{ id: "p-1", name: "Site" }], []);
    const res = await schedule(env, "u-1");
    expect(res.status).toBe(409);
    expect(scheduled(env)).toBe(false);
  });

  it("refuses a confirmed set that doesn't match (extra or foreign site id)", async () => {
    const env = makeEnv();
    env.AUTH_DB.firstQueue.push({ id: "u-1", email: "a@x.com", is_admin: 0, moderation: 0, scheduled: 0 });
    env.DB.allQueue.push([{ id: "p-1", name: "Site" }], []);
    const res = await schedule(env, "u-1", { confirm_site_ids: ["p-1", "someone-elses-site"] });
    expect(res.status).toBe(409);
    expect(scheduled(env)).toBe(false);
  });

  it("schedules: records confirmed ids + previous moderation, disables now, deletes nothing", async () => {
    const env = makeEnv();
    env.AUTH_DB.firstQueue.push({ id: "u-1", email: "a@x.com", is_admin: 0, moderation: 0, scheduled: 0 });
    env.DB.allQueue.push([{ id: "p-1", name: "Site" }], [{ id: "o-1", name: "Org" }]);
    const before = Math.floor(Date.now() / 1000);
    const res = await schedule(env, "u-1", { confirm_site_ids: ["p-1"], confirm_org_ids: ["o-1"] });
    expect(res.status).toBe(200);

    const batch = env.AUTH_DB.batches[0];
    const insert = batch.find(c => c.sql.includes("INSERT INTO user_deletions"))!;
    const [scheduleId, requestedBy, requestedByEmail, executeAfter, sites, orgs, userId] = insert.binds;
    expect([userId, requestedBy, requestedByEmail]).toEqual(["u-1", "admin-1", "admin@example.com"]);
    // previous_moderation comes from users inside the transaction.
    expect(insert.sql).toContain("u.moderation FROM users u WHERE u.id = ?");
    // A fresh id per schedule - the cron's claim is tied to it.
    expect(scheduleId).toMatch(/^[0-9a-f-]{36}$/);
    // Seven days out.
    expect(executeAfter as number).toBeGreaterThanOrEqual(before + 7 * 86400);
    expect(executeAfter as number).toBeLessThan(before + 7 * 86400 + 60);
    expect(JSON.parse(sites as string)).toEqual(["p-1"]);
    expect(JSON.parse(orgs as string)).toEqual(["o-1"]);
    expect(batch.some(c => c.sql.includes("UPDATE users SET moderation = -1"))).toBe(true);
    expect(batch.some(c => c.sql.includes("INSERT INTO user_moderation_events"))).toBe(true);

    expect(destructive(env)).toBe(false);
    expect(writeAdminAudit).toHaveBeenCalledTimes(1);
    expect(writeAdminAudit).toHaveBeenCalledWith(
      expect.anything(), session, "user.delete.schedule", "user", "u-1", expect.anything(),
    );
  });
});

describe("DELETE /:id/deletion - cancel", () => {
  it("404s when nothing is scheduled", async () => {
    const env = makeEnv();
    const res = await makeUsersApp(env)("/u-1/deletion", { method: "DELETE" });
    expect(res.status).toBe(404);
    expect(writeAdminAudit).not.toHaveBeenCalled();
  });

  const pending = (overrides: Record<string, unknown> = {}) =>
    ({ id: "sched-1", previous_moderation: 0, started_at: null, lease_until: null, ...overrides });
  const cancel = (env: ReturnType<typeof makeEnv>) => makeUsersApp(env)("/u-1/deletion", { method: "DELETE" });

  it("removes THIS schedule (only if still cancellable) and restores the previous moderation", async () => {
    const env = makeEnv();
    env.AUTH_DB.firstQueue.push(pending());
    const res = await cancel(env);
    expect(res.status).toBe(200);
    const batch = env.AUTH_DB.batches[0];
    // Restore + event first, each guarded on THIS schedule still being
    // cancellable; the schedule row is deleted last.
    expect(batch[0].sql).toContain("UPDATE users SET moderation = ?");
    expect(batch[0].sql).toContain("AND id = ? AND started_at IS NULL");
    expect(batch[0].binds.slice(0, 4)).toEqual([0, "u-1", "u-1", "sched-1"]);
    expect(batch[1].sql).toContain("AND id = ? AND started_at IS NULL");
    expect(batch[1].binds).toContain("re_enabled");
    expect(batch[2].sql).toContain("DELETE FROM user_deletions");
    expect(batch[2].binds.slice(0, 2)).toEqual(["u-1", "sched-1"]);
    expect(writeAdminAudit).toHaveBeenCalledWith(
      expect.anything(), session, "user.delete.cancel", "user", "u-1", { restored_moderation: 0 },
    );
  });

  it("refuses while a cron run holds the lease", async () => {
    const env = makeEnv();
    env.AUTH_DB.firstQueue.push(pending({ lease_until: Math.floor(Date.now() / 1000) + 600 }));
    expect((await cancel(env)).status).toBe(409);
    expect(env.AUTH_DB.batch).not.toHaveBeenCalled();
  });
});

describe("PATCH /:id - pending deletion owns moderation", () => {

  it.each([0, -1, Math.floor(Date.now() / 1000) + 3600])("refuses moderation=%s while a deletion is scheduled", async moderation => {
    const env = makeEnv();
    env.AUTH_DB.firstQueue.push({ id: "u-1", scheduled: 1 });
    const res = await makeUsersApp(env)("/u-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ moderation, reason: "x" }),
    });
    expect(res.status).toBe(409);
    expect(env.AUTH_DB.batch).not.toHaveBeenCalled();
  });
});

describe("GET /search - pending deletion", () => {
  it("drives the pending_deletion filter from user_deletions", async () => {
    const env = makeEnv();
    env.AUTH_DB.allQueue.push([]);
    const res = await makeUsersApp(env)("/search?q=&status=pending_deletion");
    expect(res.status).toBe(200);
    const call = env.AUTH_DB.calls.find(c => c.sql.includes("FROM user_deletions d CROSS JOIN users u"));
    expect(call?.sql).toContain("d.user_id IS NOT NULL");
    expect(call?.sql).toContain("deletion_execute_after");
  });

  it("left-joins user_deletions for every other status", async () => {
    const env = makeEnv();
    env.AUTH_DB.allQueue.push([]);
    const res = await makeUsersApp(env)("/search?q=&status=disabled");
    expect(res.status).toBe(200);
    const call = env.AUTH_DB.calls.find(c => c.sql.includes("FROM users u LEFT JOIN user_deletions d"));
    expect(call?.sql).toContain("deletion_execute_after");
  });
});

describe("exactUserMatch", () => {
  it("classifies UUIDs, full emails, and everything else", () => {
    expect(exactUserMatch("3f2b8c4e-1a2b-4c3d-9e8f-0123456789ab")).toBe("id");
    expect(exactUserMatch(" 3F2B8C4E-1A2B-4C3D-9E8F-0123456789AB ")).toBe("id");
    expect(exactUserMatch("bob@example.com")).toBe("email");
    expect(exactUserMatch(" Bob@Example.com ")).toBe("email");
    expect(exactUserMatch("bob@")).toBe("substring");
    expect(exactUserMatch("example.com")).toBe("substring");
    expect(exactUserMatch("bob @example.com")).toBe("substring");
    expect(exactUserMatch("")).toBe("substring");
  });
});

// Real SQLite (every auth migration applied) for the search + details reads:
// result sets, paging, the exact-match fallback, and the query plans that are
// the point of the exact/partial-index/pending-deletion paths.
describe("user search + details against the real schema", () => {
  const NOW = Math.floor(Date.now() / 1000);
  const U1 = "11111111-1111-4111-8111-111111111111";

  function setup() {
    const auth = createSqliteD1(AUTH_MIGRATIONS);
    const env = { ...makeEnv(), AUTH_DB: auth.db };
    const addUser = (id: string, email: string, createdAt: string, moderation = 0) =>
      auth.sqlite.prepare("INSERT INTO users (id, email, name, password_hash, created_at, moderation) VALUES (?, ?, ?, 'x', ?, ?)")
        .run(id, email, id, createdAt, moderation);
    const addEvent = (id: string, userId: string, action: string, reason: string | null, createdAt: string) =>
      auth.sqlite.prepare("INSERT INTO user_moderation_events (id, user_id, action, moderation_value, reason, created_at) VALUES (?, ?, ?, -1, ?, ?)")
        .run(id, userId, action, reason, createdAt);
    addUser(U1, "alice@example.com", "2026-01-01 00:00:00");
    addUser("u-2", "bob@example.com", "2026-01-02 00:00:00", -1);
    addUser("u-3", "xbob@example.com", "2026-01-02 00:00:00", NOW + 3600);
    addUser("u-4", "carol@example.com", "2026-01-03 00:00:00", NOW - 3600);
    addUser("u-5", "dave@example.com", "2026-01-04 00:00:00", -1);
    auth.sqlite.prepare("INSERT INTO user_deletions (user_id, id, requested_by, requested_by_email, execute_after) VALUES ('u-5', 'del-1', 'admin-1', 'admin@example.com', ?)")
      .run(NOW + 86400);
    // Two events on one created_at: the later-inserted (higher rowid) wins.
    addEvent("e-1", "u-2", "suspended", "first", "2026-02-01 00:00:00");
    addEvent("e-2", "u-2", "disabled", "spam", "2026-02-02 00:00:00");
    addEvent("e-3", "u-2", "re_enabled", null, "2026-01-15 00:00:00");
    addEvent("e-4", "u-5", "re_enabled", null, "2026-02-01 00:00:00");
    addEvent("e-5", "u-5", "disabled", null, "2026-02-01 00:00:00");
    return { auth, env, request: makeUsersApp(env) };
  }

  async function search(request: ReturnType<typeof makeUsersApp>, query: string) {
    const res = await request(`/search?${query}`);
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { users: Array<Record<string, unknown>>; nextCursor: string | null } };
    return body.data;
  }
  const ids = (data: { users: Array<Record<string, unknown>> }) => data.users.map(u => u.id);

  it("filters by status, newest first", async () => {
    const { request } = setup();
    expect(ids(await search(request, "q="))).toEqual(["u-5", "u-4", "u-3", "u-2", U1]);
    expect(ids(await search(request, "q=&status=disabled"))).toEqual(["u-5", "u-2"]);
    expect(ids(await search(request, "q=&status=suspended"))).toEqual(["u-3"]);
    expect(ids(await search(request, "q=&status=active"))).toEqual(["u-4", U1]);
    const pending = await search(request, "q=&status=pending_deletion");
    expect(ids(pending)).toEqual(["u-5"]);
    expect(pending.users[0]).toMatchObject({ deletion_requested_by_email: "admin@example.com", deletion_execute_after: NOW + 86400 });
  });

  it("unpacks the latest moderation event (created_at, then rowid, newest wins)", async () => {
    const { request } = setup();
    const { users } = await search(request, "q=");
    const byId = Object.fromEntries(users.map(u => [u.id, u]));
    expect(byId["u-2"]).toMatchObject({
      latest_moderation_action: "disabled",
      latest_moderation_reason: "spam",
      latest_moderation_created_at: "2026-02-02 00:00:00",
    });
    expect(byId["u-5"]).toMatchObject({ latest_moderation_action: "disabled", latest_moderation_reason: null });
    expect(byId[U1]).toMatchObject({
      latest_moderation_action: null,
      latest_moderation_reason: null,
      latest_moderation_created_at: null,
    });
    expect(byId[U1]).not.toHaveProperty("latest_moderation");
  });

  it("matches a full email or UUID exactly, and falls back to substring on a miss", async () => {
    const { request } = setup();
    // Exact: the substring search would also have returned xbob@example.com.
    expect(ids(await search(request, "q=bob%40example.com"))).toEqual(["u-2"]);
    expect(ids(await search(request, `q=${U1}`))).toEqual([U1]);
    // Differently-cased input still hits the normalized address.
    expect(ids(await search(request, "q=BOB%40Example.com"))).toEqual(["u-2"]);
    // A full-looking address that isn't one falls back to the substring search.
    expect(ids(await search(request, "q=bob%40example.co"))).toEqual(["u-3", "u-2"]);
    // An exact hit excluded by the status filter falls back too.
    expect(ids(await search(request, "q=xbob%40example.com&status=disabled"))).toEqual([]);
    // Plain substring search.
    expect(ids(await search(request, "q=bob"))).toEqual(["u-3", "u-2"]);
  });

  it("pages with the keyset cursor without skips or repeats across tied timestamps", async () => {
    const { auth, request } = setup();
    for (let i = 0; i < 30; i++) {
      auth.sqlite.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, 'n', 'x', '2026-03-01 00:00:00')")
        .run(`t-${String(i).padStart(2, "0")}`, `t${i}@example.com`);
    }
    const seen: unknown[] = [];
    let cursor: string | null = null;
    do {
      const page = await search(request, `q=${cursor ? `&cursor=${cursor}` : ""}`);
      seen.push(...ids(page));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(35);
    expect(new Set(seen).size).toBe(35);
    expect(seen.slice(0, 2)).toEqual(["t-29", "t-28"]);
    expect(seen.slice(-5)).toEqual(["u-5", "u-4", "u-3", "u-2", U1]);
  });

  function plan(auth: ReturnType<typeof createSqliteD1>, opts: Parameters<typeof buildUserSearchQuery>[0]): string {
    const { sql, binds } = buildUserSearchQuery(opts);
    return auth.sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(binds as never[]), 26).map(r => String(r.detail)).join("\n");
  }

  it("plans exact lookups as unique-index seeks and pending deletion from user_deletions", () => {
    const { auth } = setup();
    const base = { status: null, cursor: null, nowSeconds: NOW };
    expect(plan(auth, { ...base, q: U1, match: "id" })).toMatch(/SEARCH u USING INDEX sqlite_autoindex_users_1 \(id=\?\)/);
    expect(plan(auth, { ...base, q: "bob@example.com", match: "email" })).toMatch(/SEARCH u USING INDEX sqlite_autoindex_users_2 \(email=\?\)/);
    const pending = plan(auth, { ...base, q: "", match: "substring", status: "pending_deletion" });
    expect(pending.split("\n")[0]).toMatch(/^(SCAN|SEARCH) d\b/);
    expect(pending).toMatch(/SEARCH u USING INDEX sqlite_autoindex_users_1 \(id=\?\)/);
  });

  it("uses the partial moderated-users index for disabled/suspended when it exists (auth 0035)", () => {
    const { auth } = setup();
    auth.sqlite.exec("CREATE INDEX IF NOT EXISTS users_moderated_created_at ON users(created_at DESC, id DESC) WHERE moderation <> 0");
    const base = { q: "", match: "substring" as const, cursor: { ts: "2026-01-03 00:00:00", id: "u-4" }, nowSeconds: NOW };
    expect(plan(auth, { ...base, status: "disabled" })).toContain("USING INDEX users_moderated_created_at");
    expect(plan(auth, { ...base, status: "suspended" })).toContain("USING INDEX users_moderated_created_at");
  });

  it("GET /:id reads profile, TOTP, preferences and billing in one users query", async () => {
    const { auth, env, request } = setup();
    auth.sqlite.prepare("UPDATE users SET totp_secret = 'S', email_verified = 1 WHERE id = 'u-2'").run();
    auth.sqlite.prepare("INSERT INTO user_preferences (user_id, badges) VALUES ('u-2', 3)").run();
    auth.sqlite.prepare("INSERT INTO user_billing (user_id, stripe_customer_id, granted_plan, granted_plan_reason, granted_plan_started_at) VALUES ('u-2', 'cus_1', 'ink', 'comp', ?)")
      .run(Date.now() - 1000);
    const prepare = vi.spyOn(env.AUTH_DB, "prepare");
    const res = await request("/u-2");
    expect(res.status).toBe(200);
    const { data } = await res.json() as { data: Record<string, any> };
    expect(prepare.mock.calls.filter(([sql]) => /FROM users\b/.test(sql))).toHaveLength(1);
    expect(data.profile).toMatchObject({ id: "u-2", account_status: "disabled", email_verified: true, badges: 3 });
    expect(data.moderation.current_reason).toBe("spam");
    expect(data.moderation.history.map((e: { action: string }) => e.action)).toEqual(["disabled", "suspended", "re_enabled"]);
    expect(data.security.totp_enabled).toBe(true);
    expect(data.billing).toMatchObject({ resolved_plan: "ink", via: "granted", stripe: { customer_id: "cus_1" } });

    const plain = await (await request(`/${U1}`)).json() as { data: Record<string, any> };
    expect(plain.data.security.totp_enabled).toBe(false);
    expect(plain.data.moderation.current_reason).toBeNull();
    expect(plain.data.billing).toMatchObject({ resolved_plan: "free", granted: null });

    expect((await request("/nope")).status).toBe(404);
  });
});

describe("PATCH /:id/handle + handle search (real SQLite)", () => {
  function setup() {
    const auth = createSqliteD1(AUTH_MIGRATIONS);
    const add = auth.sqlite.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, 'x', datetime('now'))");
    add.run("u-1", "one@x.com", "One");
    add.run("u-2", "two@x.com", "Two");
    const request = makeUsersApp({ AUTH_DB: auth.db, DB: makeDb() });
    const patch = (id: string, body: unknown) =>
      request(`/${id}/handle`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const prefs = (id: string) =>
      auth.sqlite.prepare("SELECT handle, handle_locked, bio FROM user_preferences WHERE user_id = ?").get(id) as
        { handle: string | null; handle_locked: number; bio: string | null } | undefined;
    return { auth, request, patch, prefs };
  }

  it("sets a normalized handle, allowing reserved names for admins", async () => {
    const t = setup();
    const res = await t.patch("u-1", { handle: "@Annex" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown }).data).toEqual({ handle: "annex", handle_locked: false });
    expect(t.prefs("u-1")).toMatchObject({ handle: "annex", handle_locked: 0 });
    expect(writeAdminAudit).toHaveBeenCalledWith(expect.anything(), session, "user.handle.update", "user", "u-1", { from: null, to: "annex" });
  });

  it("still rejects malformed handles", async () => {
    const t = setup();
    expect((await t.patch("u-1", { handle: "no spaces" })).status).toBe(400);
    expect((await t.patch("u-1", { handle: "ab" })).status).toBe(400);
    expect((await t.patch("u-1", { handle: 7 })).status).toBe(400);
    expect((await t.patch("u-1", { locked: "yes" })).status).toBe(400);
    expect((await t.patch("u-1", {})).status).toBe(400);
    expect(t.prefs("u-1")).toBeUndefined();
    expect(writeAdminAudit).not.toHaveBeenCalled();
  });

  it("409s when another user holds the handle", async () => {
    const t = setup();
    await t.patch("u-2", { handle: "taken" });
    vi.mocked(writeAdminAudit).mockClear();
    const res = await t.patch("u-1", { handle: "TAKEN" });
    expect(res.status).toBe(409);
    expect(t.prefs("u-1")).toBeUndefined();
    expect(writeAdminAudit).not.toHaveBeenCalled();
  });

  it("clear + lock in one call; lock alone leaves the handle untouched", async () => {
    const t = setup();
    t.auth.sqlite.prepare("INSERT INTO user_preferences (user_id, handle, bio) VALUES ('u-1', 'rude', 'keep me')").run();

    // Toggling only the lock must not rewrite the handle.
    expect((await t.patch("u-1", { locked: true })).status).toBe(200);
    expect(t.prefs("u-1")).toEqual({ handle: "rude", handle_locked: 1, bio: "keep me" });

    const res = await t.patch("u-1", { handle: null, locked: true });
    expect(((await res.json()) as { data: unknown }).data).toEqual({ handle: null, handle_locked: true });
    expect(t.prefs("u-1")).toEqual({ handle: null, handle_locked: 1, bio: "keep me" });
    expect(writeAdminAudit).toHaveBeenLastCalledWith(expect.anything(), session, "user.handle.update", "user", "u-1", { from: "rude", to: null, locked: true });

    expect((await t.patch("u-1", { locked: false })).status).toBe(200);
    expect(t.prefs("u-1")?.handle_locked).toBe(0);
  });

  it("details expose the handle + lock, and search finds a user by @handle", async () => {
    const t = setup();
    await t.patch("u-2", { handle: "second", locked: true });

    const details = (await (await t.request("/u-2")).json()) as { data: { profile: { handle: string | null; handle_locked: boolean } } };
    expect(details.data.profile).toMatchObject({ handle: "second", handle_locked: true });

    const search = (await (await t.request("/search?q=%40Second")).json()) as { data: { users: Array<{ id: string; handle: string | null }> } };
    expect(search.data.users.map(u => u.id)).toEqual(["u-2"]);
    expect(search.data.users[0].handle).toBe("second");
    // Email search still works alongside.
    const byEmail = (await (await t.request("/search?q=one%40")).json()) as { data: { users: Array<{ id: string }> } };
    expect(byEmail.data.users.map(u => u.id)).toEqual(["u-1"]);
  });
});
