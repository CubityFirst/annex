// GET /api/projects/orphaned against real SQLite: sites/orgs whose owner was
// deleted on the identity service (kept by the deletion sync for review), plus
// deletions the sync hasn't finished.
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { createSqliteD1 } from "../../../api/src/test/sqliteD1";
import { projectsRouter } from "./projects";
import type { AppEnv } from "../index";

const T = "2026-10-01T00:00:00.000Z";

describe("GET /api/projects/orphaned", () => {
  it("lists only sites and orgs owned by accounts deleted on the identity service, and unfinished deletions", async () => {
    const { db, sqlite } = createSqliteD1();
    const run = (sql: string, ...a: (string | number | null)[]) => sqlite.prepare(sql).run(...a);
    run("INSERT INTO identity_deletions (user_id, deleted_at, deleted_by, processed_at, owned_site_ids) VALUES ('gone', 1700000000000, 'self', 1700000001000, '[\"s1\"]')");
    run("INSERT INTO identity_deletions (user_id, deleted_at, deleted_by, last_error) VALUES ('stuck', 1700000002000, 'admin:x', 'stripe down')");
    run("INSERT INTO projects (id, name, owner_id, created_at, published_at) VALUES ('s1', 'Orphan', 'gone', ?, ?)", T, T);
    run("INSERT INTO projects (id, name, owner_id, created_at) VALUES ('s2', 'Fine', 'alive', ?)", T);
    run("INSERT INTO project_members (id, project_id, user_id, email, name, role, invited_by, created_at, accepted) VALUES ('m1', 's1', 'gone', 'g', 'G', 'owner', 'gone', ?, 1)", T);
    run("INSERT INTO project_members (id, project_id, user_id, email, name, role, invited_by, created_at, accepted) VALUES ('m2', 's1', 'alive', 'a', 'A', 'editor', 'gone', ?, 1)", T);
    run("INSERT INTO organizations (id, name, owner_id, created_at) VALUES ('o1', 'Orphan org', 'gone', ?)", T);

    const app = new Hono<AppEnv>();
    app.route("/api/projects", projectsRouter);
    const res = await app.request("/api/projects/orphaned", {}, { DB: db } as unknown as AppEnv["Bindings"]);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Record<string, unknown[]> };
    expect(data.sites).toEqual([{ id: "s1", name: "Orphan", owner_id: "gone", published: true, other_members: 1, owner_deleted_at: 1700000000000 }]);
    expect(data.orgs).toEqual([{ id: "o1", name: "Orphan org", owner_id: "gone", sites: 0, owner_deleted_at: 1700000000000 }]);
    expect(data.pending_deletions).toEqual([{ user_id: "stuck", deleted_at: 1700000002000, last_error: "stripe down" }]);
  });
});
