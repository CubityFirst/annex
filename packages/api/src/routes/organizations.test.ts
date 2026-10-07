import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleOrganizations } from "./organizations";

vi.mock("./members", () => ({ loadMemberPlans: vi.fn() }));

import { loadMemberPlans } from "./members";

const user = { userId: "caller-1", email: "a@example.com" } as unknown as Parameters<typeof handleOrganizations>[2];

function makeEnv(opts?: { lookupStatus?: number; lookupUser?: { userId: string; email: string; name: string }; rateOk?: boolean }) {
  const firsts: unknown[] = [];
  const alls: unknown[] = [];
  const runs: unknown[] = [];
  const first = vi.fn(() => Promise.resolve(firsts.shift() ?? null));
  const all = vi.fn(() => Promise.resolve(alls.shift() ?? { results: [] }));
  const run = vi.fn(() => Promise.resolve(runs.shift() ?? { meta: { changes: 1 } }));
  const bind = vi.fn(() => ({ first, all, run }));
  const prepare = vi.fn(() => ({ bind }));
  const authFetch = vi.fn(async (input: string) => {
    // callerDisplayName hits /lookup-by-id; member-invite hits /lookup.
    if (String(input).includes("lookup-by-id")) {
      return Response.json({ ok: true, data: { name: "Caller Name" } }, { status: 200 });
    }
    const status = opts?.lookupStatus ?? 200;
    if (status !== 200) return new Response("", { status });
    return Response.json({ ok: true, data: opts?.lookupUser ?? { userId: "invitee-1", email: "b@example.com", name: "Bob" } }, { status: 200 });
  });
  return {
    env: {
      DB: { prepare },
      AUTH: { fetch: authFetch },
      RATE_LIMITER_INVITE_LOOKUP: { limit: vi.fn(async () => ({ success: opts?.rateOk ?? true })) },
    } as unknown as Parameters<typeof handleOrganizations>[1],
    run,
    authFetch,
    queueFirst: (v: unknown) => firsts.push(v),
    queueAll: (v: unknown) => alls.push(v),
  };
}

function call(env: Parameters<typeof handleOrganizations>[1], method: string, path: string, body?: unknown) {
  const url = new URL(`http://localhost${path}`);
  return handleOrganizations(
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
  vi.mocked(loadMemberPlans).mockResolvedValue(new Map());
});

describe("handleOrganizations collection", () => {
  it("lists the caller's orgs", async () => {
    const { env, queueAll } = makeEnv();
    queueAll({ results: [{ id: "o1", name: "Org", owner_id: "caller-1", created_at: "x", role: "owner", site_count: 2, member_count: 3 }] });
    const res = await call(env, "GET", "/organizations");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: unknown[] };
    expect(json.data).toHaveLength(1);
  });

  it("400s POST without a name", async () => {
    const { env } = makeEnv();
    const res = await call(env, "POST", "/organizations", { name: "  " });
    expect(res.status).toBe(400);
  });

  it("creates an org (201) with an owner membership", async () => {
    const { env, run } = makeEnv();
    const res = await call(env, "POST", "/organizations", { name: "New Org" });
    expect(res.status).toBe(201);
    expect(run).toHaveBeenCalledTimes(2); // org row + owner membership
    const json = (await res.json()) as { data: { name: string; role: string } };
    expect(json.data.name).toBe("New Org");
    expect(json.data.role).toBe("owner");
  });

  it("404s an unsupported collection method", async () => {
    const { env } = makeEnv();
    const res = await call(env, "DELETE", "/organizations");
    expect(res.status).toBe(404);
  });
});

