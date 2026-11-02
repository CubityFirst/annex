import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSqliteD1 } from "../test/sqliteD1";
import {
  sanitizeFtsQuery, ftsSiteToken, siteFtsMatch, upsertFtsRow, ftsUpsertStatements, deleteFtsRow,
  deleteFtsForProject, ftsPruneProjectStatements,
} from "./fts";

describe("sanitizeFtsQuery", () => {
  it("wraps each word in double quotes and prefix-stars the last", () => {
    expect(sanitizeFtsQuery("hello world")).toBe('"hello" "world"*');
  });

  it("returns empty-string literal for an empty query", () => {
    expect(sanitizeFtsQuery("")).toBe('""');
  });

  it("returns empty-string literal for whitespace-only query", () => {
    expect(sanitizeFtsQuery("   ")).toBe('""');
  });

  it("strips a user-supplied wildcard * (the prefix star is our own)", () => {
    expect(sanitizeFtsQuery("hello*")).toBe('"hello"*');
  });

  it("splits on * between words", () => {
    expect(sanitizeFtsQuery("hello*world")).toBe('"hello" "world"*');
  });

  it("strips double quotes and re-quotes each word", () => {
    expect(sanitizeFtsQuery('"hello"')).toBe('"hello"*');
  });

  it("splits on single quotes, turning 'it's' into two tokens", () => {
    // The quote is replaced with a space, splitting into "it" and "s".
    expect(sanitizeFtsQuery("it's")).toBe('"it" "s"*');
  });

  it("strips parentheses", () => {
    expect(sanitizeFtsQuery("(hello world)")).toBe('"hello" "world"*');
  });

  it("strips caret ^", () => {
    expect(sanitizeFtsQuery("hello^world")).toBe('"hello" "world"*');
  });

  it("strips colon :", () => {
    expect(sanitizeFtsQuery("field:value")).toBe('"field" "value"*');
  });

  it("strips tilde ~", () => {
    expect(sanitizeFtsQuery("hello~2")).toBe('"hello" "2"*');
  });

  it("strips hyphen -", () => {
    expect(sanitizeFtsQuery("hello-world")).toBe('"hello" "world"*');
  });

  it("handles extra whitespace between words", () => {
    expect(sanitizeFtsQuery("  foo   bar  ")).toBe('"foo" "bar"*');
  });

  it("handles a single word", () => {
    expect(sanitizeFtsQuery("docs")).toBe('"docs"*');
  });
});

// ---------------------------------------------------------------------------
// Real SQLite (node:sqlite, FTS5) against the migrated schema.
// ---------------------------------------------------------------------------

const T0 = "2026-10-01T00:00:00.000Z";
const P1 = "11111111-2222-3333-4444-555555555555";
const P2 = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function seedSites(sqlite: DatabaseSync) {
  for (const id of [P1, P2]) {
    sqlite.prepare("INSERT INTO projects (id, name, owner_id, created_at) VALUES (?, ?, 'u1', ?)").run(id, id, T0);
  }
}
function seedDoc(sqlite: DatabaseSync, id: string, projectId: string, title = `Title ${id}`) {
  sqlite.prepare(
    "INSERT INTO docs (id, title, project_id, author_id, created_at, updated_at) VALUES (?, ?, ?, 'u1', ?, ?)",
  ).run(id, title, projectId, T0, T0);
}
const all = (sqlite: DatabaseSync, sql: string, ...args: (string | number | null)[]) =>
  sqlite.prepare(sql).all(...args).map(r => ({ ...r }));

// The search route's doc query, minus the joins and the belt-and-braces
// `f.project_id = ?` re-check: site isolation must come from the MATCH alone.
function search(sqlite: DatabaseSync, projectId: string, q: string) {
  return all(
    sqlite,
    `SELECT f.doc_id, snippet(docs_fts, 1, '<mark>', '</mark>', '...', 24) AS excerpt,
            bm25(docs_fts, 5.0, 1.0, 0.0) AS rank
     FROM docs_fts f WHERE docs_fts MATCH ? ORDER BY rank`,
    siteFtsMatch(projectId, q),
  );
}

function consistency(sqlite: DatabaseSync) {
  const n = (sql: string) => Number(sqlite.prepare(sql).get()!.n);
  return {
    fts: n("SELECT count(*) AS n FROM docs_fts"),
    map: n("SELECT count(*) AS n FROM docs_fts_map"),
    linked: n("SELECT count(*) AS n FROM docs_fts_map m JOIN docs_fts f ON f.rowid = m.rid AND f.doc_id = m.doc_id"),
  };
}

