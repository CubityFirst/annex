// Deletion sync (accounts deleted on auth.cubityfir.st) against real SQLite
// with every main-DB migration applied, a fake IdentityService and Stripe.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createSqliteD1, type SqliteD1 } from "../test/sqliteD1";

const customersDel = vi.fn();
vi.mock("../account/stripe-client", () => ({ getStripe: () => ({ customers: { del: customersDel } }) }));

import { syncIdentityDeletions, recordIdentityDeletions, type DeletionSyncEnv } from "./identityDeletions";

class FakeR2 {
  keys = new Set<string>();
  async list({ prefix }: { prefix: string }) {
    return { objects: [...this.keys].filter(k => k.startsWith(prefix)).map(key => ({ key })), truncated: false, delimitedPrefixes: [] };
  }
  async delete(keys: string | string[]) {
    for (const k of Array.isArray(keys) ? keys : [keys]) this.keys.delete(k);
  }
}

const T = "2026-10-01T00:00:00.000Z";
let db: SqliteD1;
let r2: FakeR2;
let deletions: Array<{ userId: string; deletedAt: number; deletedBy: string }>;
let listDeletedUsers: ReturnType<typeof vi.fn>;

function env(over: Partial<DeletionSyncEnv> = {}): DeletionSyncEnv {
  return {
    DB: db.db,
    ASSETS: r2 as unknown as R2Bucket,
    IDENTITY: { listDeletedUsers, getUser: vi.fn(), getUsers: vi.fn(), findUserByEmail: vi.fn() } as unknown as DeletionSyncEnv["IDENTITY"],
    STRIPE_SECRET_KEY: "sk_test",
    ...over,
  };
}

function exec(sql: string, ...args: (string | number | null)[]) {
  db.sqlite.prepare(sql).run(...args);
}
function count(sql: string): number {
  return (db.sqlite.prepare(sql).get() as { n: number }).n;
}
function addUser(id: string) {
  exec("INSERT INTO users (id, email, name, created_at, first_seen_at, synced_at) VALUES (?, ?, ?, ?, 0, 0)", id, `${id}@x`, id, T);
}

beforeEach(() => {
  db = createSqliteD1();
  r2 = new FakeR2();
  customersDel.mockReset();
  customersDel.mockResolvedValue({ deleted: true });
  deletions = [];
  listDeletedUsers = vi.fn(async (since: number, limit = 100) =>
    deletions.filter(d => d.deletedAt > since).sort((a, b) => a.deletedAt - b.deletedAt).slice(0, limit));

  for (const u of ["gone", "other"]) addUser(u);
  // gone owns site s1 (shared with other) and org o1; is a member of other's s2.
  exec("INSERT INTO projects (id, name, owner_id, created_at) VALUES ('s1', 'Gone site', 'gone', ?)", T);
  exec("INSERT INTO projects (id, name, owner_id, created_at) VALUES ('s2', 'Other site', 'other', ?)", T);
  exec("INSERT INTO project_members (id, project_id, user_id, email, name, role, invited_by, created_at, accepted) VALUES ('m1', 's1', 'gone', 'g@x', 'G', 'owner', 'gone', ?, 1)", T);
  exec("INSERT INTO project_members (id, project_id, user_id, email, name, role, invited_by, created_at, accepted) VALUES ('m2', 's1', 'other', 'o@x', 'O', 'editor', 'gone', ?, 1)", T);
  exec("INSERT INTO project_members (id, project_id, user_id, email, name, role, invited_by, created_at, accepted) VALUES ('m3', 's2', 'gone', 'g@x', 'G', 'editor', 'other', ?, 1)", T);
  exec("INSERT INTO organizations (id, name, owner_id, created_at) VALUES ('o1', 'Gone org', 'gone', ?)", T);
  exec("INSERT INTO organization_members (id, organization_id, user_id, email, name, role, invited_by, created_at, accepted) VALUES ('om1', 'o1', 'gone', 'g@x', 'G', 'owner', 'gone', ?, 1)", T);
  exec("INSERT INTO user_billing (user_id, stripe_customer_id, personal_plan) VALUES ('gone', 'cus_gone', 'ink')");
  exec("INSERT INTO user_preferences (user_id, handle) VALUES ('gone', 'goner')");
  exec("INSERT INTO sessions (id, user_id, created_at, expires_at, last_used_at) VALUES ('sess', 'gone', 0, 9999999999999, 0)");
  exec("INSERT INTO api_keys (id, user_id, project_id, name, key_hash, key_prefix, scope, can_invite, created_at) VALUES ('k1', 'gone', 's1', 'k', 'h', 'annx_', 'read', 0, ?)", T);
  for (const k of ["avatars/gone-dark", "avatars/gone-light", "avatars/other-dark"]) r2.keys.add(k);
});

