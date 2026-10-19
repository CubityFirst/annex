// End-to-end delayed-deletion scenarios against REAL SQLite (both the auth
// and the API schema, every migration applied): schedule/cancel go through
// the actual routes, execution through the actual cron entry point. These are
// the races and retry paths a queue-based D1 mock can't model.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { createSqliteD1 } from "../../../api/src/test/sqliteD1";

// Site deletion's R2/Cloudflare side is out of scope here; the stand-in just
// drops the row, and can be told to fail for a given site once.
const failSiteOnce = new Set<string>();
vi.mock("./projectDelete", () => ({
  deleteProjectCascade: vi.fn(async (env: { DB: D1Database }, projectId: string) => {
    if (failSiteOnce.delete(projectId)) throw new Error(`simulated failure deleting ${projectId}`);
    await env.DB.prepare("DELETE FROM projects WHERE id = ?").bind(projectId).run();
    return { docs: 0, files: 0 };
  }),
}));

import { usersRouter } from "../routes/users";
import { runDueUserDeletions } from "./userDeletion";

const AUTH_MIGRATIONS = fileURLToPath(new URL("../../../auth/migrations", import.meta.url));
const DAY = 24 * 60 * 60;
const T0 = Date.UTC(2026, 9, 1) / 1000; // seconds
const session = { userId: "admin-1", email: "admin@example.com", expiresAt: 0, isAdmin: true };

function setup() {
  const auth = createSqliteD1(AUTH_MIGRATIONS);
  const api = createSqliteD1();
  const env = {
    AUTH_DB: auth.db,
    DB: api.db,
    ASSETS: { delete: vi.fn(async () => undefined) },
    STRIPE_SECRET_KEY: "",
  };
  const app = new Hono<{ Variables: Record<string, unknown> }>();
  app.use("*", async (c, next) => { c.set("session", session); await next(); });
  app.route("/", usersRouter);
  const request = (path: string, init?: RequestInit) => app.request(path, init, env as never);

  const addUser = (id: string) =>
    auth.sqlite.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, 'x', datetime('now'))")
      .run(id, `${id}@x.com`, id);
  const addSite = (id: string, ownerId: string) =>
    api.sqlite.prepare("INSERT INTO projects (id, name, owner_id, created_at) VALUES (?, ?, ?, datetime('now'))")
      .run(id, `Site ${id}`, ownerId);
  const userExists = (id: string) => !!auth.sqlite.prepare("SELECT 1 FROM users WHERE id = ?").get(id);
  const schedule = (id: string) =>
    auth.sqlite.prepare("SELECT * FROM user_deletions WHERE user_id = ?").get(id) as Record<string, unknown> | undefined;
  const scheduleDeletion = (id: string, siteIds: string[] = []) =>
    request(`/${id}/deletion`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm_site_ids: siteIds, confirm_org_ids: [] }),
    });
  const cancelDeletion = (id: string) => request(`/${id}/deletion`, { method: "DELETE" });
  const runAt = (seconds: number) => runDueUserDeletions(env as never, seconds);

  addUser("admin-1");
  return { auth, api, request, addUser, addSite, userExists, schedule, scheduleDeletion, cancelDeletion, runAt };
}

const at = (seconds: number) => vi.setSystemTime(seconds * 1000);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  failSiteOnce.clear();
});
afterEach(() => vi.useRealTimers());

