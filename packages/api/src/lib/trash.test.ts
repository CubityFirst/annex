import { describe, it, expect, beforeEach } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createSqliteD1 } from "../test/sqliteD1";
import {
  moveToTrash, restoreFromTrash, purgeTrashEntry, emptyTrash, purgeExpiredTrash, listTrash, TRASH_RETENTION_DAYS,
} from "./trash";
import type { Env } from "../index";

// Runs against real SQLite with every migration applied (see test/sqliteD1.ts):
// the bin is mostly SQL - FK cascades, recursive subtree CTEs, batch
// atomicity - which a queue mock would only echo back.

const T0 = "2026-10-01T00:00:00.000Z";

function makeR2() {
  const objects = new Set<string>();
  return {
    objects,
    bucket: {
      async delete(keys: string | string[]) { for (const k of Array.isArray(keys) ? keys : [keys]) objects.delete(k); },
      async list({ prefix }: { prefix: string }) {
        return { objects: [...objects].filter(k => k.startsWith(prefix)).map(key => ({ key })), truncated: false };
      },
    },
  };
}

let sqlite: DatabaseSync;
let env: Env;
let r2: ReturnType<typeof makeR2>;

function exec(sql: string, ...args: (string | number | null)[]) {
  sqlite.prepare(sql).run(...args);
}
function rows(sql: string, ...args: (string | number | null)[]) {
  return sqlite.prepare(sql).all(...args).map(r => ({ ...r }));
}
const count = (table: string, where = "1=1", ...args: string[]) =>
  Number(sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(...args)!.n);

function folder(id: string, parentId: string | null, name = id) {
  exec("INSERT INTO folders (id, name, project_id, parent_id, created_at) VALUES (?, ?, 'p1', ?, ?)", id, name, parentId, T0);
}
function doc(id: string, folderId: string | null, extra: { slug?: string } = {}) {
  exec(
    "INSERT INTO docs (id, title, project_id, author_id, folder_id, slug, created_at, updated_at) VALUES (?, ?, 'p1', 'u1', ?, ?, ?, ?)",
    id, `Title ${id}`, folderId, extra.slug ?? null, T0, T0,
  );
  exec("INSERT INTO docs_fts (doc_id, project_id, title, body) VALUES (?, 'p1', ?, ?)", id, `Title ${id}`, `body of ${id}`);
  r2.objects.add(`p1/${id}`);
}
function file(id: string, folderId: string | null, size = 100) {
  exec(
    "INSERT INTO files (id, name, mime_type, size, project_id, folder_id, uploaded_by, created_at) VALUES (?, ?, 'image/png', ?, 'p1', ?, 'u1', ?)",
    id, `${id}.png`, size, folderId, T0,
  );
  r2.objects.add(`files/${id}`);
}

beforeEach(() => {
  const d1 = createSqliteD1();
  sqlite = d1.sqlite;
  r2 = makeR2();
  env = { DB: d1.db, ASSETS: r2.bucket } as unknown as Env;
  exec("INSERT INTO projects (id, name, owner_id, created_at, graph_indexed_at) VALUES ('p1', 'Site', 'u1', ?, ?)", T0, T0);
  exec("INSERT INTO projects (id, name, owner_id, created_at) VALUES ('p2', 'Other', 'u1', ?)", T0);
  exec("INSERT INTO project_members (id, project_id, user_id, email, name, role, invited_by, created_at) VALUES ('m1', 'p1', 'u1', 'a@x', 'Alice', 'owner', 'u1', ?)", T0);
});

