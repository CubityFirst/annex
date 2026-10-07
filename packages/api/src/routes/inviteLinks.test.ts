import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleInviteLinks, handleInvitePublic } from "./inviteLinks";

vi.mock("../lib/access", () => ({ resolveRole: vi.fn() }));
vi.mock("../auth", () => ({ authenticate: vi.fn() }));

import { resolveRole } from "../lib/access";
import { authenticate } from "../auth";

const user = { userId: "caller-1", email: "a@example.com" } as unknown as Parameters<typeof handleInviteLinks>[2];

function makeEnv(opts?: { lookupOk?: boolean }) {
  const firsts: unknown[] = [];
  const alls: unknown[] = [];
  const runs: unknown[] = [];
  const first = vi.fn(() => Promise.resolve(firsts.shift() ?? null));
  const all = vi.fn(() => Promise.resolve(alls.shift() ?? { results: [] }));
  const run = vi.fn(() => {
    const r = runs.shift();
    return r instanceof Error ? Promise.reject(r) : Promise.resolve(r ?? { meta: { changes: 1 } });
  });
  const bind = vi.fn(() => ({ first, all, run }));
  const prepare = vi.fn((_sql: string) => ({ bind }));
  const batch = vi.fn(() => Promise.resolve([]));
  const authFetch = vi.fn(async () => {
    if (opts?.lookupOk === false) return new Response("", { status: 500 });
    return Response.json({ ok: true, data: { name: "Bob", email: "bob@x.z" } }, { status: 200 });
  });
  return {
    env: {
      DB: { prepare, batch },
      AUTH: { fetch: authFetch },
    } as unknown as Parameters<typeof handleInviteLinks>[1],
    run,
    batch,
    prepare,
    authFetch,
    queueFirst: (v: unknown) => firsts.push(v),
    queueRun: (v: unknown) => runs.push(v),
    queueAll: (v: unknown) => alls.push(v),
  };
}

function call(env: Parameters<typeof handleInviteLinks>[1], method: string, path: string, body?: unknown) {
  const url = new URL(`http://localhost${path}`);
  return handleInviteLinks(
    new Request(url.toString(), {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }),
    env, user, url,
  );
}

function callPublic(env: Parameters<typeof handleInvitePublic>[1], method: string, path: string) {
  const url = new URL(`http://localhost${path}`);
  return handleInvitePublic(new Request(url.toString(), { method }), env, url);
}

function validLink(over?: Partial<Record<string, unknown>>) {
  return {
    id: "link-1",
    project_id: "p1",
    role: "editor",
    max_uses: null,
    use_count: 0,
    expires_at: null,
    created_by: "creator-1",
    created_at: "2026-01-01",
    is_active: 1,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveRole).mockResolvedValue("admin");
  vi.mocked(authenticate).mockResolvedValue({ userId: "user-1", email: "u@x.z" } as unknown as Awaited<ReturnType<typeof authenticate>>);
});

describe("handleInviteLinks (manage) gates", () => {
  it("404s on a non-matching path", async () => {
    const { env } = makeEnv();
    const res = await call(env, "GET", "/projects/p1/other");
    expect(res.status).toBe(404);
  });

  it("404s when the caller isn't a member", async () => {
    vi.mocked(resolveRole).mockResolvedValue(null);
    const { env } = makeEnv();
    const res = await call(env, "GET", "/projects/p1/invite-links");
    expect(res.status).toBe(404);
  });

  it("403s for a member below admin", async () => {
    vi.mocked(resolveRole).mockResolvedValue("editor");
    const { env } = makeEnv();
    const res = await call(env, "GET", "/projects/p1/invite-links");
    expect(res.status).toBe(403);
  });

  it("404s on an unsupported method", async () => {
    const { env } = makeEnv();
    const res = await call(env, "PUT", "/projects/p1/invite-links");
    expect(res.status).toBe(404);
  });
});

