import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleMembers } from "./members";

vi.mock("../lib/access", () => ({ resolveRole: vi.fn() }));

import { resolveRole } from "../lib/access";

const user = { userId: "caller-1", email: "a@example.com" } as unknown as Parameters<typeof handleMembers>[2];

function makeEnv(opts?: { lookupStatus?: number; lookupUser?: { userId: string; email: string; name: string }; rateOk?: boolean }) {
  const firsts: unknown[] = [];
  const alls: unknown[] = [];
  const runs: unknown[] = [];
  const bindCalls: unknown[][] = [];
  const first = vi.fn(() => Promise.resolve(firsts.shift() ?? null));
  const all = vi.fn(() => Promise.resolve(alls.shift() ?? { results: [] }));
  const run = vi.fn(() => Promise.resolve(runs.shift() ?? { meta: { changes: 1 } }));
  const bind = vi.fn((...args: unknown[]) => { bindCalls.push(args); return { first, all, run }; });
  const prepare = vi.fn((_sql: string) => ({ bind }));
  const batch = vi.fn((_stmts: unknown[]) => Promise.resolve([]));
  const authAll = vi.fn(() => Promise.resolve({ results: [] }));
  const authFetch = vi.fn(async () => {
    const status = opts?.lookupStatus ?? 200;
    if (status !== 200) return new Response("", { status });
    return Response.json({ ok: true, data: opts?.lookupUser ?? { userId: "invitee-1", email: "b@example.com", name: "Bob" } }, { status: 200 });
  });
  return {
    env: {
      DB: { prepare, batch },
      AUTH_DB: { prepare: vi.fn(() => ({ bind: vi.fn(() => ({ all: authAll })) })) },
      AUTH: { fetch: authFetch },
      RATE_LIMITER_INVITE_LOOKUP: { limit: vi.fn(async () => ({ success: opts?.rateOk ?? true })) },
    } as unknown as Parameters<typeof handleMembers>[1],
    run,
    batch,
    authFetch,
    prepare,
    bindCalls,
    queueFirst: (v: unknown) => firsts.push(v),
    queueAll: (v: unknown) => alls.push(v),
  };
}

function call(env: Parameters<typeof handleMembers>[1], method: string, path: string, body?: unknown) {
  const url = new URL(`http://localhost${path}`);
  return handleMembers(
    new Request(url.toString(), {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }),
    env, user, url,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveRole).mockResolvedValue("admin");
});

describe("handleMembers GET", () => {
  it("404s when the caller isn't a member", async () => {
    vi.mocked(resolveRole).mockResolvedValue(null);
    const { env } = makeEnv();
    const res = await call(env, "GET", "/projects/p1/members");
    expect(res.status).toBe(404);
  });

  it("403s for a member below admin", async () => {
    vi.mocked(resolveRole).mockResolvedValue("editor");
    const { env } = makeEnv();
    const res = await call(env, "GET", "/projects/p1/members");
    expect(res.status).toBe(403);
  });

  it("lists members for an admin", async () => {
    const { env, queueAll } = makeEnv();
    queueAll({ results: [{ id: "m1", project_id: "p1", user_id: "u1", email: "x@y.z", name: "X", role: "editor", invited_by: "caller-1", created_at: "2026", accepted: 1 }] });
    const res = await call(env, "GET", "/projects/p1/members");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: Array<{ userId: string; accepted: boolean }> };
    expect(json.data[0].userId).toBe("u1");
    expect(json.data[0].accepted).toBe(true);
  });
});

