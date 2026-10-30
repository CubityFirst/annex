import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../audit", () => ({
  writeAdminAudit: vi.fn(),
  // Route the batched audit insert through the mock DB so tests can see it
  // land in the same batch as the users-row delete.
  adminAuditStatement: vi.fn(
    (env: { AUTH_DB: { prepare(sql: string): { bind(...a: unknown[]): unknown } } }, _actor: unknown, action: string, _type: string, id: string, detail: unknown) =>
      env.AUTH_DB.prepare("INSERT INTO admin_audit_log").bind(action, id, detail),
  ),
}));
vi.mock("./projectDelete", () => ({
  deleteProjectCascade: vi.fn(async () => ({ docs: 3, files: 1 })),
}));

import { adminAuditStatement, writeAdminAudit } from "../audit";
import { deleteProjectCascade } from "./projectDelete";
import { executeUserDeletion, parseIdList, runDueUserDeletions, sameIdSet } from "./userDeletion";
import type { AdminSession } from "../auth";

// Queue-based D1 mock (same shape as routes/users.test.ts), plus a queue for
// the meta.changes each successive .run() reports (default 1).
interface PreparedCall { sql: string; binds: unknown[] }
function makeDb() {
  const firstQueue: unknown[] = [];
  const allQueue: unknown[][] = [];
  const runChanges: number[] = [];
  const calls: PreparedCall[] = [];
  const batches: PreparedCall[][] = [];
  function makeStmt(sql: string) {
    const call: PreparedCall = { sql, binds: [] };
    const stmt = {
      __call: call,
      bind: (...args: unknown[]) => { call.binds = args; return stmt; },
      first: async () => { calls.push(call); return firstQueue.shift() ?? null; },
      all: async () => { calls.push(call); return { results: allQueue.shift() ?? [] }; },
      run: async () => { calls.push(call); return { meta: { changes: runChanges.shift() ?? 1 } }; },
    };
    return stmt;
  }
  return {
    firstQueue, allQueue, runChanges, calls, batches,
    prepare: vi.fn((sql: string) => makeStmt(sql)),
    batch: vi.fn(async (stmts: Array<{ __call: PreparedCall }>) => {
      batches.push(stmts.map(s => s.__call));
      return stmts.map(() => ({ results: [], meta: { changes: 1 } }));
    }),
  };
}
function makeEnv() {
  return {
    AUTH_DB: makeDb(),
    DB: makeDb(),
    ASSETS: { delete: vi.fn(async () => undefined) },
    STRIPE_SECRET_KEY: "sk_test_x",
  };
}
type TestEnv = ReturnType<typeof makeEnv>;

const actor: AdminSession = { userId: "admin-1", email: "admin@example.com", expiresAt: 0, isAdmin: true };
const run = (env: TestEnv, userId: string, confirm: { siteIds: string[]; orgIds: string[] } = { siteIds: [], orgIds: [] }) =>
  executeUserDeletion(env as never, actor, { userId, scheduleId: "sched-1", confirm });
const userDeleted = (env: TestEnv) =>
  [...env.AUTH_DB.calls, ...env.AUTH_DB.batches.flat()].some(c => c.sql.includes("DELETE FROM users"));
const plainUser = (stripe: string | null = null) => ({ id: "u-1", email: "a@x.com", is_admin: 0, stripe_customer_id: stripe });

const realFetch = globalThis.fetch;
beforeEach(() => vi.clearAllMocks());
afterEach(() => { globalThis.fetch = realFetch; });

describe("sameIdSet", () => {
  it("matches regardless of order and duplicates", () => {
    expect(sameIdSet(["a", "b"], ["b", "a", "a"])).toBe(true);
    expect(sameIdSet([], [])).toBe(true);
  });
  it("rejects a missing, extra, or different id", () => {
    expect(sameIdSet(["a", "b"], ["a"])).toBe(false);
    expect(sameIdSet(["a"], ["a", "b"])).toBe(false);
    expect(sameIdSet(["a"], ["b"])).toBe(false);
    expect(sameIdSet(["a"], [])).toBe(false);
  });
});

