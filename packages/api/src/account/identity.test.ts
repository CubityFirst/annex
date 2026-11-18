import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSqliteD1, type SqliteD1 } from "../test/sqliteD1";

const { syncStripeCustomerEmail } = vi.hoisted(() => ({ syncStripeCustomerEmail: vi.fn(async () => undefined) }));
vi.mock("./stripe-client", () => ({ syncStripeCustomerEmail }));

import { accountStanding, clearIdentityCache, findUserByEmail, refreshMirror, type IdentityService, type IdentityUser, type MirrorUser } from "./identity";

let db: SqliteD1;
const user = (over: Partial<IdentityUser> = {}): IdentityUser => ({
  id: "u1", email: "new@example.com", name: "U", emailVerified: true, isAdmin: false,
  status: "active", suspendedUntil: null, createdAt: "2025-01-01", ...over,
});

beforeEach(() => {
  db = createSqliteD1();
  clearIdentityCache();
  syncStripeCustomerEmail.mockClear();
  db.sqlite.prepare("INSERT INTO users (id, email, name, created_at, first_seen_at, synced_at) VALUES ('u1', 'old@example.com', 'U', '2025-01-01', 0, 0)").run();
});

describe("findUserByEmail", () => {
  const down = { findUserByEmail: vi.fn(async () => { throw new Error("identity down"); }) } as unknown as IdentityService;

  it("fails rather than guessing from the (non-unique, possibly stale) mirror when the identity service is down", async () => {
    await expect(findUserByEmail({ DB: db.db, IDENTITY: down, APP_ORIGIN: "https://docs.cubityfir.st" }, "old@example.com")).rejects.toThrow("identity down");
  });

  it("falls back to the mirror in local dev", async () => {
    expect(await findUserByEmail({ DB: db.db, IDENTITY: down, APP_ORIGIN: "http://localhost:5173" }, "OLD@example.com"))
      .toEqual({ id: "u1", email: "old@example.com", name: "U" });
  });
});

describe("accountStanding", () => {
  it("keeps the Stripe customer's email in step when the standing check sees a new identity email", async () => {
    const mirror = db.sqlite.prepare("SELECT * FROM users WHERE id = 'u1'").get() as unknown as MirrorUser;
    const env = { DB: db.db, IDENTITY: { getUser: vi.fn(async () => user()) } as unknown as IdentityService, STRIPE_SECRET_KEY: "sk" };
    expect((await accountStanding(env, mirror)).ok).toBe(true);
    expect(db.sqlite.prepare("SELECT email FROM users WHERE id = 'u1'").get()).toEqual({ email: "new@example.com" });
    expect(syncStripeCustomerEmail).toHaveBeenCalledWith(env, "u1", "new@example.com");
  });
});

describe("refreshMirror", () => {
  it("can't revive an account recorded as deleted, nor rewrite its scrubbed member rows", async () => {
    db.sqlite.prepare("INSERT INTO projects (id, name, owner_id, created_at) VALUES ('p1', 'P', 'u1', 't')").run();
    db.sqlite.prepare("INSERT INTO project_members (id, project_id, user_id, email, name, role, invited_by, created_at) VALUES ('m1', 'p1', 'u1', '', 'Deleted account', 'owner', 'u1', 't')").run();
    db.sqlite.prepare("INSERT INTO identity_deletions (user_id, deleted_at, deleted_by) VALUES ('u1', 1, 'self')").run();
    await refreshMirror(db.db, user({ name: "Late" }), 5);
    expect(db.sqlite.prepare("SELECT name FROM users WHERE id = 'u1'").get()).toEqual({ name: "U" });
    expect(db.sqlite.prepare("SELECT name, email FROM project_members WHERE id = 'm1'").get()).toEqual({ name: "Deleted account", email: "" });

    db.sqlite.prepare("DELETE FROM identity_deletions").run();
    db.sqlite.prepare("UPDATE users SET status = 'deleted' WHERE id = 'u1'").run();
    await refreshMirror(db.db, user(), 6);
    expect(db.sqlite.prepare("SELECT status FROM users WHERE id = 'u1'").get()).toEqual({ status: "deleted" });
  });

  it("doesn't re-insert a mirror row the deletion sync already removed", async () => {
    db.sqlite.prepare("INSERT INTO identity_deletions (user_id, deleted_at, deleted_by) VALUES ('u1', 1, 'self')").run();
    db.sqlite.prepare("DELETE FROM users WHERE id = 'u1'").run();
    await refreshMirror(db.db, user(), 7);
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM users").get()).toEqual({ n: 0 });
  });
});
