// deleteProjectCascade / cleanupDeletedAccount against real SQLite (every API
// migration applied) and an in-memory R2, so the cascades, the recycle-bin
// UNION and the batch atomicity are the real ones.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createSqliteD1, type SqliteD1 } from "../test/sqliteD1";
import { deleteProjectCascade, cleanupDeletedAccount } from "./projectDelete";
import type { Env } from "../index";

// Covers the R2 surface the helpers use: paged prefix list + array delete.
class FakeR2 {
  keys = new Set<string>();
  constructor(keys: string[]) { for (const k of keys) this.keys.add(k); }
  async list({ prefix, cursor }: { prefix: string; cursor?: string }) {
    // Page size 2 so the prefix sweep must follow the cursor. Like R2's, the
    // cursor resumes after the last key returned, so deletes between pages
    // don't shift it.
    const all = [...this.keys].filter(k => k.startsWith(prefix) && (cursor === undefined || k > cursor)).sort();
    const page = all.slice(0, 2);
    const truncated = all.length > 2;
    return { objects: page.map(key => ({ key })), truncated, cursor: truncated ? page[page.length - 1] : undefined, delimitedPrefixes: [] };
  }
  async delete(keys: string | string[]) {
    for (const k of Array.isArray(keys) ? keys : [keys]) this.keys.delete(k);
  }
}

const T = "2026-10-01T00:00:00.000Z";
let api: SqliteD1;
let r2: FakeR2;

function env(): Env {
  return { DB: api.db, ASSETS: r2 } as unknown as Env;
}

function exec(sql: string, ...args: (string | number | null)[]) {
  api.sqlite.prepare(sql).run(...args);
}

function count(sql: string, ...args: string[]): number {
  return (api.sqlite.prepare(sql).get(...args) as { n: number }).n;
}

// A site with a live doc + file, a binned doc + file, revisions, FTS rows and
// memberships - everything deleteProjectCascade has to reach.
function seedSite(projectId: string, ownerId: string) {
  exec("INSERT INTO projects (id, name, owner_id, created_at, published_at) VALUES (?, ?, ?, ?, ?)", projectId, `Site ${projectId}`, ownerId, T, T);
  exec("INSERT INTO project_members (id, project_id, user_id, email, name, role, invited_by, created_at) VALUES (?, ?, ?, 'o@x', 'Owner', 'owner', ?, ?)",
    `${projectId}-m-owner`, projectId, ownerId, ownerId, T);
  exec("INSERT INTO docs (id, title, project_id, author_id, created_at, updated_at) VALUES (?, 'Doc', ?, ?, ?, ?)", `${projectId}-d1`, projectId, ownerId, T, T);
  exec("INSERT INTO files (id, name, mime_type, size, project_id, uploaded_by, created_at) VALUES (?, 'f.png', 'image/png', 1, ?, ?, ?)", `${projectId}-f1`, projectId, ownerId, T);
  // Binned doc + file: rows only exist as trash_items snapshots.
  exec("INSERT INTO trash_entries (id, project_id, item_type, item_id, name, deleted_by, deleted_at) VALUES (?, ?, 'doc', ?, 'Old', ?, ?)", `${projectId}-te1`, projectId, `${projectId}-d2`, ownerId, T);
  exec("INSERT INTO trash_items (entry_id, project_id, item_type, item_id, row_json) VALUES (?, ?, 'doc', ?, '{}')", `${projectId}-te1`, projectId, `${projectId}-d2`);
  exec("INSERT INTO trash_entries (id, project_id, item_type, item_id, name, deleted_by, deleted_at) VALUES (?, ?, 'file', ?, 'old.png', ?, ?)", `${projectId}-te2`, projectId, `${projectId}-f2`, ownerId, T);
  exec("INSERT INTO trash_items (entry_id, project_id, item_type, item_id, row_json) VALUES (?, ?, 'file', ?, '{}')", `${projectId}-te2`, projectId, `${projectId}-f2`);
  for (const [rev, doc] of [["r1", "d1"], ["r2", "d1"], ["r3", "d2"]]) {
    exec("INSERT INTO asset_revisions (id, asset_type, asset_id, project_id, editor_id, editor_name, created_at) VALUES (?, 'doc', ?, ?, ?, 'Owner', ?)",
      `${projectId}-${rev}`, `${projectId}-${doc}`, projectId, ownerId, T);
  }
  exec("INSERT INTO docs_fts (title, body, pid, doc_id, project_id) VALUES ('Doc', 'body', hex(?), ?, ?)", projectId, `${projectId}-d1`, projectId);
  exec("INSERT INTO docs_fts_map (rid, doc_id) VALUES (last_insert_rowid(), ?)", `${projectId}-d1`);
  return [
    `${projectId}/${projectId}-d1`,
    `${projectId}/${projectId}-d1/v/${projectId}-r1`,
    `${projectId}/${projectId}-d1/v/${projectId}-r2`,
    `${projectId}/${projectId}-d2`,
    `${projectId}/${projectId}-d2/v/${projectId}-r3`,
    `files/${projectId}-f1`,
    `files/${projectId}-f2`,
    `site-logos/${projectId}-square`,
    `site-logos/${projectId}-wide`,
  ];
}

