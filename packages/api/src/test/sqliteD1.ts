// Test-only D1 stand-in backed by Node's built-in SQLite, with every migration
// in packages/api/migrations applied. For logic whose correctness lives in the
// SQL itself (cascades, recursive CTEs, batch atomicity) a queue-based mock
// can't catch anything; this runs the real statements against the real schema
// without needing the `pnpm dev` stack the integration suites require.
//
// Covers the D1 surface our code uses: prepare/bind/first/all/run/raw and
// batch (a transaction, rolled back on the first failure - as D1's is).

import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations", import.meta.url));

type Row = Record<string, unknown>;

function toSqlValue(v: unknown): SQLInputValue {
  if (v === undefined) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  return v as SQLInputValue;
}

class Stmt {
  constructor(private db: DatabaseSync, readonly sql: string, readonly args: unknown[] = []) {}

  bind(...args: unknown[]): Stmt {
    // D1's bind returns a new statement; the original stays reusable.
    return new Stmt(this.db, this.sql, args);
  }

  private params(): SQLInputValue[] {
    return this.args.map(toSqlValue);
  }

  execAll(): Row[] {
    return this.db.prepare(this.sql).all(...this.params()).map(r => ({ ...r }));
  }

  execRun(): { changes: number } {
    const res = this.db.prepare(this.sql).run(...this.params());
    return { changes: Number(res.changes) };
  }

  async first<T = Row>(col?: string): Promise<T | null> {
    const row = this.execAll()[0];
    if (!row) return null;
    return (col ? row[col] : row) as T;
  }

  async all<T = Row>(): Promise<{ results: T[]; success: true; meta: Record<string, unknown> }> {
    return { results: this.execAll() as T[], success: true, meta: {} };
  }

  async run(): Promise<{ success: true; meta: { changes: number } }> {
    return { success: true, meta: this.execRun() };
  }

  async raw<T = unknown[]>(): Promise<T[]> {
    return this.execAll().map(r => Object.values(r)) as T[];
  }
}

export interface SqliteD1 {
  db: D1Database;
  // Direct handle for seeding/asserting in tests.
  sqlite: DatabaseSync;
}

export function createSqliteD1(): SqliteD1 {
  const sqlite = new DatabaseSync(":memory:");
  // Several migrations rebuild tables (CREATE new / INSERT SELECT / DROP /
  // RENAME); apply them with FK enforcement off, then turn it on as D1 has it.
  sqlite.exec("PRAGMA foreign_keys = OFF");
  for (const file of readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
  }
  sqlite.exec("PRAGMA foreign_keys = ON");

  const db = {
    prepare: (sql: string) => new Stmt(sqlite, sql),
    async batch(stmts: Stmt[]) {
      sqlite.exec("BEGIN");
      try {
        const out = stmts.map(s => {
          const isRead = /^\s*(SELECT|WITH|PRAGMA)\b/i.test(s.sql);
          return isRead
            ? { results: s.execAll(), success: true, meta: {} }
            : { results: [], success: true, meta: s.execRun() };
        });
        sqlite.exec("COMMIT");
        return out;
      } catch (err) {
        sqlite.exec("ROLLBACK");
        throw err;
      }
    },
    async exec(sql: string) {
      sqlite.exec(sql);
      return { count: 0, duration: 0 };
    },
  };
  return { db: db as unknown as D1Database, sqlite };
}
