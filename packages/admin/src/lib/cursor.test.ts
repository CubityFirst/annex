import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { encodeCursor, decodeCursor, keysetClause } from "./cursor";

describe("keyset cursor codec", () => {
  it("round-trips a (ts, id) position", () => {
    const cursor = { ts: "2026-05-17T12:34:56.000Z", id: "a1b2-c3d4" };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it("produces a url-safe token (no +, /, or =)", () => {
    const token = encodeCursor({ ts: "2026-05-17T00:00:00.000Z", id: "????>>>>" });
    expect(token).not.toMatch(/[+/=]/);
  });

  it("returns null for a malformed cursor", () => {
    expect(decodeCursor("not-base64-$$$")).toBeNull();
  });

  it("returns null when the shape is wrong", () => {
    const bad = btoa(JSON.stringify({ ts: 123 })).replace(/=+$/, "");
    expect(decodeCursor(bad)).toBeNull();
  });
});

describe("keysetClause", () => {
  it("is empty for a null cursor (first page)", () => {
    expect(keysetClause(null, "u.created_at", "u.id")).toEqual({ sql: "", binds: [] });
  });

  it("emits the predicate + binds with the given column names", () => {
    const cursor = { ts: "2026-05-17T12:34:56.000Z", id: "row-9" };
    const { sql, binds } = keysetClause(cursor, "p.created_at", "p.id");
    expect(sql).toBe("(p.created_at, p.id) < (?, ?)");
    expect(binds).toEqual([cursor.ts, cursor.id]);
  });

  // Real SQLite: walking pages of 2 over rows with tied timestamps must visit
  // every row exactly once, in (created_at DESC, id DESC) order, and the
  // predicate must seek the created_at index rather than scan it.
  function seeded() {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE t (id TEXT PRIMARY KEY, created_at TEXT NOT NULL); CREATE INDEX t_created_at ON t(created_at DESC);");
    const ins = db.prepare("INSERT INTO t (id, created_at) VALUES (?, ?)");
    for (const [id, ts] of [["a", "2026-01-01"], ["b", "2026-01-02"], ["c", "2026-01-02"], ["d", "2026-01-02"], ["e", "2026-01-03"]]) {
      ins.run(id, ts);
    }
    return db;
  }

  it("pages through tied timestamps without skipping or repeating rows", () => {
    const db = seeded();
    const seen: string[] = [];
    let cursor: { ts: string; id: string } | null = null;
    for (;;) {
      const k = keysetClause(cursor, "created_at", "id");
      const rows = db.prepare(
        `SELECT id, created_at FROM t ${k.sql ? `WHERE ${k.sql}` : ""} ORDER BY created_at DESC, id DESC LIMIT 2`,
      ).all(...k.binds) as Array<{ id: string; created_at: string }>;
      if (rows.length === 0) break;
      seen.push(...rows.map(r => r.id));
      const last = rows[rows.length - 1];
      cursor = { ts: last.created_at, id: last.id };
    }
    expect(seen).toEqual(["e", "d", "c", "b", "a"]);
  });

  it("plans as a range seek on the created_at index", () => {
    const db = seeded();
    const k = keysetClause({ ts: "2026-01-02", id: "c" }, "created_at", "id");
    const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT id FROM t WHERE ${k.sql} ORDER BY created_at DESC, id DESC LIMIT 2`)
      .all(...k.binds)
      .map(r => String(r.detail))
      .join("\n");
    expect(plan).toContain("SEARCH t USING INDEX t_created_at (created_at<?)");
  });
});