function siteRowCounts(projectId: string) {
  return {
    projects: count("SELECT COUNT(*) AS n FROM projects WHERE id = ?", projectId),
    docs: count("SELECT COUNT(*) AS n FROM docs WHERE project_id = ?", projectId),
    files: count("SELECT COUNT(*) AS n FROM files WHERE project_id = ?", projectId),
    members: count("SELECT COUNT(*) AS n FROM project_members WHERE project_id = ?", projectId),
    trash: count("SELECT COUNT(*) AS n FROM trash_items WHERE project_id = ?", projectId),
    revisions: count("SELECT COUNT(*) AS n FROM asset_revisions WHERE project_id = ?", projectId),
    fts: count("SELECT COUNT(*) AS n FROM docs_fts WHERE project_id = ?", projectId),
    ftsMap: count("SELECT COUNT(*) AS n FROM docs_fts_map WHERE doc_id LIKE ? || '-%'", projectId),
  };
}

const GONE = { projects: 0, docs: 0, files: 0, members: 0, trash: 0, revisions: 0, fts: 0, ftsMap: 0 };

let p1Keys: string[];
let p2Keys: string[];

beforeEach(() => {
  api = createSqliteD1();
  p1Keys = seedSite("p1", "u1");
  p2Keys = seedSite("p2", "u2"); // someone else's site - must survive untouched
  r2 = new FakeR2([...p1Keys, ...p2Keys, "avatars/u1-dark", "avatars/u1-light", "avatars/u1", "avatars/u2-dark"]);
});

describe("deleteProjectCascade", () => {
  it("removes the site's rows, revisions, FTS and R2 objects - incl. the recycle bin - and nothing else", async () => {
    await deleteProjectCascade(env(), "p1");

    expect(siteRowCounts("p1")).toEqual(GONE);
    for (const k of p1Keys) expect(r2.keys.has(k), k).toBe(false);

    expect(siteRowCounts("p2")).toEqual({ projects: 1, docs: 1, files: 1, members: 1, trash: 2, revisions: 3, fts: 1, ftsMap: 1 });
    for (const k of p2Keys) expect(r2.keys.has(k), k).toBe(true);
  });

  it("leaves every row in place when the final batch fails (safe to retry)", async () => {
    const realBatch = api.db.batch.bind(api.db);
    const failing = { ...api.db, batch: async (stmts: D1PreparedStatement[]) => {
      // Fail on the last statement, after the earlier ones in the batch ran.
      api.sqlite.exec("CREATE TRIGGER fail_project_delete BEFORE DELETE ON projects BEGIN SELECT RAISE(ABORT, 'boom'); END");
      return realBatch(stmts);
    } } as unknown as D1Database;
    await expect(deleteProjectCascade({ ...env(), DB: failing } as Env, "p1")).rejects.toThrow(/boom/);
    expect(siteRowCounts("p1")).toEqual({ projects: 1, docs: 1, files: 1, members: 1, trash: 2, revisions: 3, fts: 1, ftsMap: 1 });

    api.sqlite.exec("DROP TRIGGER fail_project_delete");
    await deleteProjectCascade(env(), "p1");
    expect(siteRowCounts("p1")).toEqual(GONE);
  });
});

describe("cleanupDeletedAccount", () => {
  it("fully deletes owned sites and drops memberships + avatar, sparing other sites", async () => {
    // u1 is also an editor on u2's site and a member of an org.
    exec("INSERT INTO project_members (id, project_id, user_id, email, name, role, invited_by, created_at) VALUES ('m-u1-p2', 'p2', 'u1', 'a@x', 'A', 'editor', 'u2', ?)", T);
    exec("INSERT INTO organizations (id, name, owner_id, created_at) VALUES ('o1', 'Org', 'u2', ?)", T);
    exec("INSERT INTO organization_members (id, organization_id, user_id, email, name, role, invited_by, created_at, accepted) VALUES ('om1', 'o1', 'u1', 'a@x', 'A', 'viewer', 'u2', ?, 1)", T);

    const res = await cleanupDeletedAccount(env(), "u1");
    expect(res).toEqual({ failedProjectIds: [] });

    expect(siteRowCounts("p1")).toEqual(GONE);
    for (const k of p1Keys) expect(r2.keys.has(k), k).toBe(false);
    expect(count("SELECT COUNT(*) AS n FROM project_members WHERE user_id = 'u1'")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM organization_members WHERE user_id = 'u1'")).toBe(0);
    for (const k of ["avatars/u1-dark", "avatars/u1-light", "avatars/u1"]) expect(r2.keys.has(k), k).toBe(false);

    // u2's site, membership and avatar are untouched.
    expect(siteRowCounts("p2")).toEqual({ projects: 1, docs: 1, files: 1, members: 1, trash: 2, revisions: 3, fts: 1, ftsMap: 1 });
    for (const k of [...p2Keys, "avatars/u2-dark"]) expect(r2.keys.has(k), k).toBe(true);
  });

  it("keeps going when one owned site's cleanup fails, and reports it", async () => {
    exec("INSERT INTO projects (id, name, owner_id, created_at) VALUES ('p3', 'Second', 'u1', ?)", T);
    api.sqlite.exec("CREATE TRIGGER fail_p1 BEFORE DELETE ON projects WHEN OLD.id = 'p1' BEGIN SELECT RAISE(ABORT, 'boom'); END");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await cleanupDeletedAccount(env(), "u1");
    expect(res).toEqual({ failedProjectIds: ["p1"] });
    expect(err).toHaveBeenCalled();
    err.mockRestore();

    // p1's rows survive (findable by owner_id for an admin delete), p3 is gone,
    // and the membership + avatar cleanup still ran.
    expect(count("SELECT COUNT(*) AS n FROM projects WHERE id = 'p1' AND owner_id = 'u1'")).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM projects WHERE id = 'p3'")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM project_members WHERE user_id = 'u1'")).toBe(0);
    expect(r2.keys.has("avatars/u1-dark")).toBe(false);
  });
});
