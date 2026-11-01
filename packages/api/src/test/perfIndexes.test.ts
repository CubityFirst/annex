import { describe, it, expect, beforeEach } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createSqliteD1 } from "./sqliteD1";

// Pins the query plans that migration 0063_perf_indexes.sql exists for, plus
// the favourites cleanup trigger it adds. Runs against real SQLite with every
// migration applied, so a later table rebuild that silently drops one of these
// indexes (as 0032/0033 did to idx_members_user) fails here.

let sqlite: DatabaseSync;

function plan(sql: string): string {
  const n = (sql.match(/\?/g) ?? []).length;
  return sqlite
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...Array(n).fill("x"))
    .map(r => String(r.detail))
    .join("\n");
}

beforeEach(() => {
  ({ sqlite } = createSqliteD1());
  sqlite.exec(`
    INSERT INTO projects (id, name, owner_id, created_at) VALUES
      ('p1', 'One', 'u1', '2026-01-01'), ('p2', 'Two', 'u1', '2026-01-02');
  `);
});

describe("0063 perf indexes", () => {
  it("looks up a user's memberships by user_id instead of scanning project_members", () => {
    const yourSites = plan(
      `SELECT p.id, pm.role FROM projects p
         INNER JOIN project_members pm ON pm.project_id = p.id
        WHERE pm.user_id = ? AND pm.accepted = 1
        ORDER BY pm.is_favourite DESC, p.created_at DESC`,
    );
    expect(yourSites).toContain("SEARCH pm USING INDEX idx_project_members_user (user_id=? AND accepted=?)");
    expect(plan("DELETE FROM project_members WHERE user_id = ?")).toContain("idx_project_members_user");
  });

  it("indexes folders.parent_id for the delete cascade and subtree CTEs", () => {
    // What SQLite runs for the ON DELETE CASCADE child lookup.
    expect(plan("SELECT 1 FROM folders WHERE parent_id = ?")).toContain("idx_folders_parent");
    const subtree = plan(
      `WITH RECURSIVE sub(id) AS (
         SELECT id FROM folders WHERE id = ?
         UNION ALL SELECT f.id FROM folders f JOIN sub ON f.parent_id = sub.id
       ) SELECT id FROM sub`,
    );
    expect(subtree).toContain("idx_folders_parent");
    expect(subtree).not.toContain("AUTOMATIC");
    expect(plan("SELECT * FROM folders WHERE project_id = ? AND parent_id IS NULL AND type = ? ORDER BY name"))
      .toContain("idx_folders_project_parent (project_id=? AND parent_id=?)");

    sqlite.exec(`
      INSERT INTO folders (id, name, project_id, parent_id, created_at) VALUES
        ('f1', 'a', 'p1', NULL, 'x'), ('f2', 'b', 'p1', 'f1', 'x'), ('f3', 'c', 'p1', 'f2', 'x');
      DELETE FROM folders WHERE id = 'f1';
    `);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM folders").get()).toEqual({ n: 0 });
  });

  it("indexes site_reports.doc_id for the doc-delete SET NULL and trash lookups", () => {
    expect(plan("UPDATE site_reports SET doc_id = NULL WHERE doc_id = ?")).toContain("idx_site_reports_doc");
    expect(plan("SELECT id, doc_id FROM site_reports WHERE doc_id IN (?, ?)")).toContain("idx_site_reports_doc");

    sqlite.exec(`
      INSERT INTO docs (id, title, project_id, author_id, created_at, updated_at) VALUES ('d1', 'D', 'p1', 'u1', 'x', 'x');
      INSERT INTO site_reports (id, project_id, doc_id, note) VALUES ('r1', 'p1', 'd1', 'spam');
      DELETE FROM docs WHERE id = 'd1';
    `);
    expect(sqlite.prepare("SELECT doc_id FROM site_reports WHERE id = 'r1'").get()).toEqual({ doc_id: null });
  });

  it("orders revisions by (created_at, id) straight from the index", () => {
    const history = plan(
      `SELECT id FROM asset_revisions WHERE asset_type = 'doc' AND asset_id = ?
        ORDER BY created_at DESC, id DESC LIMIT ?`,
    );
    expect(history).toContain("idx_asset_revisions_asset_created_id");
    expect(history).not.toContain("TEMP B-TREE");
  });

  it("deletes a site's favourites when the site is deleted, via the project_id index", () => {
    expect(plan("DELETE FROM user_favourite_projects WHERE project_id = ?")).toContain("idx_ufp_project");

    sqlite.exec(`
      INSERT INTO user_favourite_projects (user_id, project_id, created_at) VALUES
        ('u1', 'p1', 1), ('u2', 'p1', 1), ('u1', 'p2', 1);
      DELETE FROM projects WHERE id = 'p1';
    `);
    expect(sqlite.prepare("SELECT user_id, project_id FROM user_favourite_projects").all())
      .toEqual([{ user_id: "u1", project_id: "p2" }]);
  });
});