describe("ftsSiteToken / siteFtsMatch", () => {
  it("matches SQLite's hex() for ASCII and non-ASCII ids", () => {
    const { sqlite } = createSqliteD1();
    for (const id of [P1, "p1", "sité-ü-漢"]) {
      expect(ftsSiteToken(id)).toBe(sqlite.prepare("SELECT hex(?) AS h").get(id)!.h);
    }
  });

  it("scopes to the site token and column-filters every user term", () => {
    expect(siteFtsMatch("p1", "hello world")).toBe('pid:"7031" AND {title body}:"hello" AND {title body}:"world"*');
    // User input can't smuggle in a column filter or operator: each word is
    // a quoted phrase under the title/body filter.
    expect(siteFtsMatch("p1", "pid:x OR {title}")).toBe(
      'pid:"7031" AND {title body}:"pid" AND {title body}:"x" AND {title body}:"OR" AND {title body}:"{title}"*',
    );
    expect(siteFtsMatch("p1", "  ")).toBe('pid:"7031" AND {title body}:""');
  });
});

describe("docs_fts writes and site-scoped search (real SQLite)", () => {
  let db: D1Database;
  let sqlite: DatabaseSync;

  beforeEach(() => {
    ({ db, sqlite } = createSqliteD1());
    seedSites(sqlite);
    seedDoc(sqlite, "a1", P1);
    seedDoc(sqlite, "a2", P1);
    seedDoc(sqlite, "b1", P2);
  });

  it("only returns the requested site's docs", async () => {
    await upsertFtsRow(db, "a1", P1, "Dragons", "The **red** dragon sleeps");
    await upsertFtsRow(db, "a2", P1, "Notes", "nothing here");
    await upsertFtsRow(db, "b1", P2, "Dragons", "A blue dragon");
    expect(search(sqlite, P1, "drag").map(r => r.doc_id)).toEqual(["a1"]);
    expect(search(sqlite, P2, "drag").map(r => r.doc_id)).toEqual(["b1"]);
    expect(search(sqlite, P1, "drag")[0].excerpt).toBe("The red <mark>dragon</mark> sleeps");
  });

  it("runs operator-looking and empty input as plain terms without erroring", async () => {
    await upsertFtsRow(db, "a1", P1, "Plain", "nothing to see");
    for (const q of ["pid:x OR {title}", "NEAR(a b)", "a AND NOT b", ".", "  ", '"unterminated']) {
      expect(() => search(sqlite, P1, q)).not.toThrow();
    }
    expect(search(sqlite, P1, "  ")).toEqual([]);
  });

  it("never matches the site token itself, even on a prefix of it", async () => {
    await upsertFtsRow(db, "a1", P1, "Plain", "nothing to see");
    // P1's token starts "3131..."; a bare `"3"*` over every column would hit it.
    expect(ftsSiteToken(P1).startsWith("3")).toBe(true);
    expect(search(sqlite, P1, "3")).toEqual([]);
    expect(search(sqlite, P1, ftsSiteToken(P1))).toEqual([]);
  });

  it("replaces a doc's row on update instead of duplicating it", async () => {
    await upsertFtsRow(db, "a1", P1, "First", "alpha");
    await upsertFtsRow(db, "a1", P1, "Second", "beta");
    await upsertFtsRow(db, "a1", P1, "Third", "gamma");
    expect(all(sqlite, "SELECT doc_id, title, body, pid, project_id FROM docs_fts")).toEqual([
      { doc_id: "a1", title: "Third", body: "gamma", pid: ftsSiteToken(P1), project_id: P1 },
    ]);
    expect(consistency(sqlite)).toEqual({ fts: 1, map: 1, linked: 1 });
    expect(search(sqlite, P1, "alpha")).toEqual([]);
    expect(search(sqlite, P1, "gamma").map(r => r.doc_id)).toEqual(["a1"]);
  });

  it("ftsUpsertStatements composes into a caller's batch", async () => {
    await db.batch([
      ...ftsUpsertStatements(db, "a1", P1, "One", "first"),
      ...ftsUpsertStatements(db, "a2", P1, "Two", "second"),
      ...ftsUpsertStatements(db, "a1", P1, "One", "first again"),
    ]);
    expect(all(sqlite, "SELECT doc_id, body FROM docs_fts ORDER BY doc_id")).toEqual([
      { doc_id: "a1", body: "first again" },
      { doc_id: "a2", body: "second" },
    ]);
    expect(consistency(sqlite)).toEqual({ fts: 2, map: 2, linked: 2 });
  });

  it("deleteFtsRow removes one doc's row and map entry only", async () => {
    await upsertFtsRow(db, "a1", P1, "One", "x");
    await upsertFtsRow(db, "a2", P1, "Two", "x");
    await deleteFtsRow(db, "a1");
    await deleteFtsRow(db, "never-indexed");
    expect(all(sqlite, "SELECT doc_id FROM docs_fts")).toEqual([{ doc_id: "a2" }]);
    expect(consistency(sqlite)).toEqual({ fts: 1, map: 1, linked: 1 });
  });

  it("deleteFtsForProject removes only that site's rows and map entries", async () => {
    await upsertFtsRow(db, "a1", P1, "One", "x");
    await upsertFtsRow(db, "a2", P1, "Two", "x");
    await upsertFtsRow(db, "b1", P2, "Three", "x");
    await deleteFtsForProject(db, P1);
    expect(all(sqlite, "SELECT doc_id FROM docs_fts")).toEqual([{ doc_id: "b1" }]);
    expect(all(sqlite, "SELECT doc_id FROM docs_fts_map")).toEqual([{ doc_id: "b1" }]);
  });

  it("the post-reindex prune drops only the site's rows for docs no longer in it", async () => {
    await upsertFtsRow(db, "a1", P1, "One", "x");
    await upsertFtsRow(db, "a2", P1, "Two", "x");
    await upsertFtsRow(db, "b1", P2, "Three", "x");
    sqlite.exec("DELETE FROM docs WHERE id IN ('a2', 'b1')");
    await db.batch(ftsPruneProjectStatements(db, P1));
    expect(all(sqlite, "SELECT doc_id FROM docs_fts ORDER BY doc_id")).toEqual([{ doc_id: "a1" }, { doc_id: "b1" }]);
    expect(consistency(sqlite)).toEqual({ fts: 2, map: 2, linked: 2 });
  });

  it("tolerates rows written by pre-0064 code (no pid, no map row) without touching other docs", async () => {
    await upsertFtsRow(db, "a1", P1, "One", "kept");
    const a1Rid = Number(sqlite.prepare("SELECT rid FROM docs_fts_map WHERE doc_id = 'a1'").get()!.rid);
    // Old code: `DELETE ... WHERE doc_id = ?` + plain INSERT. Delete a1's row
    // and put b1's old-style row at a1's old rowid, so a1's map row is stale.
    sqlite.exec("DELETE FROM docs_fts WHERE doc_id = 'a1'");
    sqlite.prepare("INSERT INTO docs_fts (rowid, doc_id, project_id, title, body) VALUES (?, 'b1', ?, 'Old', 'legacy')")
      .run(a1Rid, P2);
    // Invisible to site-scoped search until repaired (no pid)...
    expect(search(sqlite, P2, "legacy")).toEqual([]);
    // ...and a1's upsert must not delete b1's row through the stale map entry.
    await upsertFtsRow(db, "a1", P1, "One", "fresh");
    expect(all(sqlite, "SELECT doc_id, body FROM docs_fts ORDER BY doc_id")).toEqual([
      { doc_id: "a1", body: "fresh" },
      { doc_id: "b1", body: "legacy" },
    ]);
    expect(all(sqlite, "SELECT doc_id FROM docs_fts_map")).toEqual([{ doc_id: "a1" }]);
  });
});