describe("handleInviteLinks GET/POST/DELETE", () => {
  it("lists the project's links", async () => {
    const { env, queueAll } = makeEnv();
    queueAll({ results: [validLink()] });
    const res = await call(env, "GET", "/projects/p1/invite-links");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: Array<{ id: string; isActive: boolean }> };
    expect(json.data[0].id).toBe("link-1");
    expect(json.data[0].isActive).toBe(true);
  });

  it("400s on an invalid role", async () => {
    const { env } = makeEnv();
    const res = await call(env, "POST", "/projects/p1/invite-links", { role: "superadmin" });
    expect(res.status).toBe(400);
  });

  it("403s when an admin tries to mint an admin-granting link", async () => {
    vi.mocked(resolveRole).mockResolvedValue("admin");
    const { env } = makeEnv();
    const res = await call(env, "POST", "/projects/p1/invite-links", { role: "admin" });
    expect(res.status).toBe(403);
  });

  it("400s on an unparseable expiresAt (would otherwise never expire)", async () => {
    const { env, run } = makeEnv();
    const res = await call(env, "POST", "/projects/p1/invite-links", { role: "editor", expiresAt: "not-a-date" });
    expect(res.status).toBe(400);
    expect(run).not.toHaveBeenCalled();
  });

  it("creates a link (201)", async () => {
    const { env, run } = makeEnv();
    const res = await call(env, "POST", "/projects/p1/invite-links", { role: "editor", maxUses: 5 });
    expect(res.status).toBe(201);
    expect(run).toHaveBeenCalled();
    const json = (await res.json()) as { data: { role: string; maxUses: number } };
    expect(json.data.role).toBe("editor");
    expect(json.data.maxUses).toBe(5);
  });

  it("404s DELETE when the link is missing", async () => {
    const { env } = makeEnv(); // first() → null
    const res = await call(env, "DELETE", "/projects/p1/invite-links/link-1");
    expect(res.status).toBe(404);
  });

  it("revokes a link", async () => {
    const { env, queueFirst, run } = makeEnv();
    queueFirst({ id: "link-1" });
    const res = await call(env, "DELETE", "/projects/p1/invite-links/link-1");
    expect(res.status).toBe(200);
    expect(run).toHaveBeenCalled();
    const json = (await res.json()) as { data: { revoked: boolean } };
    expect(json.data.revoked).toBe(true);
  });
});

describe("handleInvitePublic GET metadata", () => {
  it("404s on a non-matching path", async () => {
    const { env } = makeEnv();
    const res = await callPublic(env, "GET", "/not-invites/x");
    expect(res.status).toBe(404);
  });

  it("404s when the link doesn't exist", async () => {
    const { env } = makeEnv(); // first() → null
    const res = await callPublic(env, "GET", "/invites/tok");
    expect(res.status).toBe(404);
  });

  it("returns invite metadata with the owner name", async () => {
    const { env, queueFirst } = makeEnv();
    queueFirst({ ...validLink(), project_name: "My Site" });
    queueFirst({ name: "Owner Person" });
    const res = await callPublic(env, "GET", "/invites/tok");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { projectName: string; ownerName: string; isActive: boolean } };
    expect(json.data.projectName).toBe("My Site");
    expect(json.data.ownerName).toBe("Owner Person");
    expect(json.data.isActive).toBe(true);
  });
});

