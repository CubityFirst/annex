import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";

vi.mock("../audit", () => ({ writeAdminAudit: vi.fn() }));

import {
  usersRouter,
  getModerationAction,
  getCurrentStatus,
  buildBillingDetails,
  buildUserStatusClause,
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

  it("builds the active predicate with the now bind", () => {
    expect(buildUserStatusClause("active", NOW)).toEqual({
      sql: "(u.moderation = 0 OR (u.moderation > 0 AND u.moderation <= ?))",
      binds: [NOW],
    });
  });

  it("builds the disabled predicate with no binds", () => {
    expect(buildUserStatusClause("disabled", NOW)).toEqual({
      sql: "u.moderation = -1",
      binds: [],
    });
  });

  it("builds the suspended predicate with the now bind", () => {
    expect(buildUserStatusClause("suspended", NOW)).toEqual({
      sql: "u.moderation > ?",
      binds: [NOW],
    });
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

  it("restores a pre-existing disable rather than re-enabling", async () => {
    const env = makeEnv();
    env.AUTH_DB.firstQueue.push(pending({ previous_moderation: -1 }));
    await cancel(env);
    expect(env.AUTH_DB.batches[0][0].binds.slice(0, 2)).toEqual([-1, "u-1"]);
  });

  it("refuses once execution has started", async () => {
    const env = makeEnv();
    env.AUTH_DB.firstQueue.push(pending({ started_at: 1 }));
    expect((await cancel(env)).status).toBe(409);
    expect(env.AUTH_DB.batch).not.toHaveBeenCalled();
    expect(writeAdminAudit).not.toHaveBeenCalled();
  });

  it("refuses while a cron run holds the lease", async () => {
    const env = makeEnv();
    env.AUTH_DB.firstQueue.push(pending({ lease_until: Math.floor(Date.now() / 1000) + 600 }));
    expect((await cancel(env)).status).toBe(409);
    expect(env.AUTH_DB.batch).not.toHaveBeenCalled();
  });

  it("is a no-op (409, no audit) if a cron claim lands between the read and the write", async () => {
    const env = makeEnv();
    env.AUTH_DB.firstQueue.push(pending());
    env.AUTH_DB.batchChanges.push(0);
    expect((await cancel(env)).status).toBe(409);
    expect(writeAdminAudit).not.toHaveBeenCalled();
  });
});

describe("PATCH /:id - pending deletion owns moderation", () => {
  it("guards the write itself, so a schedule committing mid-request wins (409, no audit)", async () => {
    const env = makeEnv();
    env.AUTH_DB.firstQueue.push({ id: "u-1", scheduled: 0 });
    env.AUTH_DB.batchChanges.push(0);
    const res = await makeUsersApp(env)("/u-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ moderation: 0 }),
    });
    expect(res.status).toBe(409);
    const [update, event] = env.AUTH_DB.batches[0];
    expect(update.sql).toContain("NOT EXISTS (SELECT 1 FROM user_deletions");
    expect(event.sql).toContain("NOT EXISTS (SELECT 1 FROM user_deletions");
    expect(writeAdminAudit).not.toHaveBeenCalled();
  });

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
  it("joins user_deletions and supports the pending_deletion filter", async () => {
    const env = makeEnv();
    env.AUTH_DB.allQueue.push([]);
    const res = await makeUsersApp(env)("/search?q=&status=pending_deletion");
    expect(res.status).toBe(200);
    const call = env.AUTH_DB.calls.find(c => c.sql.includes("FROM users"));
    expect(call?.sql).toContain("LEFT JOIN user_deletions d");
    expect(call?.sql).toContain("d.user_id IS NOT NULL");
    expect(call?.sql).toContain("deletion_execute_after");
  });
});