describe("scripts/repair-docs-fts.sql", () => {
  it("reconciles rows written by pre-0064 code and is idempotent", async () => {
    const { db, sqlite } = createSqliteD1();
    seedSites(sqlite);
    for (const [id, p] of [["a1", P1], ["a2", P1], ["a3", P1], ["b1", P2]] as const) seedDoc(sqlite, id, p);
    await upsertFtsRow(db, "a2", P1, "A2", "will be rewritten by old code");
    await upsertFtsRow(db, "b1", P2, "B1", "untouched");
    const oldInsert = sqlite.prepare("INSERT INTO docs_fts (doc_id, project_id, title, body) VALUES (?, ?, ?, ?)");
    // a1: an old-code row, then a later new-code save -> the old row is stale.
    oldInsert.run("a1", P1, "A1", "stale old-code body");
    await upsertFtsRow(db, "a1", P1, "A1", "mapped current");
    // a2: rewritten by old code -> its map row is stale, the new row unmapped.
    sqlite.exec("DELETE FROM docs_fts WHERE doc_id = 'a2'");
    oldInsert.run("a2", P1, "A2", "old code wrote this last");
    // a3: only ever written by old code (two racing inserts).
    oldInsert.run("a3", P1, "A3", "first");
    oldInsert.run("a3", P1, "A3", "second");
    // An orphan for a doc that no longer exists.
    oldInsert.run("gone", P1, "Gone", "orphan");

    const repair = readFileSync(fileURLToPath(new URL("../../scripts/repair-docs-fts.sql", import.meta.url)), "utf8");
    const snapshot = () => all(sqlite, "SELECT doc_id, body, pid FROM docs_fts ORDER BY doc_id");
    // First run exactly as the runbook in the script's header feeds it to
    // `wrangler d1 execute --command`: full-line comments stripped, one line.
    const runbookForm = repair.split(/\r?\n/).filter(l => !l.startsWith("--")).join(" ");
    expect(runbookForm).not.toContain("--");
    sqlite.exec(runbookForm);
    const once = snapshot();
    expect(once).toEqual([
      { doc_id: "a1", body: "mapped current", pid: ftsSiteToken(P1) },
      { doc_id: "a2", body: "old code wrote this last", pid: ftsSiteToken(P1) },
      { doc_id: "a3", body: "second", pid: ftsSiteToken(P1) },
      { doc_id: "b1", body: "untouched", pid: ftsSiteToken(P2) },
    ]);
    expect(consistency(sqlite)).toEqual({ fts: 4, map: 4, linked: 4 });
    expect(search(sqlite, P1, "old code").map(r => r.doc_id)).toEqual(["a2"]);

    sqlite.exec(repair);
    expect(snapshot()).toEqual(once);
    expect(consistency(sqlite)).toEqual({ fts: 4, map: 4, linked: 4 });
  });
});

