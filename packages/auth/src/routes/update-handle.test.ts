import { describe, it, expect, vi, beforeEach } from "vitest";
import { fileURLToPath } from "node:url";
import { createSqliteD1 } from "../../../api/src/test/sqliteD1";
import { handleUpdateHandle } from "./update-handle";

vi.mock("../auth-session", () => ({
  requireAuthenticatedSession: vi.fn(),
}));

import { requireAuthenticatedSession } from "../auth-session";

// Real SQLite with every auth migration applied, so uniqueness is the actual
// partial unique index from 0035 rather than a mocked error.
const AUTH_MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

function makeEnv() {
  const { db, sqlite } = createSqliteD1(AUTH_MIGRATIONS);
  const user = sqlite.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, 'U', 'x', datetime('now'))");
  user.run("user-1", "a@example.com");
  user.run("user-2", "b@example.com");
  const handleOf = (userId: string) =>
    (sqlite.prepare("SELECT handle FROM user_preferences WHERE user_id = ?").get(userId) as { handle: string | null } | undefined)?.handle;
  return { env: { DB: db } as unknown as Parameters<typeof handleUpdateHandle>[1], sqlite, handleOf };
}

function as(userId: string) {
  vi.mocked(requireAuthenticatedSession).mockResolvedValue({ userId, email: `${userId}@example.com`, expiresAt: Date.now() + 3600_000 });
}

function req(body: unknown) {
  return new Request("http://localhost/update-handle", {
    method: "POST",
    headers: { Authorization: "Bearer t", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  as("user-1");
});

describe("handleUpdateHandle", () => {
  it("returns 401 when the session is invalid", async () => {
    vi.mocked(requireAuthenticatedSession).mockResolvedValue(
      Response.json({ ok: false, error: "Unauthorized" }, { status: 401 }),
    );
    const { env } = makeEnv();
    const res = await handleUpdateHandle(req({ handle: "someone" }), env);
    expect(res.status).toBe(401);
  });

  it("rejects a body without a handle field", async () => {
    const { env } = makeEnv();
    expect((await handleUpdateHandle(req({}), env)).status).toBe(400);
    expect((await handleUpdateHandle(req({ handle: 42 }), env)).status).toBe(400);
  });

  it("rejects invalid and reserved handles with a reason, writing nothing", async () => {
    const { env, handleOf } = makeEnv();
    for (const [handle, reason] of [["ab", "length"], ["bad name", "characters"], ["admin", "reserved"]] as const) {
      const res = await handleUpdateHandle(req({ handle }), env);
      expect(res.status, handle).toBe(400);
      expect(((await res.json()) as { reason: string }).reason).toBe(reason);
    }
    expect(handleOf("user-1")).toBeUndefined();
  });

  it("creates the satellite row and stores the normalized handle", async () => {
    const { env, handleOf } = makeEnv();
    const res = await handleUpdateHandle(req({ handle: "  @Cubity_First " }), env);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { handle: string } }).data.handle).toBe("cubity_first");
    expect(handleOf("user-1")).toBe("cubity_first");
  });

  it("updates an existing preferences row without touching other columns", async () => {
    const { env, sqlite, handleOf } = makeEnv();
    sqlite.prepare("INSERT INTO user_preferences (user_id, bio) VALUES ('user-1', 'hello')").run();
    await handleUpdateHandle(req({ handle: "first" }), env);
    await handleUpdateHandle(req({ handle: "second" }), env);
    expect(handleOf("user-1")).toBe("second");
    expect((sqlite.prepare("SELECT bio FROM user_preferences WHERE user_id = 'user-1'").get() as { bio: string }).bio).toBe("hello");
  });

  it("re-saving your own handle is not a conflict", async () => {
    const { env } = makeEnv();
    await handleUpdateHandle(req({ handle: "mine" }), env);
    expect((await handleUpdateHandle(req({ handle: "MINE" }), env)).status).toBe(200);
  });

  it("returns 409 when another user holds the handle, case-insensitively", async () => {
    const { env, handleOf } = makeEnv();
    await handleUpdateHandle(req({ handle: "taken" }), env);
    as("user-2");
    const res = await handleUpdateHandle(req({ handle: "Taken" }), env);
    expect(res.status).toBe(409);
    expect(handleOf("user-2")).toBeUndefined();
  });

  it("an admin lock blocks claiming, renaming and clearing (403 locked)", async () => {
    const { env, sqlite, handleOf } = makeEnv();
    // Locked with no handle: the user can't claim one.
    sqlite.prepare("INSERT INTO user_preferences (user_id, handle_locked) VALUES ('user-1', 1)").run();
    let res = await handleUpdateHandle(req({ handle: "wanted" }), env);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { reason: string }).reason).toBe("locked");
    expect(handleOf("user-1")).toBeNull();

    // Locked with an admin-assigned handle: can't rename or clear it.
    sqlite.prepare("UPDATE user_preferences SET handle = 'official' WHERE user_id = 'user-1'").run();
    expect((await handleUpdateHandle(req({ handle: "other" }), env)).status).toBe(403);
    expect((await handleUpdateHandle(req({ handle: null }), env)).status).toBe(403);
    expect(handleOf("user-1")).toBe("official");
  });

  it("the write itself re-checks the lock (lock lands after the pre-read)", async () => {
    const { env, sqlite, handleOf } = makeEnv();
    sqlite.prepare("INSERT INTO user_preferences (user_id, handle) VALUES ('user-1', 'before')").run();
    // Simulate the admin lock landing between the handler's lock read and its
    // write: the first SELECT sees unlocked, then the row flips to locked.
    const realPrepare = env.DB.prepare.bind(env.DB);
    let lockReads = 0;
    (env.DB as unknown as { prepare: (sql: string) => D1PreparedStatement }).prepare = (sql: string) => {
      if (sql.startsWith("SELECT handle_locked") && lockReads++ === 0) {
        const stmt = realPrepare(sql);
        return {
          bind: (...args: unknown[]) => {
            const bound = stmt.bind(...args);
            return {
              first: async () => {
                const row = await bound.first();
                sqlite.prepare("UPDATE user_preferences SET handle_locked = 1 WHERE user_id = 'user-1'").run();
                return row;
              },
            };
          },
        } as unknown as D1PreparedStatement;
      }
      return realPrepare(sql);
    };
    const res = await handleUpdateHandle(req({ handle: "after" }), env);
    expect(res.status).toBe(403);
    expect(handleOf("user-1")).toBe("before");
  });

  it("clearing (null or blank) releases the handle for someone else", async () => {
    const { env, handleOf } = makeEnv();
    await handleUpdateHandle(req({ handle: "shared" }), env);
    const res = await handleUpdateHandle(req({ handle: "   " }), env);
    expect(((await res.json()) as { data: { handle: null } }).data.handle).toBeNull();
    expect(handleOf("user-1")).toBeNull();

    as("user-2");
    expect((await handleUpdateHandle(req({ handle: "shared" }), env)).status).toBe(200);
    as("user-1");
    expect((await handleUpdateHandle(req({ handle: null }), env)).status).toBe(200);
  });
});