describe("handleOrganizations detail /organizations/:id", () => {
  it("404s GET for a non-member", async () => {
    const { env, queueFirst } = makeEnv();
    queueFirst(null); // getOrgRole → null (not a member)
    // A present org row is queued behind the gate: if the membership check were
    // dropped, the handler would fall through and 200 with org metadata. The
    // 404 proves the gate runs before the org row is fetched/returned.
    queueFirst({ id: "o1", name: "Org", owner_id: "x", created_at: "y" });
    const res = await call(env, "GET", "/organizations/o1");
    expect(res.status).toBe(404);
  });

  it("returns detail for a member", async () => {
    const { env, queueFirst } = makeEnv();
    queueFirst({ role: "editor" }); // getOrgRole
    queueFirst({ id: "o1", name: "Org", owner_id: "x", created_at: "y" }); // org row
    const res = await call(env, "GET", "/organizations/o1");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { role: string } };
    expect(json.data.role).toBe("editor");
  });

  it("404s GET when the org row vanished", async () => {
    const { env, queueFirst } = makeEnv();
    queueFirst({ role: "editor" });
    queueFirst(null); // org row missing
    const res = await call(env, "GET", "/organizations/o1");
    expect(res.status).toBe(404);
  });

  it("403s PATCH for a member below admin", async () => {
    const { env, queueFirst } = makeEnv();
    queueFirst({ role: "editor" });
    const res = await call(env, "PATCH", "/organizations/o1", { name: "Renamed" });
    expect(res.status).toBe(403);
  });

  it("400s PATCH with an empty name", async () => {
    const { env, queueFirst } = makeEnv();
    queueFirst({ role: "admin" });
    const res = await call(env, "PATCH", "/organizations/o1", { name: "  " });
    expect(res.status).toBe(400);
  });

  it("renames the org for an admin", async () => {
    const { env, queueFirst, run } = makeEnv();
    queueFirst({ role: "admin" });
    queueFirst({ id: "o1", name: "Renamed", owner_id: "x", created_at: "y" });
    const res = await call(env, "PATCH", "/organizations/o1", { name: "Renamed" });
    expect(res.status).toBe(200);
    expect(run).toHaveBeenCalled();
  });

  it("403s DELETE for a non-owner", async () => {
    const { env, queueFirst } = makeEnv();
    queueFirst({ role: "admin" });
    const res = await call(env, "DELETE", "/organizations/o1");
    expect(res.status).toBe(403);
  });

  it("deletes the org for the owner", async () => {
    const { env, queueFirst, run } = makeEnv();
    queueFirst({ role: "owner" });
    const res = await call(env, "DELETE", "/organizations/o1");
    expect(res.status).toBe(200);
    expect(run).toHaveBeenCalled();
  });
});

describe("handleOrganizations /organizations/:id/projects", () => {
  it("404s listing for a non-member", async () => {
    const { env } = makeEnv(); // getOrgRole → null
    const res = await call(env, "GET", "/organizations/o1/projects");
    expect(res.status).toBe(404);
  });

  it("lists sites for an org member", async () => {
    const { env, queueFirst, queueAll } = makeEnv();
    queueFirst({ role: "viewer" });
    queueAll({ results: [{ id: "p1" }, { id: "p2" }] });
    const res = await call(env, "GET", "/organizations/o1/projects");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: unknown[] };
    expect(json.data).toHaveLength(2);
  });
});