describe("parseIdList", () => {
  it("parses string arrays and fails closed to [] on anything else", () => {
    expect(parseIdList('["a","b"]')).toEqual(["a", "b"]);
    expect(parseIdList('["a",1,null]')).toEqual(["a"]);
    expect(parseIdList("not json")).toEqual([]);
    expect(parseIdList('{"a":1}')).toEqual([]);
    expect(parseIdList(null)).toEqual([]);
  });
});

describe("executeUserDeletion", () => {
  it("refuses an account that became an admin during the grace window", async () => {
    const env = makeEnv();
    env.AUTH_DB.firstQueue.push({ ...plainUser(), is_admin: 1 });
    const res = await run(env, "u-1");
    expect(res.ok).toBe(false);
    expect(userDeleted(env)).toBe(false);
  });

  it("refuses (and touches nothing, not even started_at) when an owned site wasn't confirmed", async () => {
    const env = makeEnv();
    env.AUTH_DB.firstQueue.push(plainUser("cus_1"));
    env.DB.allQueue.push([{ id: "p-1", name: "Site" }], []);
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as typeof fetch;
    const res = await run(env, "u-1");
    expect(res.ok).toBe(false);
    expect(env.AUTH_DB.calls.some(c => c.sql.includes("started_at"))).toBe(false);
    expect(deleteProjectCascade).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(userDeleted(env)).toBe(false);
  });

  it("refuses unconfirmed owned orgs", async () => {
    const env = makeEnv();
    env.AUTH_DB.firstQueue.push(plainUser());
    env.DB.allQueue.push([], [{ id: "o-1", name: "Org" }]);
    const res = await run(env, "u-1");
    expect(res.ok).toBe(false);
    expect(userDeleted(env)).toBe(false);
  });

  it("aborts if the schedule was cancelled/replaced before the point of no return", async () => {
    const env = makeEnv();
    env.AUTH_DB.firstQueue.push(plainUser("cus_1"));
    env.DB.allQueue.push([], []);
    env.AUTH_DB.runChanges.push(0); // started_at UPDATE matched no (user_id, id)
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ id: "cus_1" }));
    globalThis.fetch = fetchMock as typeof fetch;
    const res = await run(env, "u-1");
    expect(res.ok).toBe(false);
    const started = env.AUTH_DB.calls.find(c => c.sql.includes("SET started_at"));
    expect(started?.binds.slice(1)).toEqual(["u-1", "sched-1"]);
    // Only the read-only preflight ran - the customer was never deleted.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBeUndefined();
    expect(userDeleted(env)).toBe(false);
  });

  it("deletes a plain account; the audit row and the users delete share one batch", async () => {
    const env = makeEnv();
    env.AUTH_DB.firstQueue.push(plainUser());
    env.DB.allQueue.push([], [], [], []);
    const res = await run(env, "u-1");
    expect(res).toEqual({ ok: true, sites_deleted: 0, orgs_deleted: 0 });
    expect(deleteProjectCascade).not.toHaveBeenCalled();
    expect(env.DB.batches[0].map(c => c.sql)).toEqual([
      expect.stringContaining("DELETE FROM project_members"),
      expect.stringContaining("DELETE FROM organization_members"),
      expect.stringContaining("DELETE FROM api_keys"),
    ]);
    expect(env.ASSETS.delete).toHaveBeenCalledWith(["avatars/u-1-dark", "avatars/u-1-light", "avatars/u-1"]);
    const finalBatch = env.AUTH_DB.batches.at(-1)!;
    expect(finalBatch[0].sql).toContain("INSERT INTO admin_audit_log");
    expect(finalBatch[0].binds[0]).toBe("user.delete");
    expect(finalBatch[1].sql).toContain("DELETE FROM users");
    expect(writeAdminAudit).not.toHaveBeenCalled();
    expect(adminAuditStatement).toHaveBeenCalledTimes(1);
  });

  it("deletes the confirmed sites + orgs, then the account", async () => {
    const env = makeEnv();
    env.AUTH_DB.firstQueue.push(plainUser());
    const owned = () => [[{ id: "p-1", name: "One" }, { id: "p-2", name: "Two" }], [{ id: "o-1", name: "Org" }]];
    env.DB.allQueue.push(...owned(), ...owned());
    const res = await run(env, "u-1", { siteIds: ["p-2", "p-1"], orgIds: ["o-1"] });
    expect(res.ok).toBe(true);
    expect(vi.mocked(deleteProjectCascade).mock.calls.map(c => c[1])).toEqual(["p-1", "p-2"]);
    const orgDelete = env.DB.calls.find(c => c.sql.includes("DELETE FROM organizations "));
    expect(orgDelete?.binds).toEqual(["u-1", "o-1"]);
    expect(userDeleted(env)).toBe(true);
    expect(writeAdminAudit).toHaveBeenCalledTimes(2); // one project.delete per site
  });

  it("fails closed if a confirmed site still exists under someone else", async () => {
    const env = makeEnv();
    env.AUTH_DB.firstQueue.push(plainUser());
    env.DB.allQueue.push([], [], [{ id: "p-1" }]);
    const res = await run(env, "u-1", { siteIds: ["p-1"], orgIds: [] });
    expect(res.ok).toBe(false);
    expect(userDeleted(env)).toBe(false);
  });

  it("deletes many orgs in statements under D1's 100-parameter cap", async () => {
    const env = makeEnv();
    env.AUTH_DB.firstQueue.push(plainUser());
    const orgs = Array.from({ length: 120 }, (_, i) => ({ id: `o-${i}`, name: `Org ${i}` }));
    env.DB.allQueue.push([], orgs, [], orgs);
    const res = await run(env, "u-1", { siteIds: [], orgIds: orgs.map(o => o.id) });
    expect(res.ok).toBe(true);
    const orgDeletes = env.DB.calls.filter(c => c.sql.includes("DELETE FROM organizations "));
    expect(orgDeletes).toHaveLength(3);
    for (const d of orgDeletes) expect(d.binds.length).toBeLessThanOrEqual(100);
    expect(orgDeletes.flatMap(d => d.binds.slice(1))).toEqual(orgs.map(o => o.id));
  });

  it("preflights the Stripe customer, then deletes it first; a delete failure aborts everything", async () => {
    const env = makeEnv();
    env.AUTH_DB.firstQueue.push(plainUser("cus_1"));
    env.DB.allQueue.push([{ id: "p-1", name: "Site" }], []);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ id: "cus_1" }))
      .mockResolvedValueOnce(new Response("boom", { status: 500 }));
    globalThis.fetch = fetchMock as typeof fetch;
    const res = await run(env, "u-1", { siteIds: ["p-1"], orgIds: [] });
    expect(res.ok).toBe(false);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.stripe.com/v1/customers/cus_1");
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBeUndefined(); // GET
    expect((fetchMock.mock.calls[1][1] as RequestInit).method).toBe("DELETE");
    expect(deleteProjectCascade).not.toHaveBeenCalled();
    expect(userDeleted(env)).toBe(false);
  });

  it("skips the delete when Stripe reports the customer already deleted (a retry)", async () => {
    const env = makeEnv();
    env.AUTH_DB.firstQueue.push(plainUser("cus_1"));
    env.DB.allQueue.push([], [], [], []);
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ id: "cus_1", deleted: true }));
    globalThis.fetch = fetchMock as typeof fetch;
    const res = await run(env, "u-1");
    expect(res.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a key that can't see the customer (wrong account/mode) fails BEFORE the point of no return", async () => {
    const env = makeEnv();
    env.AUTH_DB.firstQueue.push(plainUser("cus_1"));
    env.DB.allQueue.push([], []);
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response("{}", { status: 404 }));
    globalThis.fetch = fetchMock as typeof fetch;
    const res = await run(env, "u-1");
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining("wrong account or test/live mode") });
    // Still cancellable: started_at was never set, and no DELETE was sent.
    expect(env.AUTH_DB.calls.some(c => c.sql.includes("started_at"))).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(userDeleted(env)).toBe(false);
  });

  it("a 404 on the delete itself (race) still requires Stripe to confirm deletion", async () => {
    const env = makeEnv();
    env.AUTH_DB.firstQueue.push(plainUser("cus_1"));
    env.DB.allQueue.push([], []);
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ id: "cus_1" }))
      .mockResolvedValueOnce(new Response("{}", { status: 404 }))
      .mockResolvedValueOnce(new Response("{}", { status: 404 })) as typeof fetch;
    const res = await run(env, "u-1");
    expect(res.ok).toBe(false);
    expect(userDeleted(env)).toBe(false);
  });

  it("re-freezes and stops if an unconfirmed site appears after the first check", async () => {
    const env = makeEnv();
    env.AUTH_DB.firstQueue.push(plainUser());
    env.DB.allQueue.push([{ id: "p-1", name: "Site" }], []);
    env.DB.allQueue.push([{ id: "p-1", name: "Site" }, { id: "p-new", name: "New" }], []);
    const res = await run(env, "u-1", { siteIds: ["p-1"], orgIds: [] });
    expect(res.ok).toBe(false);
    expect(env.AUTH_DB.calls.find(c => c.sql.includes("SET moderation = -1"))?.binds).toEqual(["u-1"]);
    expect(deleteProjectCascade).not.toHaveBeenCalled();
    expect(userDeleted(env)).toBe(false);
  });
});

