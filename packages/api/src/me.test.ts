// /me routes driven through the worker's fetch handler with a real signed JWT,
// real SQLite for both the API and auth DBs, and an in-memory R2: the
// favourites cap, DELETE /me's site cleanup and PATCH /me's name sync.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { createSqliteD1, type SqliteD1 } from "./test/sqliteD1";
import { signJwt } from "../../auth/src/jwt";
import worker, { type Env } from "./index";

const AUTH_MIGRATIONS = fileURLToPath(new URL("../../auth/migrations", import.meta.url));
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
let auth: SqliteD1;
let r2: FakeR2;
let authFetch: ReturnType<typeof vi.fn>;
let token: string;

function env(): Env {
  return { DB: api.db, AUTH_DB: auth.db, ASSETS: r2, JWT_SECRET, AUTH: { fetch: authFetch } } as unknown as Env;
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
  auth = createSqliteD1(AUTH_MIGRATIONS);
  r2 = new FakeR2();
  authFetch = vi.fn(async () => Response.json({ ok: true }));
  const now = Date.now();
  auth.sqlite.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES ('u1', 'u1@example.com', 'User One', 'x', datetime('now'))").run();
  auth.sqlite.prepare("INSERT INTO sessions (id, user_id, created_at, expires_at, last_used_at) VALUES ('s1', 'u1', ?, ?, ?)").run(now, now + 3_600_000, now);
  token = await signJwt({ userId: "u1", email: "u1@example.com", expiresAt: now + 3_600_000, sid: "s1" }, JWT_SECRET);
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

describe("DELETE /me", () => {
  it("refuses while the caller owns a site, before touching the auth worker", async () => {
    addSite("mine", true, "u1");
    const res = await call("DELETE", "/me", { password: "pw" });
    expect(res.status).toBe(400);
    expect(authFetch).not.toHaveBeenCalled();
  });

  it("fully deletes a site that appeared after the ownership check (revisions, FTS, R2), plus memberships + avatar", async () => {
    // Someone else's site the user is a member of: must survive.
    addSite("other", true);
    exec("INSERT INTO project_members (id, project_id, user_id, email, name, role, invited_by, created_at) VALUES ('m-other', 'other', 'u1', 'u1@example.com', 'User One', 'editor', 'owner-x', ?)", T);
    exec("INSERT INTO asset_revisions (id, asset_type, asset_id, project_id, editor_id, editor_name, created_at) VALUES ('r-other', 'doc', 'd-other', 'other', 'u1', 'U', ?)", T);
    r2.keys.add("other/d-other");

    // The auth worker deletes the account; a site created in the race window
    // between the owns_projects check and that call gets cleaned up after it.
    authFetch.mockImplementation(async () => {
      addSite("race", false, "u1");
      exec("INSERT INTO docs (id, title, project_id, author_id, created_at, updated_at) VALUES ('d1', 'Doc', 'race', 'u1', ?, ?)", T, T);
      exec("INSERT INTO files (id, name, mime_type, size, project_id, uploaded_by, created_at) VALUES ('f1', 'f', 'image/png', 1, 'race', 'u1', ?)", T);
      exec("INSERT INTO asset_revisions (id, asset_type, asset_id, project_id, editor_id, editor_name, created_at) VALUES ('r1', 'doc', 'd1', 'race', 'u1', 'U', ?)", T);
      exec("INSERT INTO docs_fts (title, body, doc_id, project_id) VALUES ('Doc', 'b', 'd1', 'race')");
      for (const k of ["race/d1", "race/d1/v/r1", "files/f1", "site-logos/race-square"]) r2.keys.add(k);
      return Response.json({ ok: true });
    });
    for (const k of ["avatars/u1-dark", "avatars/u1-light"]) r2.keys.add(k);

    const res = await call("DELETE", "/me", { password: "pw" });
    expect(res.status).toBe(200);

    expect(count("SELECT COUNT(*) AS n FROM projects WHERE id = 'race'")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM asset_revisions WHERE project_id = 'race'")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM docs_fts WHERE project_id = 'race'")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM project_members WHERE user_id = 'u1'")).toBe(0);
    expect([...r2.keys].sort()).toEqual(["other/d-other"]);
    expect(count("SELECT COUNT(*) AS n FROM asset_revisions WHERE project_id = 'other'")).toBe(1);
  });

  it("does no cleanup when the auth worker refuses (wrong password)", async () => {
    addSite("other", true);
    exec("INSERT INTO project_members (id, project_id, user_id, email, name, role, invited_by, created_at) VALUES ('m1', 'other', 'u1', 'e', 'n', 'editor', 'x', ?)", T);
    r2.keys.add("avatars/u1-dark");
    authFetch.mockResolvedValue(Response.json({ ok: false, error: "invalid_password" }, { status: 401 }));

    const res = await call("DELETE", "/me", { password: "nope" });
    expect(res.status).toBe(401);
    expect(count("SELECT COUNT(*) AS n FROM project_members WHERE user_id = 'u1'")).toBe(1);
    expect(r2.keys.has("avatars/u1-dark")).toBe(true);
  });
});

describe("PATCH /me name sync", () => {
  it("updates the denormalized name on site and org memberships", async () => {
    addSite("s1", true);
    exec("INSERT INTO project_members (id, project_id, user_id, email, name, role, invited_by, created_at) VALUES ('m1', 's1', 'u1', 'e', 'Old', 'editor', 'x', ?)", T);
    exec("INSERT INTO organizations (id, name, owner_id, created_at) VALUES ('o1', 'Org', 'x', ?)", T);
    exec("INSERT INTO organization_members (id, organization_id, user_id, email, name, role, invited_by, created_at, accepted) VALUES ('om1', 'o1', 'u1', 'e', 'Old', 'viewer', 'x', ?, 1)", T);

    const res = await call("PATCH", "/me", { name: "  New Name " });
    expect(res.status).toBe(200);
    expect(api.sqlite.prepare("SELECT name FROM project_members WHERE id = 'm1'").get()).toEqual({ name: "New Name" });
    expect(api.sqlite.prepare("SELECT name FROM organization_members WHERE id = 'om1'").get()).toEqual({ name: "New Name" });
  });
});
