/**
 * Integration tests for Organizations (run against the local dev servers).
 *
 * Prerequisites (same as integration.test.ts):
 *   1. pnpm dev  (api :8787 + auth :8788, shared .wrangler/state)
 *   2. TURNSTILE_SECRET=1x0000000000000000000000000000000AA in packages/auth/.dev.vars
 *
 * Skipped automatically when the servers are not reachable. Exercises the
 * trickle-down authorization model end to end: an org member's role applies to
 * every site in the org (resolved in lib/access.ts), attach/detach, and the
 * org-owner-owns-every-site rule.
 */

import { describe, it, expect, beforeAll } from "vitest";

const API_URL = "http://localhost:8787";
const TURNSTILE_TOKEN = "test-bypass-token";
const PASSWORD = "Integration-Test-P@ssw0rd!";
const RUN_ID = Date.now();

function ipHeaders(ip: string, extra: Record<string, string> = {}): Record<string, string> {
  return { "Content-Type": "application/json", "CF-Connecting-IP": ip, ...extra };
}

let apiServerUp = false;
try {
  const res = await fetch(`${API_URL}/projects`, { signal: AbortSignal.timeout(1500) });
  apiServerUp = res.status < 500;
} catch { /* not running */ }

async function registerAndLogin(label: string, ip: string): Promise<{ token: string; userId: string; email: string }> {
  const email = `org-${label}-${RUN_ID}@example.com`;
  await fetch(`${API_URL}/register`, {
    method: "POST",
    headers: ipHeaders(ip),
    body: JSON.stringify({ email, password: PASSWORD, name: `Org ${label}`, turnstileToken: TURNSTILE_TOKEN }),
  });
  const loginRes = await fetch(`${API_URL}/login`, {
    method: "POST",
    headers: ipHeaders(ip),
    body: JSON.stringify({ email, password: PASSWORD, turnstileToken: TURNSTILE_TOKEN }),
  });
  const token = (await loginRes.json<{ data?: { token: string } }>()).data?.token ?? "";
  const meRes = await fetch(`${API_URL}/me`, { headers: { Authorization: `Bearer ${token}` } });
  const userId = (await meRes.json<{ data?: { userId: string } }>()).data?.userId ?? "";
  return { token, userId, email };
}