describe("runDueUserDeletions", () => {
  const row = (userId: string, overrides: Record<string, unknown> = {}) => ({
    user_id: userId, id: `sched-${userId}`, requested_by: "admin-9", requested_by_email: "ops@example.com",
    requested_at: "2026-10-12 10:00:00", confirm_site_ids: "[]", confirm_org_ids: "[]", ...overrides,
  });

  it("skips a row it can't claim (cancelled, rescheduled, or leased since the SELECT)", async () => {
    const env = makeEnv();
    env.AUTH_DB.allQueue.push([row("u-1")]);
    env.AUTH_DB.runChanges.push(1, 0); // interrupted sweep, then the claim matches nothing
    const result = await runDueUserDeletions(env as never, 10);
    expect(result).toEqual({ deleted: 0, failed: 0 });
    const claim = env.AUTH_DB.calls.find(c => c.sql.includes("SET lease_until = ?"))!;
    expect(claim.sql).toContain("AND id = ? AND execute_after <= ?");
    // The attempt is stamped at claim time, so a killed run still rotates.
    expect(claim.sql).toContain("last_attempt_at = datetime('now')");
    expect(claim.binds).toEqual([10 + 30 * 60, "u-1", "sched-u-1", 10, 10]);
    // Never looked the user up, let alone deleted anything.
    expect(env.AUTH_DB.calls.some(c => c.sql.includes("FROM users u"))).toBe(false);
  });

  it("executes with the stored consent, attributes audit to the scheduler, and records failures", async () => {
    const env = makeEnv();
    env.AUTH_DB.allQueue.push([row("u-ok", { confirm_site_ids: '["p-1"]' }), row("u-bad")]);
    // u-ok: user row, then ownership x2 (matches the stored ["p-1"]).
    env.AUTH_DB.firstQueue.push({ id: "u-ok", email: "ok@x.com", is_admin: 0, stripe_customer_id: null });
    env.DB.allQueue.push([{ id: "p-1", name: "Site" }], [], [{ id: "p-1", name: "Site" }], []);
    // u-bad: owns a site that was never confirmed.
    env.AUTH_DB.firstQueue.push({ id: "u-bad", email: "bad@x.com", is_admin: 0, stripe_customer_id: null });
    env.DB.allQueue.push([{ id: "p-2", name: "Unreviewed" }], []);

    const result = await runDueUserDeletions(env as never, 10);
    expect(result).toEqual({ deleted: 1, failed: 1 });
    expect(vi.mocked(deleteProjectCascade).mock.calls.map(c => c[1])).toEqual(["p-1"]);
    expect(adminAuditStatement).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: "admin-9", email: "ops@example.com" }),
      "user.delete", "user", "u-ok",
      expect.objectContaining({ executed_by: "scheduler" }),
    );
    const failure = env.AUTH_DB.calls.find(c => c.sql.includes("SET last_error"))!;
    expect(failure.sql).toContain("lease_until = NULL");
    expect(failure.binds.slice(1)).toEqual(["u-bad", "sched-u-bad"]);
    expect(String(failure.binds[0])).toMatch(/weren't confirmed/);
  });
});