describe("delayed deletion (real SQLite)", () => {
  it("never runs before the grace window, then deletes the account", async () => {
    const t = setup();
    t.addUser("u-1");
    at(T0);
    expect((await t.scheduleDeletion("u-1")).status).toBe(200);
    // Disabled immediately, with a moderation event that satisfies the FK.
    expect(t.auth.sqlite.prepare("SELECT moderation FROM users WHERE id = 'u-1'").get()).toEqual({ moderation: -1 });

    expect(await t.runAt(T0 + 7 * DAY - 60)).toEqual({ deleted: 0, failed: 0 });
    expect(t.userExists("u-1")).toBe(true);

    expect(await t.runAt(T0 + 7 * DAY + 60)).toEqual({ deleted: 1, failed: 0 });
    expect(t.userExists("u-1")).toBe(false);
    expect(t.schedule("u-1")).toBeUndefined();
    const audit = t.auth.sqlite.prepare("SELECT action, actor_user_id FROM admin_audit_log WHERE action = 'user.delete'").all();
    expect(audit).toEqual([{ action: "user.delete", actor_user_id: "admin-1" }]);
  });

  it("cancel restores the account and the cron leaves it alone", async () => {
    const t = setup();
    t.addUser("u-1");
    at(T0);
    await t.scheduleDeletion("u-1");
    expect((await t.cancelDeletion("u-1")).status).toBe(200);
    expect(t.auth.sqlite.prepare("SELECT moderation FROM users WHERE id = 'u-1'").get()).toEqual({ moderation: 0 });
    expect(await t.runAt(T0 + 30 * DAY)).toEqual({ deleted: 0, failed: 0 });
    expect(t.userExists("u-1")).toBe(true);
  });

  it("a cancel + reschedule runs on the NEW deadline, not the old one (finding 1)", async () => {
    const t = setup();
    t.addUser("u-1");
    at(T0);
    await t.scheduleDeletion("u-1");
    const first = t.schedule("u-1")!;
    at(T0 + 3 * DAY);
    await t.cancelDeletion("u-1");
    await t.scheduleDeletion("u-1");
    const second = t.schedule("u-1")!;
    expect(second.id).not.toBe(first.id);

    // Past the OLD deadline, before the new one.
    expect(await t.runAt(T0 + 8 * DAY)).toEqual({ deleted: 0, failed: 0 });
    expect(t.userExists("u-1")).toBe(true);
    expect(await t.runAt(T0 + 10 * DAY + 60)).toEqual({ deleted: 1, failed: 0 });
    expect(t.userExists("u-1")).toBe(false);
  });

  it("a partial failure is retried to completion (finding 2), and cancel is refused once started", async () => {
    const t = setup();
    t.addUser("u-1");
    t.addSite("p-1", "u-1");
    t.addSite("p-2", "u-1");
    at(T0);
    expect((await t.scheduleDeletion("u-1", ["p-1", "p-2"])).status).toBe(200);

    failSiteOnce.add("p-2");
    const run1 = T0 + 7 * DAY + 60;
    expect(await t.runAt(run1)).toEqual({ deleted: 0, failed: 1 });
    // p-1 went, p-2 didn't, the account is still there - and mid-way.
    expect(t.api.sqlite.prepare("SELECT id FROM projects ORDER BY id").all()).toEqual([{ id: "p-2" }]);
    expect(t.schedule("u-1")).toMatchObject({ lease_until: null, last_error: expect.stringContaining("p-2") });
    expect(t.schedule("u-1")!.started_at).not.toBeNull();
    at(run1 + 60);
    expect((await t.cancelDeletion("u-1")).status).toBe(409);

    // Next run finishes it: p-1 being gone counts as done, not as a mismatch.
    expect(await t.runAt(run1 + 3600)).toEqual({ deleted: 1, failed: 0 });
    expect(t.userExists("u-1")).toBe(false);
    expect(t.api.sqlite.prepare("SELECT COUNT(*) AS n FROM projects").get()).toEqual({ n: 0 });
  });

  it("an unconfirmed site blocks execution, and leaves the schedule cancellable", async () => {
    const t = setup();
    t.addUser("u-1");
    at(T0);
    await t.scheduleDeletion("u-1");
    // A site appears under the account during the window (not possible via the
    // app while it's disabled, but the cron must not trust that).
    t.addSite("p-x", "u-1");
    expect(await t.runAt(T0 + 7 * DAY + 60)).toEqual({ deleted: 0, failed: 1 });
    expect(t.userExists("u-1")).toBe(true);
    expect(t.api.sqlite.prepare("SELECT id FROM projects").all()).toEqual([{ id: "p-x" }]);
    expect(t.schedule("u-1")!.started_at).toBeNull();
    at(T0 + 7 * DAY + 120);
    expect((await t.cancelDeletion("u-1")).status).toBe(200);
  });

  it("failing schedules rotate to the back instead of starving the queue (finding 4)", async () => {
    const t = setup();
    at(T0);
    for (let i = 0; i < 5; i++) {
      t.addUser(`bad-${i}`);
      await t.scheduleDeletion(`bad-${i}`);
      t.addSite(`p-${i}`, `bad-${i}`); // unconfirmed -> permanently failing
    }
    at(T0 + DAY);
    t.addUser("good");
    await t.scheduleDeletion("good");

    const due = T0 + 9 * DAY;
    expect(await t.runAt(due)).toEqual({ deleted: 0, failed: 5 });
    expect(await t.runAt(due + 3600)).toEqual({ deleted: 1, failed: 4 });
    expect(t.userExists("good")).toBe(false);
  });

  it("a schedule committing between PATCH's pre-check and its write still wins (finding 3)", async () => {
    const t = setup();
    t.addUser("u-1");
    at(T0);
    // Wrap the auth DB so the moment PATCH's pre-check has read "not
    // scheduled", a schedule commits - the race the reviewer reproduced.
    const realPrepare = t.auth.db.prepare.bind(t.auth.db);
    let raced = false;
    (t.auth.db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
      const stmt = realPrepare(sql);
      if (!sql.includes("d.user_id IS NOT NULL AS scheduled FROM users u")) return stmt;
      return {
        bind: (...args: unknown[]) => {
          const bound = stmt.bind(...args);
          return {
            first: async () => {
              const row = await bound.first();
              if (!raced) {
                raced = true;
                t.auth.sqlite.prepare(
                  `INSERT INTO user_deletions (user_id, id, requested_by, requested_by_email, execute_after, previous_moderation)
                   VALUES ('u-1', 'sched-race', 'admin-1', 'admin@example.com', ?, 0)`,
                ).run(T0 + 7 * DAY);
                t.auth.sqlite.prepare("UPDATE users SET moderation = -1 WHERE id = 'u-1'").run();
              }
              return row;
            },
          };
        },
      };
    };

    const res = await t.request("/u-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ moderation: 0 }),
    });
    expect(raced).toBe(true);
    expect(res.status).toBe(409);
    // The schedule's disable stands, and no stray "re_enabled" event was written.
    expect(t.auth.sqlite.prepare("SELECT moderation FROM users WHERE id = 'u-1'").get()).toEqual({ moderation: -1 });
    expect(t.auth.sqlite.prepare("SELECT COUNT(*) AS n FROM user_moderation_events WHERE user_id = 'u-1'").get()).toEqual({ n: 0 });
  });
  // Runs `hook` right after the first .first() of a statement whose SQL
  // contains `marker` - i.e. "something else commits between this read and
  // the request's write".
  function interleave(t: ReturnType<typeof setup>, marker: string, hook: () => void, stale?: () => unknown) {
    const realPrepare = t.auth.db.prepare.bind(t.auth.db);
    let fired = false;
    (t.auth.db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
      const stmt = realPrepare(sql);
      if (fired || !sql.includes(marker)) return stmt;
      return {
        bind: (...args: unknown[]) => {
          const bound = stmt.bind(...args);
          return {
            first: async () => {
              const row = stale ? stale() : await bound.first();
              fired = true;
              hook();
              return row;
            },
          };
        },
      };
    };
    return () => fired;
  }

  it("a stale cancel can't undo a ban made after the first cancel (round 2, finding 1)", async () => {
    const t = setup();
    t.addUser("u-1");
    at(T0);
    await t.scheduleDeletion("u-1");
    const staleRow = { ...t.schedule("u-1")! };
    expect((await t.cancelDeletion("u-1")).status).toBe(200);
    // Another admin bans the account.
    t.auth.sqlite.prepare("UPDATE users SET moderation = -1 WHERE id = 'u-1'").run();
    // A second cancel that read the schedule before the first one committed.
    const fired = interleave(t, "FROM user_deletions WHERE user_id = ?", () => {}, () => staleRow);
    expect((await t.cancelDeletion("u-1")).status).toBe(409);
    expect(fired()).toBe(true);
    expect(t.auth.sqlite.prepare("SELECT moderation FROM users WHERE id = 'u-1'").get()).toEqual({ moderation: -1 });
  });

  it("scheduling snapshots moderation inside its transaction (round 2, finding 2)", async () => {
    const t = setup();
    t.addUser("u-1");
    at(T0);
    // The account is banned between the schedule route's read and its write.
    const fired = interleave(t, "d.user_id IS NOT NULL AS scheduled", () => {
      t.auth.sqlite.prepare("UPDATE users SET moderation = -1 WHERE id = 'u-1'").run();
    });
    expect((await t.scheduleDeletion("u-1")).status).toBe(200);
    expect(fired()).toBe(true);
    expect(t.schedule("u-1")!.previous_moderation).toBe(-1);
    // So cancelling keeps the ban.
    expect((await t.cancelDeletion("u-1")).status).toBe(200);
    expect(t.auth.sqlite.prepare("SELECT moderation FROM users WHERE id = 'u-1'").get()).toEqual({ moderation: -1 });
  });

  it("a run killed mid-deletion is flagged and rotates behind healthy rows (round 2, finding 3)", async () => {
    const t = setup();
    t.addUser("big");
    t.addUser("ok");
    at(T0);
    await t.scheduleDeletion("big");
    at(T0 + DAY);
    await t.scheduleDeletion("ok");
    // Simulate an earlier run that claimed "big" and was killed before
    // recording an outcome: stamped attempt, lease long expired.
    const due = T0 + 9 * DAY;
    t.auth.sqlite.prepare(
      "UPDATE user_deletions SET lease_until = ?, last_attempt_at = datetime('now') WHERE user_id = 'big'",
    ).run(due - 3600);

    expect(await t.runAt(due)).toEqual({ deleted: 2, failed: 0 });
    expect(t.userExists("ok")).toBe(false);
    expect(t.userExists("big")).toBe(false);
  });

  it("flags a row whose lease expired without an outcome as cut off", async () => {
    const t = setup();
    t.addUser("u-1");
    at(T0);
    await t.scheduleDeletion("u-1");
    // A killed run left an expired lease behind; this tick is before the row
    // is due again, so only the sweep touches it.
    t.auth.sqlite.prepare("UPDATE user_deletions SET lease_until = ? WHERE user_id = 'u-1'").run(T0 + 60);
    expect(await t.runAt(T0 + 3600)).toEqual({ deleted: 0, failed: 0 });
    expect(t.schedule("u-1")).toMatchObject({ lease_until: null, last_error: expect.stringContaining("cut off") });
    expect(t.userExists("u-1")).toBe(true);
  });

  it("a missing Stripe key fails BEFORE the point of no return, so it stays cancellable", async () => {
    const t = setup();
    t.addUser("u-1");
    t.auth.sqlite.prepare("INSERT INTO user_billing (user_id, stripe_customer_id) VALUES ('u-1', 'cus_1')").run();
    at(T0);
    await t.scheduleDeletion("u-1");
    expect(await t.runAt(T0 + 7 * DAY + 60)).toEqual({ deleted: 0, failed: 1 });
    expect(t.schedule("u-1")!.started_at).toBeNull();
    expect(String(t.schedule("u-1")!.last_error)).toContain("STRIPE_SECRET_KEY");
    at(T0 + 7 * DAY + 120);
    expect((await t.cancelDeletion("u-1")).status).toBe(200);
  });
  it("two admins scheduling the same account at once: the loser gets a clean 409", async () => {
    const t = setup();
    t.addUser("u-1");
    at(T0);
    // Another admin's schedule commits right after this request's pre-check.
    const fired = interleave(t, "d.user_id IS NOT NULL AS scheduled", () => {
      t.auth.sqlite.prepare(
        `INSERT INTO user_deletions (user_id, id, requested_by, requested_by_email, execute_after, previous_moderation)
         VALUES ('u-1', 'sched-other', 'admin-2', 'other@example.com', ?, 0)`,
      ).run(T0 + 7 * DAY);
    });
    const res = await t.scheduleDeletion("u-1");
    expect(fired()).toBe(true);
    expect(res.status).toBe(409);
    // The other admin's schedule is untouched and nothing else was written.
    expect(t.schedule("u-1")!.id).toBe("sched-other");
    expect(t.auth.sqlite.prepare("SELECT COUNT(*) AS n FROM user_moderation_events").get()).toEqual({ n: 0 });
  });

});
