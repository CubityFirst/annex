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
    prepare: vi.fn((sql: string) => makeStmt(sql)),
    batch: vi.fn(async (stmts: Array<{ __call: PreparedCall }>) => {
      batches.push(stmts.map(s => s.__call));
      return stmts.map(() => ({ results: [] }));
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
});
