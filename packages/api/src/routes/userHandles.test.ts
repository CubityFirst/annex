import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { createSqliteD1 } from "../test/sqliteD1";
import { handleUserByHandle } from "./userHandles";
import type { Env } from "../index";

// AUTH_DB stand-in: real SQLite with every auth migration applied (incl. the
// 0035 handle column + partial unique index).
const AUTH_MIGRATIONS = fileURLToPath(new URL("../../../auth/migrations", import.meta.url));

function makeEnv() {
  const { db, sqlite } = createSqliteD1(AUTH_MIGRATIONS);
  const user = sqlite.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, 'x', datetime('now'))");
  user.run("user-1", "a@example.com", "Cubity");
  user.run("user-2", "b@example.com", "No Handle");
  user.run("user-3", "c@example.com", "Official");
  sqlite.prepare("INSERT INTO user_preferences (user_id, handle) VALUES ('user-1', 'cubity')").run();
  sqlite.prepare("INSERT INTO user_preferences (user_id, bio) VALUES ('user-2', 'hi')").run();
  // Reserved name, assignable only by an admin (packages/admin PATCH /:id/handle).
  sqlite.prepare("INSERT INTO user_preferences (user_id, handle) VALUES ('user-3', 'support')").run();
  return { AUTH_DB: db } as unknown as Env;
}

async function resolve(env: Env, raw: string) {
  const res = await handleUserByHandle(env, raw);
  return { status: res.status, json: (await res.json()) as { ok: boolean; data?: { userId: string; name: string; handle: string } } };
}

describe("handleUserByHandle", () => {
  it("resolves a claimed handle to its user", async () => {
    const { status, json } = await resolve(makeEnv(), "cubity");
    expect(status).toBe(200);
    expect(json.data).toEqual({ userId: "user-1", name: "Cubity", handle: "cubity" });
  });

  it("matches case-insensitively and tolerates a leading (encoded) @", async () => {
    const env = makeEnv();
    expect((await resolve(env, "CUBITY")).json.data?.userId).toBe("user-1");
    expect((await resolve(env, "%40Cubity")).json.data?.userId).toBe("user-1");
  });

  it("resolves an admin-assigned reserved handle", async () => {
    expect((await resolve(makeEnv(), "support")).json.data?.userId).toBe("user-3");
  });

  it("404s for unclaimed, malformed, unassigned-reserved and undecodable handles", async () => {
    const env = makeEnv();
    for (const raw of ["nobody", "ab", "bad name", "admin", "%E0%A4%A"]) {
      expect((await resolve(env, raw)).status, raw).toBe(404);
    }
  });
});
