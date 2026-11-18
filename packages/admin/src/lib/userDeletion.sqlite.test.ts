// End-to-end delayed-deletion scenarios against REAL SQLite (the main DB,
// every migration applied - users mirror, user_deletions and the site tables
// live together): schedule/cancel go through the actual routes, execution
// through the actual cron entry point. These are the races and retry paths a
// queue-based D1 mock can't model.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

const DAY = 24 * 60 * 60;
const T0 = Date.UTC(2026, 9, 1) / 1000; // seconds
const session = { userId: "admin-1", email: "admin@example.com", expiresAt: 0, isAdmin: true };

function setup() {
  const { db, sqlite } = createSqliteD1();
  const env = {
    DB: db,
    ASSETS: { delete: vi.fn(async () => undefined) },
    STRIPE_SECRET_KEY: "",
  };
  const app = new Hono<{ Variables: Record<string, unknown> }>();
  app.use("*", async (c, next) => { c.set("session", session); await next(); });
  app.route("/", usersRouter);
  const request = (path: string, init?: RequestInit) => app.request(path, init, env as never);

  const addUser = (id: string) =>
    sqlite.prepare(
      `INSERT INTO users (id, email, name, is_admin, status, suspended_until, created_at, first_seen_at, synced_at)
       VALUES (?, ?, ?, 0, 'active', NULL, datetime('now'), 0, 0)`,
    ).run(id, `${id}@x.com`, id);
  const addSite = (id: string, ownerId: string) =>
    sqlite.prepare("INSERT INTO projects (id, name, owner_id, created_at) VALUES (?, ?, ?, datetime('now'))")
      .run(id, `Site ${id}`, ownerId);
  const userExists = (id: string) => !!sqlite.prepare("SELECT 1 FROM users WHERE id = ?").get(id);
  const schedule = (id: string) =>
    sqlite.prepare("SELECT * FROM user_deletions WHERE user_id = ?").get(id) as Record<string, unknown> | undefined;
  // Execution finished: the schedule row stays, marked completed (it keeps
  // blocking the person from Annex).
  const completed = (id: string) => schedule(id)?.completed_at != null;
  const scheduleDeletion = (id: string, siteIds: string[] = []) =>
    request(`/${id}/deletion`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm_site_ids: siteIds, confirm_org_ids: [] }),
    });
  const cancelDeletion = (id: string) => request(`/${id}/deletion`, { method: "DELETE" });
  const runAt = (seconds: number) => runDueUserDeletions(env as never, seconds);
  const count = (sql: string) => (sqlite.prepare(sql).get() as { n: number }).n;

  addUser("admin-1");
  return { db, sqlite, request, addUser, addSite, userExists, schedule, completed, scheduleDeletion, cancelDeletion, runAt, count };
}

// Runs `hook` right after the first .first() of a statement whose SQL
// contains `marker` - i.e. "something else commits between this read and
// the request's write".
function interleave(t: ReturnType<typeof setup>, marker: string, hook: () => void, stale?: () => unknown) {
  const realPrepare = t.db.prepare.bind(t.db);
  let fired = false;
  (t.db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
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

const at = (seconds: number) => vi.setSystemTime(seconds * 1000);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  failSiteOnce.clear();
});
afterEach(() => vi.useRealTimers());

