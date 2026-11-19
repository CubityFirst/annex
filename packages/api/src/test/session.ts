// Test helper: seeds a users-mirror row + a live Annex session in a real
// SQLite main DB (see sqliteD1.ts) and returns a signed session token.
import type { DatabaseSync } from "node:sqlite";
import { signJwt } from "../account/jwt";

export const TEST_JWT_SECRET = "test-secret";

export async function seedSession(
  sqlite: DatabaseSync,
  opts: { userId: string; email?: string; name?: string; isAdmin?: boolean; kind?: "app" | "admin"; sid?: string; secret?: string },
): Promise<string> {
  const now = Date.now();
  const email = opts.email ?? `${opts.userId}@example.com`;
  const sid = opts.sid ?? `s-${opts.userId}`;
  sqlite.prepare(
    `INSERT OR IGNORE INTO users (id, email, name, is_admin, created_at, first_seen_at, synced_at)
     VALUES (?, ?, ?, ?, datetime('now'), ?, ?)`,
  ).run(opts.userId, email, opts.name ?? opts.userId, opts.isAdmin ? 1 : 0, now, now);
  sqlite.prepare(
    "INSERT INTO sessions (id, user_id, kind, created_at, expires_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(sid, opts.userId, opts.kind ?? "app", now, now + 3_600_000, now);
  return signJwt({ userId: opts.userId, email, expiresAt: now + 3_600_000, isAdmin: opts.isAdmin, sid }, opts.secret ?? TEST_JWT_SECRET);
}
