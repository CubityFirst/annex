// GET /v1/docs listing, run against real SQLite (API + auth migrations) so the
// doc_shares-driven query for limited keys is exercised end to end.

import { describe, it, expect, beforeEach } from "vitest";
import { fileURLToPath } from "node:url";
import { createSqliteD1, type SqliteD1 } from "../test/sqliteD1";
import { seedContentFixture, ALL_P1_DOCS, SHARED_WITH_LIMITED } from "../test/contentFixture";
import { handlePublicApi } from "./v1";
import { hashApiKey } from "../lib/apiKeys";
import type { Env } from "../index";

const AUTH_MIGRATIONS = fileURLToPath(new URL("../../../auth/migrations", import.meta.url));
const LIMITED_SECRET = "annx_limitedListTestSecret_0123456789abcdefghi";
const EDITOR_SECRET = "annx_editorListTestSecret_0123456789abcdefghij";

let api: SqliteD1;
let auth: SqliteD1;

async function insertKey(id: string, userId: string, secret: string) {
  api.sqlite.prepare(
    `INSERT INTO api_keys (id, user_id, project_id, name, key_hash, key_prefix, scope, can_invite, created_at, expires_at)
     VALUES (?, ?, 'p1', ?, ?, ?, 'read', 0, '2026-10-01T00:00:00.000Z', NULL)`,
  ).run(id, userId, `key ${id}`, await hashApiKey(secret), secret.slice(0, 11));
}

async function listIds(secret: string): Promise<string[]> {
  const url = new URL("http://localhost/v1/docs");
  const env = { DB: api.db, AUTH_DB: auth.db } as unknown as Env;
  const res = await handlePublicApi(new Request(url, { headers: { Authorization: `Bearer ${secret}` } }), env, url);
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: { id: string }[] }).data.map(d => d.id);
}

beforeEach(async () => {
  api = createSqliteD1();
  auth = createSqliteD1(AUTH_MIGRATIONS);
  seedContentFixture(api.sqlite);
  for (const u of ["user-1", "editor-1"]) {
    auth.sqlite.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, 'x', datetime('now'))").run(u, `${u}@example.com`, u);
  }
  api.sqlite.prepare(
    "INSERT INTO project_members (id, project_id, user_id, email, name, role, invited_by, created_at, accepted) VALUES ('me', 'p1', 'editor-1', 'e@example.com', 'Editor', 'editor', 'owner', datetime('now'), 1)",
  ).run();
  await insertKey("k-limited", "user-1", LIMITED_SECRET);
  await insertKey("k-editor", "editor-1", EDITOR_SECRET);
});

describe("GET /v1/docs", () => {
  it("lists only a limited key owner's in-site shares", async () => {
    // Not user-2's d3, not the stray share row on p2's x1.
    expect((await listIds(LIMITED_SECRET)).sort()).toEqual(SHARED_WITH_LIMITED);
  });

  it("lists every site doc for an editor key", async () => {
    expect((await listIds(EDITOR_SECRET)).sort()).toEqual([...ALL_P1_DOCS].sort());
  });
});
