import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { buildAuditListQuery, AUDIT_ACTIONS_SQL } from "./audit";
import { createSqliteD1 } from "../../../api/src/test/sqliteD1";

const AUTH_MIGRATIONS = fileURLToPath(new URL("../../../auth/migrations", import.meta.url));

const CURSOR = { ts: "2026-05-17 12:34:56", id: "a1b2-c3d4" };

const NO_FILTERS = { actions: [] as string[], q: null };

describe("buildAuditListQuery", () => {
  it("has no WHERE and no binds for the first unfiltered page", () => {
    const { sql, binds } = buildAuditListQuery(null, NO_FILTERS);
    expect(sql).not.toContain("WHERE");
    expect(binds).toEqual([]);
    expect(sql).toContain("ORDER BY created_at DESC, id DESC");
  });

  it("emits the keyset predicate and binds for a cursor", () => {
    const { sql, binds } = buildAuditListQuery(CURSOR, NO_FILTERS);
    expect(sql).toContain("WHERE (created_at, id) < (?, ?)");
    expect(sql).not.toMatch(/action (=|IN)/);
    expect(binds).toEqual([CURSOR.ts, CURSOR.id]);
  });

  it("emits an equality (index seek) for one action", () => {
    const { sql, binds } = buildAuditListQuery(null, { actions: ["user.ink.grant"], q: null });
    expect(sql).toContain("WHERE action = ?");
    expect(binds).toEqual(["user.ink.grant"]);
  });

  it("emits one placeholder per action for a mixed selection", () => {
    const { sql, binds } = buildAuditListQuery(null, {
      actions: ["user.ink.grant", "project.delete", "oauth_client.create"],
      q: null,
    });
    expect(sql).toContain("action IN (?, ?, ?)");
    expect(binds).toEqual(["user.ink.grant", "project.delete", "oauth_client.create"]);
  });

  it("emits a user-scope search across actor + target with one bind each", () => {
    const { sql, binds } = buildAuditListQuery(null, { actions: [], q: "alice@example.com" });
    expect(sql).toContain(
      "(actor_email LIKE ? ESCAPE '\\' OR actor_user_id LIKE ? ESCAPE '\\' OR target_id LIKE ? ESCAPE '\\')",
    );
    expect(binds).toEqual([
      "%alice@example.com%",
      "%alice@example.com%",
      "%alice@example.com%",
    ]);
  });

  it("escapes LIKE wildcards in the user-scope search", () => {
    const { binds } = buildAuditListQuery(null, { actions: [], q: "50%_x" });
    expect(binds).toEqual(["%50\\%\\_x%", "%50\\%\\_x%", "%50\\%\\_x%"]);
  });

  it("AND-combines cursor + actions + search with binds in SQL order", () => {
    const { sql, binds } = buildAuditListQuery(CURSOR, {
      actions: ["project.delete"],
      q: "bob",
    });
    expect(sql).toContain(
      "(created_at, id) < (?, ?) AND action = ? AND (actor_email LIKE ? ESCAPE '\\' OR actor_user_id LIKE ? ESCAPE '\\' OR target_id LIKE ? ESCAPE '\\')",
    );
    expect(binds).toEqual([
      CURSOR.ts,
      CURSOR.id,
      "project.delete",
      "%bob%",
      "%bob%",
      "%bob%",
    ]);
  });
});

// Real SQLite (every auth migration applied): the list query must page an
// action-filtered log correctly, and the actions query must return exactly
// the distinct actions, sorted.
describe("audit queries against the real schema", () => {
  function seed() {
    const { sqlite } = createSqliteD1(AUTH_MIGRATIONS);
    const ins = sqlite.prepare(
      "INSERT INTO admin_audit_log (id, actor_user_id, actor_email, action, target_type, created_at) VALUES (?, 'a', 'a@x.com', ?, 'user', ?)",
    );
    // Tied timestamps across page boundaries, interleaved actions.
    const rows: Array<[string, string, string]> = [
      ["r1", "user.delete", "2026-01-01 00:00:00"],
      ["r2", "project.delete", "2026-01-01 00:00:00"],
      ["r3", "user.delete", "2026-01-02 00:00:00"],
      ["r4", "user.delete", "2026-01-02 00:00:00"],
      ["r5", "oauth_client.create", "2026-01-02 00:00:00"],
      ["r6", "user.delete", "2026-01-03 00:00:00"],
      ["r7", "project.delete", "2026-01-04 00:00:00"],
    ];
    for (const r of rows) ins.run(...r);
    return sqlite;
  }

  function pageAll(sqlite: ReturnType<typeof seed>, actions: string[], pageSize: number): string[] {
    const seen: string[] = [];
    let cursor: { ts: string; id: string } | null = null;
    for (;;) {
      const { sql, binds } = buildAuditListQuery(cursor, { actions, q: null });
      const rows = sqlite.prepare(sql).all(...(binds as string[]), pageSize) as Array<{ id: string; created_at: string }>;
      if (rows.length === 0) return seen;
      seen.push(...rows.map(r => r.id));
      const last = rows[rows.length - 1];
      cursor = { ts: last.created_at, id: last.id };
    }
  }

  it("pages a single-action filter newest-first without skips or repeats", () => {
    expect(pageAll(seed(), ["user.delete"], 2)).toEqual(["r6", "r4", "r3", "r1"]);
  });

  it("pages a multi-action filter newest-first without skips or repeats", () => {
    expect(pageAll(seed(), ["project.delete", "oauth_client.create"], 2)).toEqual(["r7", "r5", "r2"]);
  });

  it("pages the unfiltered log newest-first", () => {
    expect(pageAll(seed(), [], 3)).toEqual(["r7", "r6", "r5", "r4", "r3", "r2", "r1"]);
  });

  it("lists distinct actions in ascending order", () => {
    const rows = seed().prepare(AUDIT_ACTIONS_SQL).all();
    expect(rows.map(r => r.action)).toEqual(["oauth_client.create", "project.delete", "user.delete"]);
  });

  it("lists no actions for an empty log", () => {
    const { sqlite } = createSqliteD1(AUTH_MIGRATIONS);
    expect(sqlite.prepare(AUDIT_ACTIONS_SQL).all()).toEqual([]);
  });
});