describe("moveToTrash", () => {
  it("bins a folder subtree as ONE entry and removes every row from the live tables", async () => {
    folder("A", null, "Alpha");
    folder("B", "A", "Beta");
    folder("C", "B");
    doc("d1", "A");
    doc("d2", "C");
    doc("outside", null);
    file("f1", "B", 300);
    file("f2", "C", 200);

    const res = await moveToTrash(env, { projectId: "p1", type: "folder", id: "A", deletedBy: "u1" });

    expect(res).toEqual({ entryId: expect.any(String), homeDocMoved: false });
    // Nothing from the subtree leaks to the root (the old SET NULL behaviour).
    expect(count("folders")).toBe(0);
    expect(rows("SELECT id FROM docs")).toEqual([{ id: "outside" }]);
    expect(count("files")).toBe(0);
    expect(rows("SELECT doc_id FROM docs_fts")).toEqual([{ doc_id: "outside" }]);

    const [entry] = await listTrash(env.DB, "p1");
    expect(entry).toMatchObject({
      item_type: "folder", item_id: "A", name: "Alpha", folder_id: null,
      doc_count: 2, file_count: 2, folder_count: 2, size: 500, deleted_by_name: "Alice",
    });
    expect(count("trash_items", "entry_id = ?", entry.id)).toBe(7);
    // Binary objects are kept until purge.
    expect(r2.objects.has("files/f1")).toBe(true);
    // Graph index invalidated (a binned title may have resolved wikilinks).
    expect(rows("SELECT graph_indexed_at FROM projects WHERE id = 'p1'")).toEqual([{ graph_indexed_at: null }]);
  });

  it("records the parent folder path for display", async () => {
    folder("A", null, "Alpha");
    folder("B", "A", "Beta");
    doc("d1", "B");
    await moveToTrash(env, { projectId: "p1", type: "doc", id: "d1", deletedBy: "u1" });
    const [entry] = await listTrash(env.DB, "p1");
    expect(entry).toMatchObject({ name: "Title d1", folder_id: "B", folder_path: "Alpha / Beta", doc_count: 1 });
  });

  it("keeps the site's home doc out of a binned folder by moving it to the root", async () => {
    folder("A", null);
    doc("home", "A");
    doc("d1", "A");
    exec("UPDATE projects SET home_doc_id = 'home' WHERE id = 'p1'");

    const res = await moveToTrash(env, { projectId: "p1", type: "folder", id: "A", deletedBy: "u1" });

    expect(res?.homeDocMoved).toBe(true);
    expect(rows("SELECT id, folder_id FROM docs")).toEqual([{ id: "home", folder_id: null }]);
  });

  it("returns null for an item in another project (no cross-site binning)", async () => {
    doc("d1", null);
    expect(await moveToTrash(env, { projectId: "p2", type: "doc", id: "d1", deletedBy: "u1" })).toBeNull();
    expect(count("docs")).toBe(1);
    expect(count("trash_entries")).toBe(0);
  });
});

describe("restoreFromTrash", () => {
  it("round-trips a folder subtree, including shares, the FTS row and report pointers", async () => {
    folder("A", null);
    folder("B", "A");
    doc("d1", "B");
    file("f1", "A");
    exec("INSERT INTO doc_shares (id, doc_id, user_id, project_id, granted_by, created_at) VALUES ('s1', 'd1', 'u2', 'p1', 'u1', ?)", T0);
    exec("INSERT INTO site_reports (id, project_id, doc_id, note) VALUES ('r1', 'p1', 'd1', 'spam')");
    const before = {
      folders: rows("SELECT * FROM folders ORDER BY id"),
      docs: rows("SELECT * FROM docs"),
      files: rows("SELECT * FROM files"),
    };

    const { entryId } = (await moveToTrash(env, { projectId: "p1", type: "folder", id: "A", deletedBy: "u1" }))!;
    // The delete cascades took these - the snapshot is what brings them back.
    expect(count("doc_shares")).toBe(0);
    expect(rows("SELECT doc_id FROM site_reports")).toEqual([{ doc_id: null }]);

    const res = await restoreFromTrash(env, "p1", entryId);

    expect(res).toEqual({ type: "folder", itemId: "A", folderId: null });
    expect(rows("SELECT * FROM folders ORDER BY id")).toEqual(before.folders);
    expect(rows("SELECT * FROM docs")).toEqual(before.docs);
    expect(rows("SELECT * FROM files")).toEqual(before.files);
    expect(rows("SELECT id, user_id FROM doc_shares")).toEqual([{ id: "s1", user_id: "u2" }]);
    expect(rows("SELECT doc_id, body FROM docs_fts")).toEqual([{ doc_id: "d1", body: "body of d1" }]);
    expect(rows("SELECT doc_id FROM site_reports")).toEqual([{ doc_id: "d1" }]);
    expect(count("trash_entries")).toBe(0);
    expect(count("trash_items")).toBe(0);
  });

  it("restores into the original folder when it still exists", async () => {
    folder("A", null);
    doc("d1", "A");
    const { entryId } = (await moveToTrash(env, { projectId: "p1", type: "doc", id: "d1", deletedBy: "u1" }))!;
    expect(await restoreFromTrash(env, "p1", entryId)).toMatchObject({ folderId: "A" });
    expect(rows("SELECT folder_id FROM docs")).toEqual([{ folder_id: "A" }]);
  });

  it("falls back to the site root when the original folder is gone", async () => {
    folder("A", null);
    file("f1", "A");
    const fileEntry = (await moveToTrash(env, { projectId: "p1", type: "file", id: "f1", deletedBy: "u1" }))!;
    await moveToTrash(env, { projectId: "p1", type: "folder", id: "A", deletedBy: "u1" });

    expect(await restoreFromTrash(env, "p1", fileEntry.entryId)).toMatchObject({ folderId: null });
    expect(rows("SELECT folder_id FROM files")).toEqual([{ folder_id: null }]);
  });

  it("drops a custom slug another doc claimed while this one was binned", async () => {
    doc("d1", null, { slug: "intro" });
    const { entryId } = (await moveToTrash(env, { projectId: "p1", type: "doc", id: "d1", deletedBy: "u1" }))!;
    doc("d2", null, { slug: "intro" });

    await restoreFromTrash(env, "p1", entryId);

    expect(rows("SELECT id, slug FROM docs ORDER BY id")).toEqual([{ id: "d1", slug: null }, { id: "d2", slug: "intro" }]);
  });

  it("is scoped to the project", async () => {
    doc("d1", null);
    const { entryId } = (await moveToTrash(env, { projectId: "p1", type: "doc", id: "d1", deletedBy: "u1" }))!;
    expect(await restoreFromTrash(env, "p2", entryId)).toBeNull();
    expect(count("docs")).toBe(0);
  });
});