describe("handleMembers POST (invite)", () => {
  it("403s for a member below admin", async () => {
    vi.mocked(resolveRole).mockResolvedValue("editor");
    const { env } = makeEnv();
    const res = await call(env, "POST", "/projects/p1/members", { email: "b@x.z", role: "viewer" });
    expect(res.status).toBe(403);
  });

  it("403s when an admin tries to invite an admin", async () => {
    const { env, authFetch } = makeEnv();
    const res = await call(env, "POST", "/projects/p1/members", { email: "b@x.z", role: "admin" });
    expect(res.status).toBe(403);
    expect(authFetch).not.toHaveBeenCalled();
  });

  it("400s when trying to invite as owner", async () => {
    const { env } = makeEnv();
    const res = await call(env, "POST", "/projects/p1/members", { email: "b@x.z", role: "owner" });
    expect(res.status).toBe(400);
  });

  it("429s when the per-user lookup rate limit trips", async () => {
    const { env } = makeEnv({ rateOk: false });
    const res = await call(env, "POST", "/projects/p1/members", { email: "b@x.z", role: "viewer" });
    expect(res.status).toBe(429);
  });

  it("404s when no user has that email", async () => {
    const { env } = makeEnv({ lookupStatus: 404 });
    const res = await call(env, "POST", "/projects/p1/members", { email: "ghost@x.z", role: "viewer" });
    expect(res.status).toBe(404);
  });

  it("409s when the invitee is already a member", async () => {
    const { env, queueFirst } = makeEnv();
    queueFirst({ id: "existing" });
    const res = await call(env, "POST", "/projects/p1/members", { email: "b@x.z", role: "viewer" });
    expect(res.status).toBe(409);
  });

  it("creates the membership (201) for a valid invite", async () => {
    const { env, queueFirst, run, prepare, bindCalls } = makeEnv();
    queueFirst(null); // not already a member
    const res = await call(env, "POST", "/projects/p1/members", { email: "b@x.z", role: "viewer" });
    expect(res.status).toBe(201);
    expect(run).toHaveBeenCalled();
    // The response must echo the looked-up invitee, the requested role, and pending state.
    const json = (await res.json()) as { data: { userId: string; email: string; name: string; role: string; accepted: boolean } };
    expect(json.data.userId).toBe("invitee-1");
    expect(json.data.email).toBe("b@example.com");
    expect(json.data.name).toBe("Bob");
    expect(json.data.role).toBe("viewer");
    expect(json.data.accepted).toBe(false);
    // The INSERT must persist accepted as the literal 0 and bind the invitee id + role.
    expect(prepare.mock.calls.some(c =>
      (c[0] as string).includes("INSERT INTO project_members") &&
      (c[0] as string).includes("VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)"),
    )).toBe(true);
    const insertBind = bindCalls.find(args => args.includes("invitee-1") && args.includes("viewer"));
    expect(insertBind).toBeDefined();
    expect(insertBind).toContain("p1");
  });
});

describe("handleMembers PATCH (role change escalation guards)", () => {
  it("blocks an admin from promoting a member to admin", async () => {
    vi.mocked(resolveRole).mockResolvedValue("admin");
    const { env, queueFirst } = makeEnv();
    queueFirst({ id: "m2", role: "editor" });
    const res = await call(env, "PATCH", "/projects/p1/members/u2", { role: "admin" });
    expect(res.status).toBe(403);
  });

  it("blocks an admin from changing another admin's role", async () => {
    vi.mocked(resolveRole).mockResolvedValue("admin");
    const { env, queueFirst } = makeEnv();
    queueFirst({ id: "m2", role: "admin" });
    const res = await call(env, "PATCH", "/projects/p1/members/u2", { role: "viewer" });
    expect(res.status).toBe(403);
  });

  it("refuses to touch the owner's role", async () => {
    const { env, queueFirst } = makeEnv();
    queueFirst({ id: "m2", role: "owner" });
    const res = await call(env, "PATCH", "/projects/p1/members/u2", { role: "viewer" });
    expect(res.status).toBe(403);
  });

  it("an owner can demote an admin to viewer", async () => {
    vi.mocked(resolveRole).mockResolvedValue("owner");
    const { env, queueFirst, batch, prepare, bindCalls } = makeEnv();
    queueFirst({ id: "m2", role: "admin" }); // target lookup
    queueFirst({ id: "m2", project_id: "p1", user_id: "u2", email: "x", name: "X", role: "viewer", invited_by: "c", created_at: "2026", accepted: 1 }); // updated
    const res = await call(env, "PATCH", "/projects/p1/members/u2", { role: "viewer" });
    expect(res.status).toBe(200);
    expect(batch).toHaveBeenCalled();
    const json = (await res.json()) as { data: { role: string } };
    expect(json.data.role).toBe("viewer");
    // The role UPDATE must bind the new role + the target.
    expect(prepare.mock.calls.some(c => (c[0] as string).includes("UPDATE project_members SET role = ?"))).toBe(true);
    expect(bindCalls).toContainEqual(["viewer", "p1", "u2"]);
    // A demotion (below editor) must NOT clean up doc_shares - the batch is just the UPDATE.
    expect(prepare.mock.calls.some(c => (c[0] as string).includes("DELETE FROM doc_shares"))).toBe(false);
    expect((batch.mock.calls[0][0] as unknown[]).length).toBe(1);
  });

  it("promoting a viewer to editor also drops their doc_shares", async () => {
    vi.mocked(resolveRole).mockResolvedValue("owner");
    const { env, queueFirst, batch, prepare, bindCalls } = makeEnv();
    queueFirst({ id: "m2", role: "viewer" }); // target lookup
    queueFirst({ id: "m2", project_id: "p1", user_id: "u2", email: "x", name: "X", role: "editor", invited_by: "c", created_at: "2026", accepted: 1 }); // updated
    const res = await call(env, "PATCH", "/projects/p1/members/u2", { role: "editor" });
    expect(res.status).toBe(200);
    // Promotion to editor+ makes per-doc shares inert, so the batch must include
    // the doc_shares cleanup alongside the role UPDATE (two statements).
    expect(prepare.mock.calls.some(c => (c[0] as string).includes("DELETE FROM doc_shares WHERE project_id = ?"))).toBe(true);
    expect(bindCalls).toContainEqual(["p1", "u2"]);
    expect((batch.mock.calls[0][0] as unknown[]).length).toBe(2);
  });
});

