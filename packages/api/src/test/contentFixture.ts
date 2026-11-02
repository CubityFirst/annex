// Shared real-SQLite fixture for the content-listing tests (docs list, folder
// list, /projects/:id/contents, graph, /v1/docs). Built so limited-member
// visibility can be checked against the full schema:
//
// site p1 (home doc = d-home)
//   fa/                 d1  (shared with user-1)
//     fb/               d2  (shared with user-1)
//       fg/             d6  (unshared - deep nesting for subtree counts)
//   fc/                 d3  (shared with user-2 only)
//   (root)              d-home (unshared), d4 (shared with user-1), d5 (unshared)
// site p2
//   px/                 x1  - user-1 holds a share row on it that claims
//                             project p1 (a stray/mis-scoped row; must never
//                             surface in p1 listings)
//
// user-1 is a `limited` member of p1; user-2 is a `limited` member of p1.

import type { DatabaseSync } from "node:sqlite";

export const T0 = "2026-01-01T00:00:00.000Z";

export const LIMITED_USER = "user-1";
export const SHARED_WITH_LIMITED = ["d1", "d2", "d4"];
export const ALL_P1_DOCS = ["d-home", "d1", "d2", "d3", "d4", "d5", "d6"];

export function seedContentFixture(sqlite: DatabaseSync): void {
  const exec = (sql: string, ...args: (string | null)[]) => sqlite.prepare(sql).run(...args);
  exec("INSERT INTO projects (id, name, owner_id, created_at) VALUES ('p1', 'Site', 'owner', ?), ('p2', 'Other', 'owner', ?)", T0, T0);
  for (const [id, user] of [["m1", "user-1"], ["m2", "user-2"]]) {
    exec(
      "INSERT INTO project_members (id, project_id, user_id, email, name, role, invited_by, created_at, accepted) VALUES (?, 'p1', ?, ?, ?, 'limited', 'owner', ?, 1)",
      id, user, `${user}@example.com`, user, T0,
    );
  }
  for (const [id, project, parent] of [
    ["fa", "p1", null], ["fb", "p1", "fa"], ["fg", "p1", "fb"], ["fc", "p1", null], ["px", "p2", null],
  ] as const) {
    exec("INSERT INTO folders (id, name, project_id, parent_id, created_at) VALUES (?, ?, ?, ?, ?)", id, id.toUpperCase(), project, parent, T0);
  }
  for (const [id, project, folder] of [
    ["d-home", "p1", null], ["d1", "p1", "fa"], ["d2", "p1", "fb"], ["d6", "p1", "fg"], ["d3", "p1", "fc"],
    ["d4", "p1", null], ["d5", "p1", null], ["x1", "p2", "px"],
  ] as const) {
    exec(
      "INSERT INTO docs (id, title, project_id, author_id, folder_id, created_at, updated_at) VALUES (?, ?, ?, 'owner', ?, ?, ?)",
      id, `Title ${id}`, project, folder, T0, T0,
    );
  }
  exec("UPDATE projects SET home_doc_id = 'd-home' WHERE id = 'p1'");
  for (const [id, doc, user, project] of [
    ["s1", "d1", "user-1", "p1"], ["s2", "d2", "user-1", "p1"], ["s4", "d4", "user-1", "p1"],
    ["s3", "d3", "user-2", "p1"],
    ["sx", "x1", "user-1", "p1"], // stray: doc lives in p2
  ]) {
    exec("INSERT INTO doc_shares (id, doc_id, user_id, project_id, granted_by, created_at) VALUES (?, ?, ?, ?, 'owner', ?)", id, doc, user, project, T0);
  }
}
