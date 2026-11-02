// Site deletion against REAL SQLite (every API migration applied, foreign
// keys on as in D1): the cascades are what remove most dependent rows, and a
// queue-based mock can't tell whether they actually fire.
import { describe, it, expect, vi } from "vitest";
import { createSqliteD1 } from "../../../api/src/test/sqliteD1";
import { deleteProjectCascade } from "./projectDelete";

function setup() {
  const api = createSqliteD1();
  const s = api.sqlite;
  const now = "2026-01-01 00:00:00";
  for (const p of ["p-1", "p-2"]) {
    s.prepare("INSERT INTO projects (id, name, owner_id, created_at) VALUES (?, ?, 'u-1', ?)").run(p, p, now);
    s.prepare("INSERT INTO folders (id, name, project_id, created_at) VALUES (?, 'F', ?, ?)").run(`${p}-f`, p, now);
    s.prepare("INSERT INTO folders (id, name, project_id, parent_id, created_at) VALUES (?, 'Sub', ?, ?, ?)").run(`${p}-sub`, p, `${p}-f`, now);
    // A root doc, a foldered doc, and one in a nested folder.
    for (const [doc, folder] of [[`${p}-d1`, null], [`${p}-d2`, `${p}-f`], [`${p}-d3`, `${p}-sub`]] as const) {
      s.prepare("INSERT INTO docs (id, title, project_id, folder_id, author_id, created_at, updated_at) VALUES (?, 'T', ?, ?, 'u-1', ?, ?)")
        .run(doc, p, folder, now, now);
      s.prepare("INSERT INTO docs_fts (title, body, doc_id, project_id) VALUES ('T', 'body', ?, ?)").run(doc, p);
      s.prepare("INSERT INTO doc_shares (id, doc_id, user_id, project_id, granted_by, created_at) VALUES (?, ?, 'u-2', ?, 'u-1', ?)")
        .run(`${doc}-share`, doc, p, now);
      s.prepare("INSERT INTO doc_ai_summaries (doc_id, summary, version) VALUES (?, 'S', 1)").run(doc);
      s.prepare("INSERT INTO asset_revisions (id, asset_type, asset_id, project_id, editor_id, editor_name, created_at) VALUES (?, 'doc', ?, ?, 'u-1', 'U', ?)")
        .run(`${doc}-rev`, doc, p, now);
    }
    s.prepare("INSERT INTO doc_links (source_doc_id, target_doc_id, project_id) VALUES (?, ?, ?)").run(`${p}-d1`, `${p}-d2`, p);
    s.prepare("INSERT INTO files (id, name, mime_type, size, project_id, folder_id, uploaded_by, created_at) VALUES (?, 'f.txt', 'text/plain', 1, ?, ?, 'u-1', ?)")
      .run(`${p}-file`, p, `${p}-f`, now);
    s.prepare("INSERT INTO site_reports (id, project_id, doc_id, note) VALUES (?, ?, ?, 'n')").run(`${p}-report`, p, `${p}-d2`);
  }
  const assets = {
    list: vi.fn(async () => ({ objects: [], truncated: false })),
    delete: vi.fn(async () => undefined),
  };
  const env = { DB: api.db, ASSETS: assets };
  const count = (table: string, where = "1") =>
    (s.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get() as { n: number }).n;
  return { env, count };
}

describe("deleteProjectCascade (real SQLite)", () => {
  it("removes the site and every dependent row, and leaves other sites alone", async () => {
    const { env, count } = setup();
    expect(await deleteProjectCascade(env as never, "p-1")).toEqual({ docs: 3, files: 1 });

    for (const [table, col] of [
      ["projects", "id"], ["docs", "project_id"], ["folders", "project_id"], ["files", "project_id"],
      ["doc_shares", "project_id"], ["doc_links", "project_id"], ["docs_fts", "project_id"],
      ["asset_revisions", "project_id"], ["site_reports", "project_id"],
    ]) {
      expect(count(table, `${col} = 'p-1'`), table).toBe(0);
    }
    expect(count("doc_ai_summaries", "doc_id LIKE 'p-1-%'")).toBe(0);

    // p-2 is untouched.
    expect(count("docs", "project_id = 'p-2'")).toBe(3);
    expect(count("doc_shares", "project_id = 'p-2'")).toBe(3);
    expect(count("docs_fts", "project_id = 'p-2'")).toBe(3);
    expect(count("asset_revisions", "project_id = 'p-2'")).toBe(3);
    expect(count("doc_ai_summaries", "doc_id LIKE 'p-2-%'")).toBe(3);
    expect(count("folders", "project_id = 'p-2'")).toBe(2);
    expect(count("site_reports", "project_id = 'p-2' AND doc_id = 'p-2-d2'")).toBe(1);
  });
});