describe("delayed deletion (real SQLite)", () => {
  it("never runs before the grace window, then deletes the account's Annex data", async () => {
    const t = setup();
    t.addUser("u-1");
    at(T0);
    expect((await t.scheduleDeletion("u-1")).status).toBe(200);
    // The schedule row itself is the block; the mirror's standing is untouched
    // (moderation lives on the identity service now).
    expect(t.schedule("u-1")).toMatchObject({ execute_after: T0 + 7 * DAY, started_at: null, completed_at: null });
    expect(t.sqlite.prepare("SELECT status FROM users WHERE id = 'u-1'").get()).toEqual({ status: "active" });
    expect(t.count("SELECT COUNT(*) AS n FROM user_moderation_events")).toBe(0);

    expect(await t.runAt(T0 + 7 * DAY - 60)).toEqual({ deleted: 0, failed: 0 });
    expect(t.completed("u-1")).toBe(false);

    expect(await t.runAt(T0 + 7 * DAY + 60)).toEqual({ deleted: 1, failed: 0 });
    expect(t.completed("u-1")).toBe(true);
    const audit = t.sqlite.prepare("SELECT action, actor_user_id, detail FROM admin_audit_log WHERE action = 'user.delete'").all();
    expect(audit).toEqual([{ action: "user.delete", actor_user_id: "admin-1", detail: expect.any(String) }]);
    expect(JSON.parse(String(audit[0].detail))).toMatchObject({ scope: "annex_data", executed_by: "scheduler" });
  });

  it("keeps the users mirror row and the completed schedule; a completed row is never re-run", async () => {
    const t = setup();
    t.addUser("u-1");
    t.sqlite.prepare("INSERT INTO user_billing (user_id, personal_plan) VALUES ('u-1', 'ink')").run();
    t.sqlite.prepare("INSERT INTO user_preferences (user_id, bio) VALUES ('u-1', 'hi')").run();
    t.sqlite.prepare(
      "INSERT INTO sessions (id, user_id, kind, created_at, expires_at, last_used_at) VALUES ('s-1', 'u-1', 'app', 0, 1, 0)",
    ).run();
    at(T0);
    await t.scheduleDeletion("u-1");
    const run1 = T0 + 7 * DAY + 60;
    at(run1);
    expect(await t.runAt(run1)).toEqual({ deleted: 1, failed: 0 });

    // The mirror row and the schedule stay, so the person stays blocked until
    // the identity account itself is deleted.
    expect(t.userExists("u-1")).toBe(true);
    const done = t.schedule("u-1")!;
    expect(done).toMatchObject({ completed_at: run1, lease_until: null, last_error: null });
    expect(done.started_at).not.toBeNull();
    expect(t.count("SELECT COUNT(*) AS n FROM user_billing WHERE user_id = 'u-1'")).toBe(0);
    expect(t.count("SELECT COUNT(*) AS n FROM user_preferences WHERE user_id = 'u-1'")).toBe(0);
    expect(t.count("SELECT COUNT(*) AS n FROM sessions WHERE user_id = 'u-1'")).toBe(0);

    // Later ticks leave it alone - even with a stale expired lease on it, the
    // "cut off" sweep doesn't touch a completed row.
    t.sqlite.prepare("UPDATE user_deletions SET lease_until = ? WHERE user_id = 'u-1'").run(run1 + 10);
    expect(await t.runAt(run1 + 30 * DAY)).toEqual({ deleted: 0, failed: 0 });
    expect(t.schedule("u-1")).toMatchObject({
      completed_at: run1, last_error: null, last_attempt_at: done.last_attempt_at, lease_until: run1 + 10,
    });
    expect(t.count("SELECT COUNT(*) AS n FROM admin_audit_log WHERE action = 'user.delete'")).toBe(1);
    // And it can't be cancelled (that would unblock a person whose data is gone).
    at(run1 + 30 * DAY);
    expect((await t.cancelDeletion("u-1")).status).toBe(409);
    expect(t.completed("u-1")).toBe(true);
  });

  it("removes the account's user-keyed rows, and only that account's", async () => {
    const t = setup();
    t.addUser("u-1");
    t.addUser("u-2");
    t.addSite("p-other", "u-2");
    const now = "2026-10-01 00:00:00";
    t.sqlite.prepare("INSERT INTO docs (id, title, project_id, author_id, created_at, updated_at) VALUES ('d-1', 'T', 'p-other', 'u-2', ?, ?)").run(now, now);
    for (const uid of ["u-1", "u-2"]) {
      t.sqlite.prepare("INSERT INTO doc_shares (id, doc_id, user_id, project_id, granted_by, created_at) VALUES (?, 'd-1', ?, 'p-other', 'u-2', ?)")
        .run(`share-${uid}`, uid, now);
      t.sqlite.prepare("INSERT INTO user_favourite_projects (user_id, project_id, created_at) VALUES (?, 'p-other', 1)").run(uid);
      t.sqlite.prepare("INSERT INTO user_preferences (user_id, bio) VALUES (?, 'bio')").run(uid);
      t.sqlite.prepare("INSERT INTO user_billing (user_id, personal_plan) VALUES (?, 'ink')").run(uid);
      t.sqlite.prepare("INSERT INTO sessions (id, user_id, kind, created_at, expires_at, last_used_at) VALUES (?, ?, 'app', 0, 1, 0)")
        .run(`s-${uid}`, uid);
    }
    at(T0);
    await t.scheduleDeletion("u-1");
    expect(await t.runAt(T0 + 7 * DAY + 60)).toEqual({ deleted: 1, failed: 0 });
    expect(t.completed("u-1")).toBe(true);

    const users = (table: string) =>
      t.sqlite.prepare(`SELECT user_id FROM ${table} ORDER BY user_id`).all().map(r => r.user_id);
    for (const table of ["doc_shares", "user_favourite_projects", "user_preferences", "user_billing", "sessions"]) {
      expect(users(table), table).toEqual(["u-2"]);
    }
    expect(users("user_deletions")).toEqual(["u-1"]);
    expect(t.userExists("u-2")).toBe(true);
  });

  it("a retry after the membership cleanup already ran still finishes the account", async () => {
    const t = setup();
    t.addUser("u-1");
    t.sqlite.prepare("INSERT INTO user_preferences (user_id, bio) VALUES ('u-1', 'bio')").run();
    at(T0);
    await t.scheduleDeletion("u-1");
    // First attempt dies on the final batch (after the membership deletes ran).
    const realBatch = t.db.batch.bind(t.db);
    let failNext = true;
    (t.db as unknown as { batch: typeof realBatch }).batch = async (stmts) => {
      if (failNext && stmts.some(s => (s as unknown as { sql: string }).sql.includes("SET completed_at"))) {
        failNext = false;
        throw new Error("simulated final batch failure");
      }
      return realBatch(stmts);
    };
    const run1 = T0 + 7 * DAY + 60;
    expect(await t.runAt(run1)).toEqual({ deleted: 0, failed: 1 });
    expect(t.completed("u-1")).toBe(false);
    // The batch rolled back as a whole: the preferences row stays, no audit row.
    expect(t.count("SELECT COUNT(*) AS n FROM user_preferences WHERE user_id = 'u-1'")).toBe(1);
    expect(t.count("SELECT COUNT(*) AS n FROM admin_audit_log WHERE action = 'user.delete'")).toBe(0);
    expect(t.schedule("u-1")!.started_at).not.toBeNull();

    expect(await t.runAt(run1 + 3600)).toEqual({ deleted: 1, failed: 0 });
    expect(t.completed("u-1")).toBe(true);
    expect(t.count("SELECT COUNT(*) AS n FROM user_preferences WHERE user_id = 'u-1'")).toBe(0);
  });

  it("cancel lifts the block and the cron leaves the account alone", async () => {
    const t = setup();
    t.addUser("u-1");
    t.sqlite.prepare("INSERT INTO user_preferences (user_id, bio) VALUES ('u-1', 'bio')").run();
    at(T0);
    await t.scheduleDeletion("u-1");
    const res = await t.cancelDeletion("u-1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(t.schedule("u-1")).toBeUndefined();
    expect(await t.runAt(T0 + 30 * DAY)).toEqual({ deleted: 0, failed: 0 });
    expect(t.userExists("u-1")).toBe(true);
    expect(t.count("SELECT COUNT(*) AS n FROM user_preferences WHERE user_id = 'u-1'")).toBe(1);
    expect(t.sqlite.prepare("SELECT action FROM admin_audit_log ORDER BY created_at, rowid").all().map(r => r.action))
      .toEqual(["user.delete.schedule", "user.delete.cancel"]);
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
    expect(t.completed("u-1")).toBe(false);
    expect(await t.runAt(T0 + 10 * DAY + 60)).toEqual({ deleted: 1, failed: 0 });
    expect(t.completed("u-1")).toBe(true);
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
    // p-1 went, p-2 didn't, the run isn't complete - and mid-way.
    expect(t.sqlite.prepare("SELECT id FROM projects ORDER BY id").all()).toEqual([{ id: "p-2" }]);
    expect(t.schedule("u-1")).toMatchObject({ lease_until: null, completed_at: null, last_error: expect.stringContaining("p-2") });
    expect(t.schedule("u-1")!.started_at).not.toBeNull();
    at(run1 + 60);
    expect((await t.cancelDeletion("u-1")).status).toBe(409);

    // Next run finishes it: p-1 being gone counts as done, not as a mismatch.
    expect(await t.runAt(run1 + 3600)).toEqual({ deleted: 1, failed: 0 });
    expect(t.completed("u-1")).toBe(true);
    expect(t.count("SELECT COUNT(*) AS n FROM projects")).toBe(0);
  });

  it("an unconfirmed site blocks execution, and leaves the schedule cancellable", async () => {
    const t = setup();
    t.addUser("u-1");
    at(T0);
    await t.scheduleDeletion("u-1");
    // A site appears under the account during the window (not possible via the
    // app while it's blocked, but the cron must not trust that).
    t.addSite("p-x", "u-1");
    expect(await t.runAt(T0 + 7 * DAY + 60)).toEqual({ deleted: 0, failed: 1 });
    expect(t.completed("u-1")).toBe(false);
    expect(t.sqlite.prepare("SELECT id FROM projects").all()).toEqual([{ id: "p-x" }]);
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
    expect(t.completed("good")).toBe(true);
  });

  it("a stale cancel can't remove a newer schedule (round 2, finding 1)", async () => {
    const t = setup();
    t.addUser("u-1");
    at(T0);
    await t.scheduleDeletion("u-1");
    const staleRow = { ...t.schedule("u-1")! };
    expect((await t.cancelDeletion("u-1")).status).toBe(200);
    // Another admin schedules it again.
    expect((await t.scheduleDeletion("u-1")).status).toBe(200);
    const fresh = t.schedule("u-1")!;
    // A second cancel that read the OLD schedule before the first one committed.
    const fired = interleave(t, "FROM user_deletions WHERE user_id = ?", () => {}, () => staleRow);
    expect((await t.cancelDeletion("u-1")).status).toBe(409);
    expect(fired()).toBe(true);
    expect(t.schedule("u-1")!.id).toBe(fresh.id);
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
    t.sqlite.prepare(
      "UPDATE user_deletions SET lease_until = ?, last_attempt_at = datetime('now') WHERE user_id = 'big'",
    ).run(due - 3600);

    expect(await t.runAt(due)).toEqual({ deleted: 2, failed: 0 });
    expect(t.completed("ok")).toBe(true);
    expect(t.completed("big")).toBe(true);
  });

  it("leaves a due row alone while another run holds a live lease on it", async () => {
    const t = setup();
    t.addUser("u-1");
    at(T0);
    await t.scheduleDeletion("u-1");
    const due = T0 + 7 * DAY + 60;
    t.sqlite.prepare("UPDATE user_deletions SET lease_until = ? WHERE user_id = 'u-1'").run(due + 600);
    expect(await t.runAt(due)).toEqual({ deleted: 0, failed: 0 });
    expect(t.completed("u-1")).toBe(false);
    expect(t.schedule("u-1")).toMatchObject({ lease_until: due + 600, started_at: null });
  });

  it("flags a row whose lease expired without an outcome as cut off", async () => {
    const t = setup();
    t.addUser("u-1");
    at(T0);
    await t.scheduleDeletion("u-1");
    // A killed run left an expired lease behind; this tick is before the row
    // is due again, so only the sweep touches it.
    t.sqlite.prepare("UPDATE user_deletions SET lease_until = ? WHERE user_id = 'u-1'").run(T0 + 60);
    expect(await t.runAt(T0 + 3600)).toEqual({ deleted: 0, failed: 0 });
    expect(t.schedule("u-1")).toMatchObject({ lease_until: null, last_error: expect.stringContaining("cut off") });
    expect(t.completed("u-1")).toBe(false);
  });

  it("a missing Stripe key fails BEFORE the point of no return, so it stays cancellable", async () => {
    const t = setup();
    t.addUser("u-1");
    t.sqlite.prepare("INSERT INTO user_billing (user_id, stripe_customer_id) VALUES ('u-1', 'cus_1')").run();
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
      t.sqlite.prepare(
        `INSERT INTO user_deletions (user_id, id, requested_by, requested_by_email, execute_after)
         VALUES ('u-1', 'sched-other', 'admin-2', 'other@example.com', ?)`,
      ).run(T0 + 7 * DAY);
    });
    const res = await t.scheduleDeletion("u-1");
    expect(fired()).toBe(true);
    expect(res.status).toBe(409);
    // The other admin's schedule is untouched and nothing else was written.
    expect(t.schedule("u-1")!.id).toBe("sched-other");
    expect(t.count("SELECT COUNT(*) AS n FROM admin_audit_log")).toBe(0);
  });
});