describe("handleOrganizations attach/detach", () => {
  it("404s for a stranger (no org role, not site owner)", async () => {
    const { env, queueFirst } = makeEnv();
    queueFirst(null); // getOrgRole
    queueFirst(null); // directRole project_members
    const res = await call(env, "POST", "/organizations/o1/projects/p1/attach");
    expect(res.status).toBe(404);
  });

  it("403s attach for an org admin who isn't the site owner", async () => {
    const { env, queueFirst } = makeEnv();
    queueFirst({ role: "admin" }); // org role
    queueFirst({ role: "editor" }); // direct site role (not owner)
    const res = await call(env, "POST", "/organizations/o1/projects/p1/attach");
    expect(res.status).toBe(403);
  });

  it("404s attach when the project doesn't exist", async () => {
    const { env, queueFirst } = makeEnv();
    queueFirst({ role: "admin" });
    queueFirst({ role: "owner" }); // direct site owner
    queueFirst(null); // project row missing
    const res = await call(env, "POST", "/organizations/o1/projects/p1/attach");
    expect(res.status).toBe(404);
  });

  it("is idempotent when already attached to this org", async () => {
    const { env, queueFirst } = makeEnv();
    queueFirst({ role: "admin" });
    queueFirst({ role: "owner" });
    queueFirst({ organization_id: "o1" });
    const res = await call(env, "POST", "/organizations/o1/projects/p1/attach");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { attached: boolean } };
    expect(json.data.attached).toBe(true);
  });

  it("409s when attached to a different org", async () => {
    const { env, queueFirst } = makeEnv();
    queueFirst({ role: "admin" });
    queueFirst({ role: "owner" });
    queueFirst({ organization_id: "other" });
    const res = await call(env, "POST", "/organizations/o1/projects/p1/attach");
    expect(res.status).toBe(409);
  });

  it("attaches a free site for an org-admin site-owner", async () => {
    const { env, queueFirst, run } = makeEnv();
    queueFirst({ role: "admin" });
    queueFirst({ role: "owner" });
    queueFirst({ organization_id: null });
    const res = await call(env, "POST", "/organizations/o1/projects/p1/attach");
    expect(res.status).toBe(200);
    expect(run).toHaveBeenCalled();
  });

  it("403s detach for a viewer who isn't the site owner", async () => {
    const { env, queueFirst } = makeEnv();
    queueFirst({ role: "viewer" }); // org role (below admin)
    queueFirst({ role: "editor" }); // direct site role (not owner)
    const res = await call(env, "DELETE", "/organizations/o1/projects/p1/attach");
    expect(res.status).toBe(403);
  });

  it("detaches for the site owner", async () => {
    const { env, queueFirst, run } = makeEnv();
    queueFirst(null); // not an org member
    queueFirst({ role: "owner" }); // direct site owner
    const res = await call(env, "DELETE", "/organizations/o1/projects/p1/attach");
    expect(res.status).toBe(200);
    expect(run).toHaveBeenCalled();
    const json = (await res.json()) as { data: { detached: boolean } };
    expect(json.data.detached).toBe(true);
  });
});