describe("syncIdentityDeletions", () => {
  it("removes the deleted account's Annex data but keeps the sites and orgs it owned for review", async () => {
    deletions.push({ userId: "gone", deletedAt: 1000, deletedBy: "self" });
    const res = await syncIdentityDeletions(env(), 5000);
    expect(res).toEqual({ recorded: 1, processed: 1, failed: 0 });

    expect(customersDel).toHaveBeenCalledWith("cus_gone");
    // Mirror row and everything cascading from it.
    expect(count("SELECT COUNT(*) AS n FROM users WHERE id = 'gone'")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM user_billing WHERE user_id = 'gone'")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM user_preferences WHERE user_id = 'gone'")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM sessions WHERE user_id = 'gone'")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM api_keys WHERE user_id = 'gone'")).toBe(0);
    // Membership elsewhere gone; owner rows on owned site/org kept.
    expect(count("SELECT COUNT(*) AS n FROM project_members WHERE id = 'm3'")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM project_members WHERE id IN ('m1', 'm2')")).toBe(2);
    // ...but the deleted owner's name/email are scrubbed from them.
    expect(db.sqlite.prepare("SELECT name, email FROM project_members WHERE id = 'm1'").get()).toEqual({ name: "Deleted account", email: "" });
    expect(db.sqlite.prepare("SELECT name, email FROM organization_members WHERE id = 'om1'").get()).toEqual({ name: "Deleted account", email: "" });
    expect(db.sqlite.prepare("SELECT name FROM project_members WHERE id = 'm2'").get()).toEqual({ name: "O" });
    expect(count("SELECT COUNT(*) AS n FROM organization_members WHERE id = 'om1'")).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM projects WHERE id = 's1'")).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM organizations WHERE id = 'o1'")).toBe(1);
    expect([...r2.keys]).toEqual(["avatars/other-dark"]);

    expect(db.sqlite.prepare("SELECT processed_at, owned_site_ids, owned_org_ids, last_error FROM identity_deletions WHERE user_id = 'gone'").get())
      .toEqual({ processed_at: 5000, owned_site_ids: '["s1"]', owned_org_ids: '["o1"]', last_error: null });
    // The other user is untouched.
    expect(count("SELECT COUNT(*) AS n FROM users WHERE id = 'other'")).toBe(1);
  });

  it("leaves the row pending with the error when Stripe fails, then finishes on a later run", async () => {
    deletions.push({ userId: "gone", deletedAt: 1000, deletedBy: "admin:a" });
    customersDel.mockRejectedValueOnce(Object.assign(new Error("stripe down"), { statusCode: 500 }));
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await syncIdentityDeletions(env())).toEqual({ recorded: 1, processed: 0, failed: 1 });
    expect(db.sqlite.prepare("SELECT processed_at, last_error FROM identity_deletions").get()).toEqual({ processed_at: null, last_error: "stripe down" });
    expect(count("SELECT COUNT(*) AS n FROM users WHERE id = 'gone'")).toBe(1);

    expect(await syncIdentityDeletions(env())).toEqual({ recorded: 0, processed: 1, failed: 0 });
    expect(count("SELECT COUNT(*) AS n FROM users WHERE id = 'gone'")).toBe(0);
  });

  it("treats an already-deleted Stripe customer as done", async () => {
    deletions.push({ userId: "gone", deletedAt: 1000, deletedBy: "self" });
    customersDel.mockRejectedValueOnce(Object.assign(new Error("No such customer"), { code: "resource_missing", statusCode: 404 }));
    expect((await syncIdentityDeletions(env())).processed).toBe(1);
  });

  it("refuses to drop a paying account's data without a Stripe key", async () => {
    deletions.push({ userId: "gone", deletedAt: 1000, deletedBy: "self" });
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await syncIdentityDeletions(env({ STRIPE_SECRET_KEY: undefined }))).failed).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM users WHERE id = 'gone'")).toBe(1);
  });

  it("processes an account Annex never knew as a no-op", async () => {
    deletions.push({ userId: "never-used-annex", deletedAt: 1000, deletedBy: "self" });
    expect(await syncIdentityDeletions(env())).toEqual({ recorded: 1, processed: 1, failed: 0 });
    expect(customersDel).not.toHaveBeenCalled();
  });

  it("does nothing without the IDENTITY binding", async () => {
    expect(await syncIdentityDeletions(env({ IDENTITY: undefined }))).toEqual({ recorded: 0, processed: 0, failed: 0 });
  });
});

