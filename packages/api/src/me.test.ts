// /me routes driven through the worker's fetch handler with a real signed
// session JWT and real SQLite: the favourites cap, GET/PATCH /me from the
// users mirror, and the profile card.

import { describe, it, expect, beforeEach } from "vitest";
import { createSqliteD1, type SqliteD1 } from "./test/sqliteD1";
import { seedSession } from "./test/session";
import worker, { type Env } from "./index";

const JWT_SECRET = "test-secret";
const T = "2026-10-01T00:00:00.000Z";

class FakeR2 {
  keys = new Set<string>();
  async list({ prefix, cursor }: { prefix: string; cursor?: string }) {
    const all = [...this.keys].filter(k => k.startsWith(prefix) && (cursor === undefined || k > cursor)).sort();
    return { objects: all.map(key => ({ key })), truncated: false, delimitedPrefixes: [] };
  }
  async delete(keys: string | string[]) {
    for (const k of Array.isArray(keys) ? keys : [keys]) this.keys.delete(k);
  }
}

let api: SqliteD1;
let r2: FakeR2;
let token: string;

function env(): Env {
  return { DB: api.db, ASSETS: r2, JWT_SECRET, OIDC_ISSUER: "https://auth.example" } as unknown as Env;
}

function call(method: string, path: string, body?: unknown) {
  return worker.fetch(new Request(`http://localhost${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }), env());
}

function exec(sql: string, ...args: (string | number | null)[]) {
  api.sqlite.prepare(sql).run(...args);
}

function count(sql: string, ...args: string[]): number {
  return (api.sqlite.prepare(sql).get(...args) as { n: number }).n;
}

function addSite(id: string, published: boolean, ownerId = "owner-x") {
  exec("INSERT INTO projects (id, name, owner_id, created_at, published_at) VALUES (?, ?, ?, ?, ?)", id, id, ownerId, T, published ? T : null);
}

function addFavourite(projectId: string, createdAt = Date.now()) {
  exec("INSERT INTO user_favourite_projects (user_id, project_id, created_at) VALUES ('u1', ?, ?)", projectId, createdAt);
}

beforeEach(async () => {
  api = createSqliteD1();
  r2 = new FakeR2();
  token = await seedSession(api.sqlite, { userId: "u1", email: "u1@example.com", name: "User One", sid: "s1", secret: JWT_SECRET });
});

describe("POST /me/favourite-sites/:id cap", () => {
  it("ignores favourites the list can't show (deleted or unpublished sites)", async () => {
    addSite("pub-1", true);
    addSite("draft", false);
    addSite("target", true);
    addFavourite("pub-1");
    addFavourite("draft");
    addFavourite("gone"); // orphan: site row no longer exists

    const list = await call("GET", "/me/favourite-sites");
    expect(((await list.json()) as { data: unknown[] }).data).toHaveLength(1);

    const res = await call("POST", "/me/favourite-sites/target");
    expect(res.status).toBe(200);
    expect(count("SELECT COUNT(*) AS n FROM user_favourite_projects WHERE user_id = 'u1' AND project_id = 'target'")).toBe(1);
  });

  it("still refuses a 4th visible favourite, but a re-POST at the cap stays idempotent", async () => {
    for (const id of ["a", "b", "c", "d"]) addSite(id, true);
    addFavourite("a");
    addFavourite("b");
    addFavourite("c");

    expect((await call("POST", "/me/favourite-sites/d")).status).toBe(409);
    expect((await call("POST", "/me/favourite-sites/a")).status).toBe(200);
  });
});

describe("GET /me", () => {
  it("serves identity facts from the users mirror plus Annex prefs and account links", async () => {
    exec("INSERT INTO user_preferences (user_id, timezone, handle, handle_locked) VALUES ('u1', 'Europe/London', 'one', 1)");
    const res = await call("GET", "/me");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown }).data).toMatchObject({
      userId: "u1",
      name: "User One",
      email: "u1@example.com",
      timezone: "Europe/London",
      handle: "one",
      handleLocked: true,
      personalPlan: "free",
      accountUrl: "https://auth.example/account",
      securityUrl: "https://auth.example/account/security",
    });
  });
});

describe("PATCH /me", () => {
  it("refuses a name change: the name is managed on the identity service", async () => {
    const res = await call("PATCH", "/me", { name: "New Name" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "name_managed_by_identity", accountUrl: "https://auth.example/account" });
    expect(api.sqlite.prepare("SELECT name FROM users WHERE id = 'u1'").get()).toEqual({ name: "User One" });
  });

  it("sets and clears the timezone, rejecting unknown zones", async () => {
    expect((await call("PATCH", "/me", { timezone: "Not/AZone" })).status).toBe(400);
    expect((await call("PATCH", "/me", { timezone: "Asia/Tokyo" })).status).toBe(200);
    expect(api.sqlite.prepare("SELECT timezone FROM user_preferences WHERE user_id = 'u1'").get()).toEqual({ timezone: "Asia/Tokyo" });
    expect((await call("PATCH", "/me", { timezone: null })).status).toBe(200);
    expect(api.sqlite.prepare("SELECT timezone FROM user_preferences WHERE user_id = 'u1'").get()).toEqual({ timezone: null });
  });
});

describe("DELETE /me", () => {
  it("is gone: accounts are deleted on the identity service", async () => {
    expect((await call("DELETE", "/me")).status).toBe(404);
    expect(count("SELECT COUNT(*) AS n FROM users WHERE id = 'u1'")).toBe(1);
  });
});

describe("GET /users/:userId", () => {
  it("builds the profile card from the mirror, shows the bio only while the user holds Ink, and 404s unknown users", async () => {
    exec("INSERT INTO users (id, email, name, created_at, first_seen_at, synced_at) VALUES ('u2', 'u2@example.com', 'Two', '2025-01-01', 0, 0)");
    exec("INSERT INTO user_preferences (user_id, bio, badges, handle) VALUES ('u2', 'hello', 3, 'two')");
    let data = ((await (await call("GET", "/users/u2")).json()) as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({ userId: "u2", name: "Two", badges: 3, handle: "two", personalPlan: "free" });
    expect(data.bio).toBeUndefined();
    expect(data.email).toBeUndefined();

    exec("INSERT INTO user_billing (user_id, granted_plan, granted_plan_started_at) VALUES ('u2', 'ink', 1)");
    data = ((await (await call("GET", "/users/u2")).json()) as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({ personalPlan: "ink", bio: "hello" });

    expect((await call("GET", "/users/nobody")).status).toBe(404);
  });
});