describe("handleMembers DELETE", () => {
  it("lets a non-owner member remove themselves", async () => {
    vi.mocked(resolveRole).mockResolvedValue("editor");
    const selfUser = { userId: "u2", email: "x" } as unknown as Parameters<typeof handleMembers>[2];
    const { env, batch, prepare } = makeEnv();
    const url = new URL("http://localhost/projects/p1/members/u2");
    const res = await handleMembers(new Request(url.toString(), { method: "DELETE" }), env, selfUser, url);
    expect(res.status).toBe(200);
    expect(batch).toHaveBeenCalled();
    expect(prepare.mock.calls.some(c => (c[0] as string).includes("DELETE FROM doc_shares WHERE project_id = ? AND user_id = ?"))).toBe(true);
  });

  it("blocks the owner from leaving their own project", async () => {
    vi.mocked(resolveRole).mockResolvedValue("owner");
    const selfUser = { userId: "u2", email: "x" } as unknown as Parameters<typeof handleMembers>[2];
    const url = new URL("http://localhost/projects/p1/members/u2");
    const { env } = makeEnv();
    const res = await handleMembers(new Request(url.toString(), { method: "DELETE" }), env, selfUser, url);
    expect(res.status).toBe(403);
  });

  it("blocks an admin from removing another admin", async () => {
    vi.mocked(resolveRole).mockResolvedValue("admin");
    const { env, queueFirst } = makeEnv();
    queueFirst({ id: "m2", role: "admin" });
    const res = await call(env, "DELETE", "/projects/p1/members/u2");
    expect(res.status).toBe(403);
  });

  it("lets an admin remove a viewer", async () => {
    vi.mocked(resolveRole).mockResolvedValue("admin");
    const { env, queueFirst, batch, prepare, bindCalls } = makeEnv();
    queueFirst({ id: "m2", role: "viewer" });
    const res = await call(env, "DELETE", "/projects/p1/members/u2");
    expect(res.status).toBe(200);
    // Member row and their per-doc shares go together, so a leftover edit
    // share can't outlive the membership.
    expect((batch.mock.calls[0][0] as unknown[]).length).toBe(2);
    expect(prepare.mock.calls.some(c => (c[0] as string).includes("DELETE FROM doc_shares WHERE project_id = ? AND user_id = ?"))).toBe(true);
    expect(bindCalls).toContainEqual(["p1", "u2"]);
  });
});
