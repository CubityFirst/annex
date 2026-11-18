import { describe, it, expect } from "vitest";
import { createSqliteD1 } from "../../api/src/test/sqliteD1";
import { writeAdminAudit } from "./audit";
import type { Env } from "./index";
import type { AdminSession } from "./auth";

// Real SQLite with every main migration applied, so the INSERT's column list is
// checked against the real admin_audit_log schema (a mock only sees bind order).

function makeEnv() {
  const { db, sqlite } = createSqliteD1();
  sqlite.prepare("INSERT INTO users (id, email, name, is_admin, created_at, first_seen_at, synced_at) VALUES ('admin-1', 'admin@example.com', 'A', 1, datetime('now'), 0, 0)").run();
  const rows = () =>
    sqlite.prepare("SELECT id, actor_user_id, actor_email, action, target_type, target_id, detail FROM admin_audit_log").all().map(r => ({ ...r }));
  return { env: { DB: db } as unknown as Env, rows };
}

const ACTOR: AdminSession = {
  userId: "admin-1",
  email: "admin@example.com",
  expiresAt: Date.now() + 1000,
  isAdmin: true,
};

describe("writeAdminAudit", () => {
  it("inserts an actor-attributed row with serialized detail", async () => {
    const { env, rows } = makeEnv();
    await writeAdminAudit(env, ACTOR, "user.ink.grant", "user", "u-9", { expiresAt: null });

    expect(rows()).toEqual([{
      id: expect.any(String),
      actor_user_id: "admin-1",
      actor_email: "admin@example.com",
      action: "user.ink.grant",
      target_type: "user",
      target_id: "u-9",
      detail: JSON.stringify({ expiresAt: null }),
    }]);
  });

  it("stores NULL detail when none is provided", async () => {
    const { env, rows } = makeEnv();
    await writeAdminAudit(env, ACTOR, "user.avatar.delete", "user", "u-9");
    expect(rows()).toEqual([expect.objectContaining({ action: "user.avatar.delete", detail: null })]);
  });
});