describe("handleOrganizations members", () => {
  it("404s for a non-member caller", async () => {
    const { env } = makeEnv(); // getOrgRole → null
    const res = await call(env, "GET", "/organizations/o1/members");
    expect(res.status).toBe(404);
  });

  it("403s listing for a member below admin", async () => {
    const { env, queueFirst } = makeEnv();
    queueFirst({ role: "editor" });
    const res = await call(env, "GET", "/organizations/o1/members");
    expect(res.status).toBe(403);
  });

  it("lists members for an admin", async () => {
    const { env, queueFirst, queueAll } = makeEnv();
    queueFirst({ role: "admin" });
    queueAll({ results: [{ id: "m1", organization_id: "o1", user_id: "u1", email: "x", name: "X", role: "viewer", invited_by: "caller-1", created_at: "y", accepted: 1 }] });
    const res = await call(env, "GET", "/organizations/o1/members");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: Array<{ userId: string; accepted: boolean }> };
    expect(json.data[0].userId).toBe("u1");
    expect(json.data[0].accepted).toBe(true);
  });

  it("403s invite for a member below admin", async () => {
    const { env, queueFirst } = makeEnv();
    queueFirst({ role: "editor" });
    const res = await call(env, "POST", "/organizations/o1/members", { email: "b@x.z", role: "viewer" });
    expect(res.status).toBe(403);
  });

  it("400s invite without email/role", async () => {
    const { env, queueFirst } = makeEnv();
    queueFirst({ role: "admin" });
    const res = await call(env, "POST", "/organizations/o1/members", { email: "b@x.z" });
    expect(res.status).toBe(400);
  });

  it("400s invite with a non-assignable role (owner)", async () => {
    const { env, queueFirst } = makeEnv();
    queueFirst({ role: "admin" });
    const res = await call(env, "POST", "/organizations/o1/members", { email: "b@x.z", role: "owner" });
    expect(res.status).toBe(400);
  });

  it("403s when an org admin tries to invite an admin", async () => {
    const { env, queueFirst } = makeEnv();
    queueFirst({ role: "admin" });
    const res = await call(env, "POST", "/organizations/o1/members", { email: "b@x.z", role: "admin" });
    expect(res.status).toBe(403);
  });

  it("429s when the lookup rate limit trips", async () => {
    const { env, queueFirst } = makeEnv({ rateOk: false });
    queueFirst({ role: "admin" });
    const res = await call(env, "POST", "/organizations/o1/members", { email: "b@x.z", role: "viewer" });
    expect(res.status).toBe(429);
  });

  it("404s invite when no user has that email", async () => {
    const { env, queueFirst } = makeEnv({ lookupStatus: 404 });
    queueFirst({ role: "admin" });
    const res = await call(env, "POST", "/organizations/o1/members", { email: "ghost@x.z", role: "viewer" });
    expect(res.status).toBe(404);
  });

  it("409s invite when already a member", async () => {
    const { env, queueFirst } = makeEnv();
    queueFirst({ role: "admin" }); // getOrgRole
    queueFirst({ id: "existing" }); // existing membership
    const res = await call(env, "POST", "/organizations/o1/members", { email: "b@x.z", role: "viewer" });
    expect(res.status).toBe(409);
  });

  it("creates the invite (201)", async () => {
    const { env, queueFirst, run } = makeEnv();
    queueFirst({ role: "admin" });
    queueFirst(null); // not already a member
    const res = await call(env, "POST", "/organizations/o1/members", { email: "b@x.z", role: "editor" });
    expect(res.status).toBe(201);
    expect(run).toHaveBeenCalled();
    const json = (await res.json()) as { data: { role: string; accepted: boolean } };
    expect(json.data.role).toBe("editor");
    expect(json.data.accepted).toBe(false);
  });

  it("PATCH 400s with an invalid role", async () => {
    const { env, queueFirst } = makeEnv();
    queueFirst({ role: "admin" });
    const res = await call(env, "PATCH", "/organizations/o1/members/u2", { role: "owner" });
    expect(res.status).toBe(400);
  });

  it("PATCH 404s when the target isn't a member", async () => {
    const { env, queueFirst } = makeEnv();
    queueFirst({ role: "admin" });
    queueFirst(null); // target row
    const res = await call(env, "PATCH", "/organizations/o1/members/u2", { role: "viewer" });
    expect(res.status).toBe(404);
  });

  it("PATCH 403s when changing the owner's role", async () => {
    const { env, queueFirst } = makeEnv();
    queueFirst({ role: "admin" });
    queueFirst({ id: "m2", role: "owner" });
    const res = await call(env, "PATCH", "/organizations/o1/members/u2", { role: "viewer" });
    expect(res.status).toBe(403);
  });

  it("PATCH 400s with an unknown role (owner not assignable)", async () => {
    const { env, queueFirst } = makeEnv();
    queueFirst({ role: "admin" }); // caller
    const res = await call(env, "PATCH", "/organizations/o1/members/u2", { role: "owner" });
    expect(res.status).toBe(400);
  });

  it("PATCH 403s when an admin promotes a member to admin", async () => {
    const { env, queueFirst } = makeEnv();
    queueFirst({ role: "admin" }); // caller
    queueFirst({ id: "m2", role: "editor" }); // target
    const res = await call(env, "PATCH", "/organizations/o1/members/u2", { role: "admin" });
    expect(res.status).toBe(403);
  });

  it("an owner can promote a member to admin", async () => {
    const { env, queueFirst, run } = makeEnv();
    queueFirst({ role: "owner" }); // caller
    queueFirst({ id: "m2", role: "editor" }); // target
    queueFirst({ id: "m2", organization_id: "o1", user_id: "u2", email: "x", name: "X", role: "admin", invited_by: "caller-1", created_at: "y", accepted: 1 });
    const res = await call(env, "PATCH", "/organizations/o1/members/u2", { role: "admin" });
    expect(res.status).toBe(200);
    expect(run).toHaveBeenCalled();
  });

  it("PATCH 403s when an admin modifies another admin", async () => {
    const { env, queueFirst } = makeEnv();
    queueFirst({ role: "admin" });
    queueFirst({ id: "m2", role: "admin" });
    const res = await call(env, "PATCH", "/organizations/o1/members/u2", { role: "viewer" });
    expect(res.status).toBe(403);
  });

  it("PATCH updates a role for an admin", async () => {
    const { env, queueFirst, run } = makeEnv();
    queueFirst({ role: "admin" }); // caller
    queueFirst({ id: "m2", role: "viewer" }); // target
    queueFirst({ id: "m2", organization_id: "o1", user_id: "u2", email: "x", name: "X", role: "editor", invited_by: "caller-1", created_at: "y", accepted: 1 }); // updated
    const res = await call(env, "PATCH", "/organizations/o1/members/u2", { role: "editor" });
    expect(res.status).toBe(200);
    expect(run).toHaveBeenCalled();
    const json = (await res.json()) as { data: { role: string } };
    expect(json.data.role).toBe("editor");
  });

  function callAs(env: Parameters<typeof handleOrganizations>[1], u: Parameters<typeof handleOrganizations>[2], method: string, path: string) {
    const url = new URL(`http://localhost${path}`);
    return handleOrganizations(new Request(url.toString(), { method }), env, u, url);
  }

  it("DELETE lets a non-owner self-leave", async () => {
    const selfUser = { userId: "u2", email: "x" } as unknown as Parameters<typeof handleOrganizations>[2];
    const { env, queueFirst, run } = makeEnv();
    queueFirst({ role: "editor" }); // getOrgRole for the self caller
    const res = await callAs(env, selfUser, "DELETE", "/organizations/o1/members/u2");
    expect(res.status).toBe(200);
    expect(run).toHaveBeenCalled();
  });

  it("DELETE blocks the owner from self-leaving", async () => {
    const selfUser = { userId: "u2", email: "x" } as unknown as Parameters<typeof handleOrganizations>[2];
    const { env, queueFirst } = makeEnv();
    queueFirst({ role: "owner" });
    const res = await callAs(env, selfUser, "DELETE", "/organizations/o1/members/u2");
    expect(res.status).toBe(403);
  });

  it("DELETE 403s a member below admin removing someone else", async () => {
    const { env, queueFirst } = makeEnv();
    queueFirst({ role: "editor" }); // caller
    const res = await call(env, "DELETE", "/organizations/o1/members/u2");
    expect(res.status).toBe(403);
  });

  it("DELETE 404s when the target isn't a member", async () => {
    const { env, queueFirst } = makeEnv();
    queueFirst({ role: "admin" });
    queueFirst(null); // target row
    const res = await call(env, "DELETE", "/organizations/o1/members/u2");
    expect(res.status).toBe(404);
  });

  it("DELETE 403s removing the owner", async () => {
    const { env, queueFirst } = makeEnv();
    queueFirst({ role: "admin" });
    queueFirst({ id: "m2", role: "owner" });
    const res = await call(env, "DELETE", "/organizations/o1/members/u2");
    expect(res.status).toBe(403);
  });

  it("DELETE 403s an admin removing another admin", async () => {
    const { env, queueFirst } = makeEnv();
    queueFirst({ role: "admin" });
    queueFirst({ id: "m2", role: "admin" });
    const res = await call(env, "DELETE", "/organizations/o1/members/u2");
    expect(res.status).toBe(403);
  });

  it("DELETE lets an admin remove a viewer", async () => {
    const { env, queueFirst, run } = makeEnv();
    queueFirst({ role: "admin" });
    queueFirst({ id: "m2", role: "viewer" });
    const res = await call(env, "DELETE", "/organizations/o1/members/u2");
    expect(res.status).toBe(200);
    expect(run).toHaveBeenCalled();
  });
});