describe("purging", () => {
  it("purgeTrashEntry deletes R2 bodies, revisions and file bytes, then the rows", async () => {
    folder("A", null);
    doc("d1", "A");
    file("f1", "A");
    doc("keep", null);
    exec("INSERT INTO asset_revisions (id, asset_type, asset_id, project_id, editor_id, editor_name, created_at) VALUES ('rev1', 'doc', 'd1', 'p1', 'u1', 'A', ?)", T0);
    r2.objects.add("p1/d1/v/rev1");
    const { entryId } = (await moveToTrash(env, { projectId: "p1", type: "folder", id: "A", deletedBy: "u1" }))!;

    await purgeTrashEntry(env, { id: entryId, project_id: "p1" });

    expect([...r2.objects]).toEqual(["p1/keep"]);
    expect(count("asset_revisions")).toBe(0);
    expect(count("trash_entries")).toBe(0);
    expect(count("trash_items")).toBe(0);
  });

  it("purgeExpiredTrash only removes entries past the retention window", async () => {
    doc("old", null);
    doc("new", null);
    const now = new Date("2026-11-15T00:00:00.000Z");
    const day = 24 * 60 * 60 * 1000;
    await moveToTrash(env, { projectId: "p1", type: "doc", id: "old", deletedBy: "u1", now: new Date(now.getTime() - (TRASH_RETENTION_DAYS + 1) * day) });
    await moveToTrash(env, { projectId: "p1", type: "doc", id: "new", deletedBy: "u1", now: new Date(now.getTime() - (TRASH_RETENTION_DAYS - 1) * day) });

    expect(await purgeExpiredTrash(env, { now })).toBe(1);
    expect(rows("SELECT item_id FROM trash_entries")).toEqual([{ item_id: "new" }]);
  });

  it("emptyTrash purges only the given project's entries", async () => {
    doc("d1", null);
    doc("d2", null);
    await moveToTrash(env, { projectId: "p1", type: "doc", id: "d1", deletedBy: "u1" });
    await moveToTrash(env, { projectId: "p1", type: "doc", id: "d2", deletedBy: "u1" });
    exec("INSERT INTO trash_entries (id, project_id, item_type, item_id, name, deleted_by, deleted_at) VALUES ('other', 'p2', 'doc', 'x', 'x', 'u1', ?)", T0);

    expect(await emptyTrash(env, "p1")).toEqual({ purged: 2, remaining: 0 });
    expect(rows("SELECT id FROM trash_entries")).toEqual([{ id: "other" }]);
  });

  it("site deletion cascades bin rows", async () => {
    doc("d1", null);
    await moveToTrash(env, { projectId: "p1", type: "doc", id: "d1", deletedBy: "u1" });
    exec("DELETE FROM projects WHERE id = 'p1'");
    expect(count("trash_entries")).toBe(0);
    expect(count("trash_items")).toBe(0);
  });
});