describe("migration 0064_rebuild_docs_fts", () => {
  const dir = fileURLToPath(new URL("../../migrations", import.meta.url));
  const before = readdirSync(dir).filter(f => f.endsWith(".sql") && f < "0064_").sort();

  it("copies live rows with rowids and contents preserved, drops orphans and duplicates, builds the map", () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys = OFF");
    for (const f of before) sqlite.exec(readFileSync(join(dir, f), "utf8"));
    seedSites(sqlite);
    for (const [id, p] of [["d1", P1], ["d2", P1], ["d3", P2], ["d4", P2]] as const) seedDoc(sqlite, id, p);
    const ins = sqlite.prepare("INSERT INTO docs_fts (rowid, doc_id, project_id, title, body) VALUES (?, ?, ?, ?, ?)");
    ins.run(5, "d1", P1, "Dragon lore", "red dragons and more");
    ins.run(9, "d2", P1, "Notes", "plain notes");
    ins.run(12, "d3", P2, "Dragon facts", "blue dragon");
    ins.run(14, "d4", P2, "Dup", "older duplicate");
    ins.run(17, "d4", P2, "Dup", "newer duplicate");
    ins.run(20, "binned-or-leaked", P1, "Gone", "orphan row");

    sqlite.exec(readFileSync(join(dir, "0064_rebuild_docs_fts.sql"), "utf8"));

    expect(all(sqlite, "SELECT rowid AS r, doc_id, project_id, title, body, pid FROM docs_fts ORDER BY rowid")).toEqual([
      { r: 5, doc_id: "d1", project_id: P1, title: "Dragon lore", body: "red dragons and more", pid: ftsSiteToken(P1) },
      { r: 9, doc_id: "d2", project_id: P1, title: "Notes", body: "plain notes", pid: ftsSiteToken(P1) },
      { r: 12, doc_id: "d3", project_id: P2, title: "Dragon facts", body: "blue dragon", pid: ftsSiteToken(P2) },
      { r: 17, doc_id: "d4", project_id: P2, title: "Dup", body: "newer duplicate", pid: ftsSiteToken(P2) },
    ]);
    expect(all(sqlite, "SELECT rid, doc_id FROM docs_fts_map ORDER BY rid")).toEqual([
      { rid: 5, doc_id: "d1" }, { rid: 9, doc_id: "d2" }, { rid: 12, doc_id: "d3" }, { rid: 17, doc_id: "d4" },
    ]);
    // No temp table or its shadow tables left behind.
    expect(all(sqlite, "SELECT name FROM sqlite_master WHERE name LIKE 'docs_fts_new%'")).toEqual([]);
    // The rebuilt index serves site-scoped search, with the usual snippet.
    expect(search(sqlite, P1, "dragon")).toEqual([
      { doc_id: "d1", excerpt: "red <mark>dragons</mark> and more", rank: expect.any(Number) },
    ]);
    expect(search(sqlite, P2, "dragon").map(r => r.doc_id)).toEqual(["d3"]);
  });
});