const bearer = (token: string, extra: Record<string, string> = {}) =>
  ({ "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...extra });

describe.skipIf(!apiServerUp)("API - organizations + trickle-down access", () => {
  // userA = org owner; userB = invited member.
  let A = { token: "", userId: "", email: "" };
  let B = { token: "", userId: "", email: "" };
  let orgId = "";
  let orgSiteId = "";      // site created inside the org by A
  let outsideSiteId = "";  // site NOT in the org, owned by A
  let bAdminSiteId = "";   // site created in-org by B (after B becomes admin)
  let attachSiteId = "";   // standalone site owned by A, attached then detached

  beforeAll(async () => {
    A = await registerAndLogin("owner", `10.10.${Math.floor(RUN_ID / 1e7) % 256}.${RUN_ID % 256}`);
    B = await registerAndLogin("member", `10.20.${Math.floor(RUN_ID / 1e7) % 256}.${RUN_ID % 256}`);
    expect(A.token, "owner login failed (rate-limited?)").not.toBe("");
    expect(B.token, "member login failed (rate-limited?)").not.toBe("");
  });

  it("POST /organizations creates an org with the creator as owner", async () => {
    const res = await fetch(`${API_URL}/organizations`, {
      method: "POST", headers: bearer(A.token), body: JSON.stringify({ name: "Acme Org" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json<{ ok: boolean; data: { id: string; role: string } }>();
    expect(body.data.role).toBe("owner");
    orgId = body.data.id;
  });

  it("GET /organizations/:id is 404 for a non-member", async () => {
    const res = await fetch(`${API_URL}/organizations/${orgId}`, { headers: bearer(B.token) });
    expect(res.status).toBe(404);
  });

  it("PATCH /organizations/:id renames (owner)", async () => {
    const res = await fetch(`${API_URL}/organizations/${orgId}`, {
      method: "PATCH", headers: bearer(A.token), body: JSON.stringify({ name: "Acme Inc" }),
    });
    expect(res.status).toBe(200);
  });

  it("POST /organizations/:id/members invites B as editor; B sees it in the unified inbox and accepts", async () => {
    const inviteRes = await fetch(`${API_URL}/organizations/${orgId}/members`, {
      method: "POST", headers: bearer(A.token), body: JSON.stringify({ email: B.email, role: "editor" }),
    });
    expect(inviteRes.status).toBe(201);

    const pendingRes = await fetch(`${API_URL}/pending-invites`, { headers: bearer(B.token) });
    const pending = (await pendingRes.json<{ data: Array<{ id: string; type: string; organizationId?: string }> }>()).data;
    const orgInvite = pending.find(p => p.type === "org" && p.organizationId === orgId);
    expect(orgInvite, "org invite missing from unified pending-invites").toBeTruthy();

    const acceptRes = await fetch(`${API_URL}/pending-invites/${orgInvite!.id}/accept?type=org`, {
      method: "POST", headers: bearer(B.token),
    });
    expect(acceptRes.status).toBe(200);

    const listRes = await fetch(`${API_URL}/organizations`, { headers: bearer(B.token) });
    const orgs = (await listRes.json<{ data: Array<{ id: string; role: string }> }>()).data;
    expect(orgs.find(o => o.id === orgId)?.role).toBe("editor");
  });

  it("trickle-down: B (no direct membership) can READ and WRITE a site in the org", async () => {
    const siteRes = await fetch(`${API_URL}/projects`, {
      method: "POST", headers: bearer(A.token), body: JSON.stringify({ name: "Org Site", organizationId: orgId }),
    });
    expect(siteRes.status).toBe(201);
    orgSiteId = (await siteRes.json<{ data: { id: string } }>()).data.id;

    // Read as B - effective editor via the org, despite no project_members row.
    const readRes = await fetch(`${API_URL}/projects/${orgSiteId}`, { headers: bearer(B.token) });
    expect(readRes.status).toBe(200);
    expect((await readRes.json<{ data: { role: string } }>()).data.role).toBe("editor");

    // Write as B - create a doc.
    const docRes = await fetch(`${API_URL}/docs`, {
      method: "POST", headers: bearer(B.token), body: JSON.stringify({ title: "By B", content: "x", projectId: orgSiteId }),
    });
    expect(docRes.status).toBe(201);
  });

  it("isolation: B has NO access to a site outside the org", async () => {
    const siteRes = await fetch(`${API_URL}/projects`, {
      method: "POST", headers: bearer(A.token), body: JSON.stringify({ name: "Private Site" }),
    });
    outsideSiteId = (await siteRes.json<{ data: { id: string } }>()).data.id;
    const res = await fetch(`${API_URL}/projects/${outsideSiteId}`, { headers: bearer(B.token) });
    expect(res.status).toBe(404);
  });

  it("GET /projects and GET /projects/:id expose the owning org's name", async () => {
    // List form (dashboard cards).
    const listRes = await fetch(`${API_URL}/projects`, { headers: bearer(A.token) });
    const list = (await listRes.json<{ data: Array<{ id: string; organization_id: string | null; organization_name: string | null }> }>()).data;
    const orgSite = list.find(p => p.id === orgSiteId);
    expect(orgSite?.organization_id).toBe(orgId);
    expect(orgSite?.organization_name).toBe("Acme Inc");
    expect(list.find(p => p.id === outsideSiteId)?.organization_name).toBeNull();

    // Single-site form (site settings).
    const oneRes = await fetch(`${API_URL}/projects/${orgSiteId}`, { headers: bearer(A.token) });
    const one = (await oneRes.json<{ data: { organization_id: string | null; organization_name: string | null } }>()).data;
    expect(one.organization_id).toBe(orgId);
    expect(one.organization_name).toBe("Acme Inc");
  });

  it("a non-admin org member cannot create a site in the org or list members", async () => {
    // B is currently editor (< admin).
    const createRes = await fetch(`${API_URL}/projects`, {
      method: "POST", headers: bearer(B.token), body: JSON.stringify({ name: "Nope", organizationId: orgId }),
    });
    expect(createRes.status).toBe(403);

    const membersRes = await fetch(`${API_URL}/organizations/${orgId}/members`, { headers: bearer(B.token) });
    expect(membersRes.status).toBe(403);
  });

  it("org owner = owner on every site: A deletes a site directly owned by B", async () => {
    // Promote B to admin so B can create a site in the org (owned by B).
    const promote = await fetch(`${API_URL}/organizations/${orgId}/members/${B.userId}`, {
      method: "PATCH", headers: bearer(A.token), body: JSON.stringify({ role: "admin" }),
    });
    expect(promote.status).toBe(200);

    const siteRes = await fetch(`${API_URL}/projects`, {
      method: "POST", headers: bearer(B.token), body: JSON.stringify({ name: "B's Org Site", organizationId: orgId }),
    });
    expect(siteRes.status).toBe(201);
    bAdminSiteId = (await siteRes.json<{ data: { id: string } }>()).data.id;

    // A is the ORG owner but has no direct membership on B's site - trickle-down
    // grants effective owner, so the delete (owner-only) succeeds.
    const delRes = await fetch(`${API_URL}/projects/${bAdminSiteId}`, {
      method: "DELETE", headers: bearer(A.token),
    });
    expect(delRes.status).toBe(200);
  });

  it("attach requires org-admin AND direct site ownership; detach revokes trickle-down access", async () => {
    // A creates a standalone site (owned by A, no org).
    const siteRes = await fetch(`${API_URL}/projects`, {
      method: "POST", headers: bearer(A.token), body: JSON.stringify({ name: "Attachable" }),
    });
    attachSiteId = (await siteRes.json<{ data: { id: string } }>()).data.id;

    // B (org admin) is NOT the site owner → 403.
    const bAttach = await fetch(`${API_URL}/organizations/${orgId}/projects/${attachSiteId}/attach`, {
      method: "POST", headers: bearer(B.token),
    });
    expect(bAttach.status).toBe(403);

    // A (org owner + direct site owner) → 200.
    const aAttach = await fetch(`${API_URL}/organizations/${orgId}/projects/${attachSiteId}/attach`, {
      method: "POST", headers: bearer(A.token),
    });
    expect(aAttach.status).toBe(200);

    // B now reaches it via the org.
    const readAttached = await fetch(`${API_URL}/projects/${attachSiteId}`, { headers: bearer(B.token) });
    expect(readAttached.status).toBe(200);

    // Detach, then B loses access.
    const detach = await fetch(`${API_URL}/organizations/${orgId}/projects/${attachSiteId}/attach`, {
      method: "DELETE", headers: bearer(A.token),
    });
    expect(detach.status).toBe(200);
    const readDetached = await fetch(`${API_URL}/projects/${attachSiteId}`, { headers: bearer(B.token) });
    expect(readDetached.status).toBe(404);
  });

  it("escalation guards: an admin cannot remove the org owner", async () => {
    const res = await fetch(`${API_URL}/organizations/${orgId}/members/${A.userId}`, {
      method: "DELETE", headers: bearer(B.token),
    });
    expect(res.status).toBe(403);
  });

  it("DELETE /organizations/:id is owner-only and detaches (not deletes) its sites", async () => {
    // Non-owner (admin B) cannot delete.
    const bDel = await fetch(`${API_URL}/organizations/${orgId}`, { method: "DELETE", headers: bearer(B.token) });
    expect(bDel.status).toBe(403);

    // Owner A deletes the org.
    const aDel = await fetch(`${API_URL}/organizations/${orgId}`, { method: "DELETE", headers: bearer(A.token) });
    expect(aDel.status).toBe(200);

    // The in-org site survives (detached) - A is still its direct owner.
    const siteStillThere = await fetch(`${API_URL}/projects/${orgSiteId}`, { headers: bearer(A.token) });
    expect(siteStillThere.status).toBe(200);

    // B (whose only path was the org) no longer has access to it.
    const bLost = await fetch(`${API_URL}/projects/${orgSiteId}`, { headers: bearer(B.token) });
    expect(bLost.status).toBe(404);
  });
});

describe.skipIf(!apiServerUp)("API - org account-deletion guard + ejected-owner detach", () => {
  let C = { token: "", userId: "", email: "" };
  let D = { token: "", userId: "", email: "" };
  let E = { token: "", userId: "", email: "" };

  beforeAll(async () => {
    C = await registerAndLogin("acct", `10.30.${Math.floor(RUN_ID / 1e7) % 256}.${RUN_ID % 256}`);
    D = await registerAndLogin("orgd", `10.40.${Math.floor(RUN_ID / 1e7) % 256}.${RUN_ID % 256}`);
    E = await registerAndLogin("ejected", `10.50.${Math.floor(RUN_ID / 1e7) % 256}.${RUN_ID % 256}`);
    expect(C.token, "C login failed").not.toBe("");
    expect(D.token && E.token, "D/E login failed").toBeTruthy();
  });

  it("DELETE /me is blocked while the user still owns an organization", async () => {
    const orgRes = await fetch(`${API_URL}/organizations`, {
      method: "POST", headers: bearer(C.token), body: JSON.stringify({ name: "C's Org" }),
    });
    const cOrgId = (await orgRes.json<{ data: { id: string } }>()).data.id;

    const delMe = await fetch(`${API_URL}/me`, {
      method: "DELETE", headers: bearer(C.token), body: JSON.stringify({ password: "x" }),
    });
    expect(delMe.status).toBe(400);
    expect((await delMe.json<{ error: string }>()).error).toBe("owns_organizations");

    // Cleanup: deleting the org clears the guard.
    const delOrg = await fetch(`${API_URL}/organizations/${cOrgId}`, { method: "DELETE", headers: bearer(C.token) });
    expect(delOrg.status).toBe(200);
  });

  it("a direct site owner ejected from the org can still detach their own site", async () => {
    // D owns an org; E joins as admin and creates a site in it (owned by E).
    const orgRes = await fetch(`${API_URL}/organizations`, {
      method: "POST", headers: bearer(D.token), body: JSON.stringify({ name: "D Org" }),
    });
    const dOrgId = (await orgRes.json<{ data: { id: string } }>()).data.id;

    await fetch(`${API_URL}/organizations/${dOrgId}/members`, {
      method: "POST", headers: bearer(D.token), body: JSON.stringify({ email: E.email, role: "admin" }),
    });
    const pending = (await (await fetch(`${API_URL}/pending-invites`, { headers: bearer(E.token) })).json<{ data: Array<{ id: string; type: string; organizationId?: string }> }>()).data;
    const inv = pending.find(p => p.type === "org" && p.organizationId === dOrgId)!;
    await fetch(`${API_URL}/pending-invites/${inv.id}/accept?type=org`, { method: "POST", headers: bearer(E.token) });

    const siteRes = await fetch(`${API_URL}/projects`, {
      method: "POST", headers: bearer(E.token), body: JSON.stringify({ name: "E's Site", organizationId: dOrgId }),
    });
    const eSiteId = (await siteRes.json<{ data: { id: string } }>()).data.id;

    // D ejects E from the org. The site stays attached (organization_id unchanged).
    const eject = await fetch(`${API_URL}/organizations/${dOrgId}/members/${E.userId}`, {
      method: "DELETE", headers: bearer(D.token),
    });
    expect(eject.status).toBe(200);

    // E is no longer an org member but is still the DIRECT owner of the site -
    // detach must succeed (previously a 404 dead-end).
    const detach = await fetch(`${API_URL}/organizations/${dOrgId}/projects/${eSiteId}/attach`, {
      method: "DELETE", headers: bearer(E.token),
    });
    expect(detach.status).toBe(200);

    // The site is now org-less.
    const siteAfter = await fetch(`${API_URL}/projects/${eSiteId}`, { headers: bearer(E.token) });
    expect((await siteAfter.json<{ data: { organization_id: string | null } }>()).data.organization_id).toBeNull();
  });
});

describe.skipIf(!apiServerUp)("API - org member removal & self-leave revoke trickle-down", () => {
  // F = org owner; G = removed member; H = self-leaving member.
  let F = { token: "", userId: "", email: "" };
  let G = { token: "", userId: "", email: "" };
  let H = { token: "", userId: "", email: "" };
  let orgId = "";
  let siteId = "";

  // Invite `who` into the org as editor and accept via the unified inbox.
  async function joinOrgAsEditor(who: { token: string; email: string }): Promise<void> {
    const invite = await fetch(`${API_URL}/organizations/${orgId}/members`, {
      method: "POST", headers: bearer(F.token), body: JSON.stringify({ email: who.email, role: "editor" }),
    });
    expect(invite.status).toBe(201);
    const pending = (await (await fetch(`${API_URL}/pending-invites`, { headers: bearer(who.token) }))
      .json<{ data: Array<{ id: string; type: string; organizationId?: string }> }>()).data;
    const inv = pending.find(p => p.type === "org" && p.organizationId === orgId);
    expect(inv, "org invite missing from unified pending-invites").toBeTruthy();
    const accept = await fetch(`${API_URL}/pending-invites/${inv!.id}/accept?type=org`, {
      method: "POST", headers: bearer(who.token),
    });
    expect(accept.status).toBe(200);
  }

  beforeAll(async () => {
    F = await registerAndLogin("rmowner", `10.60.${Math.floor(RUN_ID / 1e7) % 256}.${RUN_ID % 256}`);
    G = await registerAndLogin("removed", `10.70.${Math.floor(RUN_ID / 1e7) % 256}.${RUN_ID % 256}`);
    H = await registerAndLogin("selfleave", `10.80.${Math.floor(RUN_ID / 1e7) % 256}.${RUN_ID % 256}`);
    expect(F.token, "F login failed").not.toBe("");
    expect(G.token && H.token, "G/H login failed").toBeTruthy();

    const orgRes = await fetch(`${API_URL}/organizations`, {
      method: "POST", headers: bearer(F.token), body: JSON.stringify({ name: "Removal Org" }),
    });
    orgId = (await orgRes.json<{ data: { id: string } }>()).data.id;

    const siteRes = await fetch(`${API_URL}/projects`, {
      method: "POST", headers: bearer(F.token), body: JSON.stringify({ name: "Removal Site", organizationId: orgId }),
    });
    siteId = (await siteRes.json<{ data: { id: string } }>()).data.id;
  });

  it("removing an org-only member revokes trickle-down READ and WRITE", async () => {
    await joinOrgAsEditor(G);

    // G has no direct project_members row - access is purely org trickle-down.
    const readBefore = await fetch(`${API_URL}/projects/${siteId}`, { headers: bearer(G.token) });
    expect(readBefore.status).toBe(200);
    expect((await readBefore.json<{ data: { role: string } }>()).data.role).toBe("editor");
    const writeBefore = await fetch(`${API_URL}/docs`, {
      method: "POST", headers: bearer(G.token), body: JSON.stringify({ title: "G doc", content: "x", projectId: siteId }),
    });
    expect(writeBefore.status).toBe(201);

    // F removes G from the org.
    const remove = await fetch(`${API_URL}/organizations/${orgId}/members/${G.userId}`, {
      method: "DELETE", headers: bearer(F.token),
    });
    expect(remove.status).toBe(200);

    // Trickle-down is gone on the very next request - read 404, write 403.
    const readAfter = await fetch(`${API_URL}/projects/${siteId}`, { headers: bearer(G.token) });
    expect(readAfter.status).toBe(404);
    const writeAfter = await fetch(`${API_URL}/docs`, {
      method: "POST", headers: bearer(G.token), body: JSON.stringify({ title: "nope", content: "x", projectId: siteId }),
    });
    expect(writeAfter.status).toBe(403);
  });

  it("a member who self-leaves the org loses trickle-down READ and WRITE", async () => {
    await joinOrgAsEditor(H);

    const readBefore = await fetch(`${API_URL}/projects/${siteId}`, { headers: bearer(H.token) });
    expect(readBefore.status).toBe(200);

    // H removes their OWN org membership (self-leave branch).
    const leave = await fetch(`${API_URL}/organizations/${orgId}/members/${H.userId}`, {
      method: "DELETE", headers: bearer(H.token),
    });
    expect(leave.status).toBe(200);

    const readAfter = await fetch(`${API_URL}/projects/${siteId}`, { headers: bearer(H.token) });
    expect(readAfter.status).toBe(404);
    const writeAfter = await fetch(`${API_URL}/docs`, {
      method: "POST", headers: bearer(H.token), body: JSON.stringify({ title: "nope", content: "x", projectId: siteId }),
    });
    expect(writeAfter.status).toBe(403);
  });
});