describe("recordIdentityDeletions cursor", () => {
  it("resumes from the newest recorded deletion and re-reads its millisecond so ties aren't skipped", async () => {
    deletions.push({ userId: "a", deletedAt: 1000, deletedBy: "self" });
    expect(await recordIdentityDeletions(env())).toBe(1);
    expect(listDeletedUsers).toHaveBeenLastCalledWith(0, 100);

    // A second deletion in the same millisecond, seen only on the next poll.
    deletions.push({ userId: "b", deletedAt: 1000, deletedBy: "self" }, { userId: "c", deletedAt: 2000, deletedBy: "self" });
    expect(await recordIdentityDeletions(env())).toBe(2);
    expect(listDeletedUsers).toHaveBeenLastCalledWith(999, 100);
    expect(count("SELECT COUNT(*) AS n FROM identity_deletions")).toBe(3);
  });

  it("pages through more than one page per run", async () => {
    for (let i = 1; i <= 150; i++) deletions.push({ userId: `u${i}`, deletedAt: i * 10, deletedBy: "self" });
    expect(await recordIdentityDeletions(env())).toBe(150);
    expect(listDeletedUsers).toHaveBeenCalledTimes(2);
    expect(listDeletedUsers).toHaveBeenNthCalledWith(2, 999, 100);
  });

  it("re-reads a page that can't advance (all one millisecond) at the RPC cap instead of stalling", async () => {
    for (let i = 1; i <= 120; i++) deletions.push({ userId: `same${i}`, deletedAt: 700, deletedBy: "admin:bulk" });
    deletions.push({ userId: "later", deletedAt: 800, deletedBy: "self" });
    expect(await recordIdentityDeletions(env())).toBe(121);
    expect(listDeletedUsers).toHaveBeenCalledWith(699, 500);
  });

  it("doesn't skip deletions sharing a millisecond across a page boundary", async () => {
    for (let i = 1; i <= 99; i++) deletions.push({ userId: `a${i}`, deletedAt: i, deletedBy: "self" });
    for (const id of ["tie1", "tie2", "tie3"]) deletions.push({ userId: id, deletedAt: 500, deletedBy: "self" });
    expect(await recordIdentityDeletions(env())).toBe(102);
    expect(count("SELECT COUNT(*) AS n FROM identity_deletions WHERE user_id LIKE 'tie%'")).toBe(3);
  });
});