describe("handleInvitePublic POST accept", () => {
  it("401s when unauthenticated", async () => {
    vi.mocked(authenticate).mockResolvedValue(null);
    const { env } = makeEnv();
    const res = await callPublic(env, "POST", "/invites/tok/accept");
    expect(res.status).toBe(401);
  });

  it("propagates an auth Response (e.g. 2FA challenge)", async () => {
    vi.mocked(authenticate).mockResolvedValue(new Response("nope", { status: 418 }) as unknown as Awaited<ReturnType<typeof authenticate>>);
    const { env } = makeEnv();
    const res = await callPublic(env, "POST", "/invites/tok/accept");
    expect(res.status).toBe(418);
  });

  it("404s when the link is missing", async () => {
    const { env } = makeEnv(); // first() → null
    const res = await callPublic(env, "POST", "/invites/tok/accept");
    expect(res.status).toBe(404);
  });

  it("410s when the link is revoked", async () => {
    const { env, queueFirst } = makeEnv();
    queueFirst(validLink({ is_active: 0 }));
    const res = await callPublic(env, "POST", "/invites/tok/accept");
    expect(res.status).toBe(410);
  });

  it("410s when the link has expired", async () => {
    const { env, queueFirst } = makeEnv();
    queueFirst(validLink({ expires_at: "2000-01-01T00:00:00.000Z" }));
    const res = await callPublic(env, "POST", "/invites/tok/accept");
    expect(res.status).toBe(410);
  });

  it("410s when max uses are exhausted", async () => {
    const { env, queueFirst } = makeEnv();
    queueFirst(validLink({ max_uses: 1, use_count: 1 }));
    const res = await callPublic(env, "POST", "/invites/tok/accept");
    expect(res.status).toBe(410);
  });

  it("410s when the creator no longer has authority", async () => {
    vi.mocked(resolveRole).mockResolvedValue(null);
    const { env, queueFirst } = makeEnv();
    queueFirst(validLink());
    const res = await callPublic(env, "POST", "/invites/tok/accept");
    expect(res.status).toBe(410);
  });

  it("returns alreadyMember for an accepted member", async () => {
    const { env, queueFirst } = makeEnv();
    queueFirst(validLink());
    queueFirst({ id: "m1", role: "viewer", accepted: 1 });
    const res = await callPublic(env, "POST", "/invites/tok/accept");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { alreadyMember: boolean } };
    expect(json.data.alreadyMember).toBe(true);
  });

  it("accepts a pending email invite via the link (keeps its role)", async () => {
    const { env, queueFirst, prepare } = makeEnv();
    queueFirst(validLink());
    queueFirst({ id: "m1", role: "viewer", accepted: 0 });
    const res = await callPublic(env, "POST", "/invites/tok/accept");
    expect(res.status).toBe(201);
    const sqls = prepare.mock.calls.map(c => c[0]);
    expect(sqls.some(q => q.includes("use_count < max_uses"))).toBe(true);
    expect(sqls.some(q => q.includes("UPDATE project_members SET accepted = 1"))).toBe(true);
    const json = (await res.json()) as { data: { role: string } };
    expect(json.data.role).toBe("viewer");
  });

  it("creates a new membership after a successful lookup", async () => {
    const { env, queueFirst, prepare, authFetch } = makeEnv();
    queueFirst(validLink());
    queueFirst(null); // not yet a member
    const res = await callPublic(env, "POST", "/invites/tok/accept");
    expect(res.status).toBe(201);
    expect(authFetch).toHaveBeenCalled();
    expect(prepare.mock.calls.some(c => c[0].includes("INSERT INTO project_members"))).toBe(true);
    const json = (await res.json()) as { data: { role: string } };
    expect(json.data.role).toBe("editor");
  });

  it("410s without adding a member when a concurrent accept took the last use", async () => {
    const { env, queueFirst, queueRun, prepare } = makeEnv();
    queueFirst(validLink());
    queueFirst(null);
    queueRun({ meta: { changes: 0 } }); // conditional use_count claim loses the race
    const res = await callPublic(env, "POST", "/invites/tok/accept");
    expect(res.status).toBe(410);
    expect(prepare.mock.calls.some(c => c[0].includes("INSERT INTO project_members"))).toBe(false);
  });

  it("refunds the claimed use when the member insert fails (same user, two tabs)", async () => {
    const { env, queueFirst, queueRun, prepare } = makeEnv();
    queueFirst(validLink());
    queueFirst(null);
    queueRun({ meta: { changes: 1 } });                 // claim succeeds
    queueRun(new Error("UNIQUE constraint failed"));    // insert loses to the other tab
    await expect(callPublic(env, "POST", "/invites/tok/accept")).rejects.toThrow(/UNIQUE/);
    expect(prepare.mock.calls.some(c => c[0].includes("use_count = use_count - 1"))).toBe(true);
  });

  it("500s when the auth-worker lookup fails", async () => {
    const { env, queueFirst } = makeEnv({ lookupOk: false });
    queueFirst(validLink());
    queueFirst(null);
    const res = await callPublic(env, "POST", "/invites/tok/accept");
    expect(res.status).toBe(500);
  });
});
