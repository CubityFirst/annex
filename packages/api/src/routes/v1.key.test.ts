// GET /v1/key (introspection) and DELETE /v1/key (self-revocation), run
// against real SQLite with every API + auth migration applied, so the actual
// hash lookup, JOINs and the live-membership floor are exercised end to end.

import { describe, it, expect, beforeEach } from "vitest";
import { fileURLToPath } from "node:url";
import { createSqliteD1, type SqliteD1 } from "../test/sqliteD1";
import { handlePublicApi } from "./v1";
import { hashApiKey } from "../lib/apiKeys";
import type { Env } from "../index";

const AUTH_MIGRATIONS = fileURLToPath(new URL("../../../auth/migrations", import.meta.url));

const SECRET = "annx_selfRevokeTestSecret_0123456789abcdefghijk";
const OTHER_SECRET = "annx_otherKeyStaysAlive_0123456789abcdefghijklm";

let api: SqliteD1;
let auth: SqliteD1;
let flagEnabled: boolean;

function makeEnv(): Env {
  return {
    DB: api.db,
    AUTH_DB: auth.db,
    FLAGS: { getBooleanValue: async () => flagEnabled },
  } as unknown as Env;
}

function call(method: string, path: string, token?: string) {
  const url = new URL(`http://localhost${path}`);
  const headers: Record<string, string> = {};
  if (token !== undefined) headers.Authorization = `Bearer ${token}`;
  return handlePublicApi(new Request(url, { method, headers }), makeEnv(), url);
}

async function insertKey(id: string, secret: string, opts: { scope?: string; canInvite?: boolean; expiresAt?: string | null } = {}) {
  api.sqlite.prepare(
    `INSERT INTO api_keys (id, user_id, project_id, name, key_hash, key_prefix, scope, can_invite, created_at, expires_at)
     VALUES (?, 'u1', 'p1', ?, ?, ?, ?, ?, '2026-10-01T00:00:00.000Z', ?)`,
  ).run(id, `key ${id}`, await hashApiKey(secret), secret.slice(0, 11), opts.scope ?? "read", opts.canInvite ? 1 : 0, opts.expiresAt ?? null);
}

function revokedAt(id: string): string | null {
  const row = api.sqlite.prepare("SELECT revoked_at FROM api_keys WHERE id = ?").get(id) as { revoked_at: string | null };
  return row.revoked_at;
}

beforeEach(async () => {
  flagEnabled = true;
  api = createSqliteD1();
  auth = createSqliteD1(AUTH_MIGRATIONS);
  auth.sqlite.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES ('u1', 'u1@example.com', 'User One', 'x', datetime('now'))").run();
  api.sqlite.prepare("INSERT INTO projects (id, name, vanity_slug, owner_id, created_at) VALUES ('p1', 'Handbook', 'handbook', 'u1', datetime('now'))").run();
  api.sqlite.prepare(
    "INSERT INTO project_members (id, project_id, user_id, email, name, role, invited_by, created_at, accepted) VALUES ('m1', 'p1', 'u1', 'u1@example.com', 'User One', 'editor', 'u1', datetime('now'), 1)",
  ).run();
  await insertKey("k1", SECRET, { scope: "readwrite" });
  await insertKey("k2", OTHER_SECRET);
});

describe("GET /v1/key", () => {
  it("describes the calling key's site, ceiling and the owner's live role", async () => {
    const res = await call("GET", "/v1/key", SECRET);
    expect(res.status).toBe(200);
    const body = await res.json() as { data: Record<string, unknown> };
    expect(body.data).toMatchObject({
      id: "k1",
      name: "key k1",
      scope: "readwrite",
      canInvite: false,
      role: "editor",
      site: { id: "p1", name: "Handbook", vanitySlug: "handbook" },
    });
    // Never echoes the secret or its hash.
    expect(JSON.stringify(body)).not.toContain(SECRET);
    expect(body.data).not.toHaveProperty("keyHash");
  });

  it("401s without a key, with a JWT-shaped token, or with an unknown key", async () => {
    expect((await call("GET", "/v1/key")).status).toBe(401);
    expect((await call("GET", "/v1/key", "a.b.c")).status).toBe(401);
    expect((await call("GET", "/v1/key", "annx_nope")).status).toBe(401);
  });

  it("403s (and reveals no site details) once the owner loses access", async () => {
    api.sqlite.prepare("DELETE FROM project_members WHERE id = 'm1'").run();
    const res = await call("GET", "/v1/key", SECRET);
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("Handbook");
  });

  it("is subject to the killswitch like every other read", async () => {
    flagEnabled = false;
    expect((await call("GET", "/v1/key", SECRET)).status).toBe(503);
  });
});

describe("DELETE /v1/key (self-revocation)", () => {
  it("revokes exactly the presented key; it stops authenticating, others don't", async () => {
    const res = await call("DELETE", "/v1/key", SECRET);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: { revoked: true } });
    expect(revokedAt("k1")).not.toBeNull();
    expect(revokedAt("k2")).toBeNull();

    expect((await call("GET", "/v1/docs", SECRET)).status).toBe(401);
    expect((await call("GET", "/v1/key", OTHER_SECRET)).status).toBe(200);
  });

  it("is single-shot: a second revoke of the same key is an opaque 401", async () => {
    expect((await call("DELETE", "/v1/key", SECRET)).status).toBe(200);
    const first = revokedAt("k1");
    expect((await call("DELETE", "/v1/key", SECRET)).status).toBe(401);
    // The original revocation timestamp is not overwritten.
    expect(revokedAt("k1")).toBe(first);
  });

  it("401s for missing, malformed, JWT-shaped and unknown tokens without touching any row", async () => {
    for (const token of [undefined, "", "a.b.c", "annx_unknown", "not-a-key"]) {
      expect((await call("DELETE", "/v1/key", token)).status).toBe(401);
    }
    expect(revokedAt("k1")).toBeNull();
    expect(revokedAt("k2")).toBeNull();
  });

  it("still works while the API killswitch is off (leaked keys stay killable)", async () => {
    flagEnabled = false;
    expect((await call("DELETE", "/v1/key", SECRET)).status).toBe(200);
    expect(revokedAt("k1")).not.toBeNull();
  });

  it("still works when the owner was removed from the site or suspended", async () => {
    api.sqlite.prepare("DELETE FROM project_members WHERE id = 'm1'").run();
    auth.sqlite.prepare("UPDATE users SET moderation = -1 WHERE id = 'u1'").run();
    expect((await call("DELETE", "/v1/key", SECRET)).status).toBe(200);
    expect(revokedAt("k1")).not.toBeNull();
  });

  it("revokes an expired key too, so it drops off the owner's key list", async () => {
    await insertKey("k3", "annx_expiredKey_0123456789abcdefghijklmnopqrstuv", { expiresAt: "2020-01-01T00:00:00.000Z" });
    expect((await call("DELETE", "/v1/key", "annx_expiredKey_0123456789abcdefghijklmnopqrstuv")).status).toBe(200);
    expect(revokedAt("k3")).not.toBeNull();
  });

  it("accepts a trailing slash but no deeper path", async () => {
    expect((await call("DELETE", "/v1/key/", SECRET)).status).toBe(200);
    expect((await call("DELETE", "/v1/key/k2", OTHER_SECRET)).status).toBe(404);
    expect(revokedAt("k2")).toBeNull();
  });
});
