/**
 * Integration tests for scoped API keys + the public /v1 surface.
 *
 * Runs against the local dev servers (see integration.test.ts for the setup
 * contract). Auto-skips when the servers are not reachable.
 *
 * These are the "strict" security tests: they assert there are no auth leaks,
 * no permission bypasses, no scope escalation, and no cross-site access, in
 * addition to confirming the happy paths work.
 */

import { describe, it, expect, beforeAll } from "vitest";

const AUTH_URL = "http://localhost:8788";
const API_URL = "http://localhost:8787";

const TURNSTILE_TOKEN = "test-bypass-token";
const RUN_ID = Date.now();
const PASSWORD = "Api-Keys-Test-P@ssw0rd!";

let apiServerUp = false;
try {
  const res = await fetch(`${API_URL}/projects`, { signal: AbortSignal.timeout(1500) });
  apiServerUp = res.status < 500;
} catch { /* not running */ }
try {
  const res = await fetch(`${AUTH_URL}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(1500),
  });
  apiServerUp = apiServerUp && res.status < 500;
} catch { apiServerUp = false; }

// Each user gets its own CF-Connecting-IP so the per-IP auth limiter doesn't
// bleed across registrations/logins.
let ipCounter = 0;
function nextIp(): string {
  ipCounter += 1;
  return `10.90.${Math.floor(RUN_ID / 1e7) % 256}.${(RUN_ID + ipCounter) % 256}`;
}

function decodeUserId(jwt: string): string {
  const payload = JSON.parse(atob(jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
  return payload.userId as string;
}

async function registerAndLogin(label: string): Promise<{ token: string; userId: string; email: string }> {
  const email = `apikey-${label}-${RUN_ID}@example.com`;
  const ip = nextIp();
  const headers = { "Content-Type": "application/json", "CF-Connecting-IP": ip };
  await fetch(`${API_URL}/register`, {
    method: "POST", headers,
    body: JSON.stringify({ email, password: PASSWORD, name: `Api Key ${label}`, turnstileToken: TURNSTILE_TOKEN }),
  });
  const loginRes = await fetch(`${API_URL}/login`, {
    method: "POST", headers,
    body: JSON.stringify({ email, password: PASSWORD, turnstileToken: TURNSTILE_TOKEN }),
  });
  const body = await loginRes.json<{ ok: boolean; data?: { token: string } }>();
  const token = body.data?.token ?? "";
  return { token, userId: token ? decodeUserId(token) : "", email };
}

function jwt(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...extra };
}
function key(secret: string): Record<string, string> {
  return { "Content-Type": "application/json", Authorization: `Bearer ${secret}` };
}

async function createKey(
  jwtToken: string,
  projectId: string,
  opts: { name?: string; scope: "read" | "readwrite"; canInvite?: boolean },
): Promise<{ status: number; secret?: string; id?: string }> {
  const res = await fetch(`${API_URL}/projects/${projectId}/api-keys`, {
    method: "POST",
    headers: jwt(jwtToken),
    body: JSON.stringify({ name: opts.name ?? "test key", scope: opts.scope, canInvite: opts.canInvite ?? false }),
  });
  const body = await res.json<{ ok: boolean; data?: { id: string; secret: string } }>()
    .catch(() => ({ ok: false } as { ok: boolean; data?: { id: string; secret: string } }));
  return { status: res.status, secret: body.data?.secret, id: body.data?.id };
}

describe.skipIf(!apiServerUp)("API keys — management endpoints", () => {
  let ownerToken = "";
  let outsiderToken = "";
  let projectId = "";

  beforeAll(async () => {
    ownerToken = (await registerAndLogin("mgmt-owner")).token;
    outsiderToken = (await registerAndLogin("mgmt-outsider")).token;
    expect(ownerToken).not.toBe("");
    const projRes = await fetch(`${API_URL}/projects`, {
      method: "POST", headers: jwt(ownerToken), body: JSON.stringify({ name: "Key Mgmt Project" }),
    });
    projectId = (await projRes.json<{ data: { id: string } }>()).data.id;
  });

  it("returns the secret exactly once on create, prefixed with annx_", async () => {
    const created = await createKey(ownerToken, projectId, { scope: "read", name: "first" });
    expect(created.status).toBe(201);
    expect(created.secret?.startsWith("annx_")).toBe(true);
  });

  it("never exposes the secret (or hash) when listing keys", async () => {
    const res = await fetch(`${API_URL}/projects/${projectId}/api-keys`, { headers: jwt(ownerToken) });
    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean; data: Record<string, unknown>[] }>();
    expect(body.ok).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);
    for (const k of body.data) {
      expect(k).not.toHaveProperty("secret");
      expect(k).not.toHaveProperty("keyHash");
      expect(k).not.toHaveProperty("key_hash");
      expect(typeof k.keyPrefix).toBe("string");
    }
  });

  it("rejects creation for a non-member (404, hides the site)", async () => {
    const created = await createKey(outsiderToken, projectId, { scope: "read" });
    expect(created.status).toBe(404);
  });

  it("rejects an invalid scope", async () => {
    const res = await fetch(`${API_URL}/projects/${projectId}/api-keys`, {
      method: "POST", headers: jwt(ownerToken), body: JSON.stringify({ name: "bad", scope: "admin" }),
    });
    expect(res.status).toBe(400);
  });

  it("revokes a key, after which it no longer authenticates", async () => {
    const created = await createKey(ownerToken, projectId, { scope: "readwrite", name: "to-revoke" });
    expect(created.status).toBe(201);
    // Works before revocation.
    const before = await fetch(`${API_URL}/v1/docs`, { headers: key(created.secret!) });
    expect(before.status).toBe(200);
    // Revoke.
    const del = await fetch(`${API_URL}/projects/${projectId}/api-keys/${created.id}`, { method: "DELETE", headers: jwt(ownerToken) });
    expect(del.status).toBe(200);
    // Dead afterwards.
    const after = await fetch(`${API_URL}/v1/docs`, { headers: key(created.secret!) });
    expect(after.status).toBe(401);
  });
});

describe.skipIf(!apiServerUp)("API keys — /v1 auth boundary (no leaks)", () => {
  let ownerToken = "";
  let projectId = "";
  let readSecret = "";

  beforeAll(async () => {
    const owner = await registerAndLogin("bnd-owner");
    ownerToken = owner.token;
    const projRes = await fetch(`${API_URL}/projects`, {
      method: "POST", headers: jwt(ownerToken), body: JSON.stringify({ name: "Boundary Project" }),
    });
    projectId = (await projRes.json<{ data: { id: string } }>()).data.id;
    readSecret = (await createKey(ownerToken, projectId, { scope: "read" })).secret!;
  });

  it("rejects /v1 with no Authorization (401)", async () => {
    expect((await fetch(`${API_URL}/v1/docs`)).status).toBe(401);
  });

  it("rejects /v1 with a garbage bearer token (401)", async () => {
    expect((await fetch(`${API_URL}/v1/docs`, { headers: key("annx_not_a_real_key") })).status).toBe(401);
    expect((await fetch(`${API_URL}/v1/docs`, { headers: key("totally-bogus") })).status).toBe(401);
  });

  it("rejects a valid JWT on /v1 — JWTs are not accepted there (401)", async () => {
    const res = await fetch(`${API_URL}/v1/docs`, { headers: jwt(ownerToken) });
    expect(res.status).toBe(401);
  });

  it("rejects an API key on a JWT-only route — keys can't escape /v1 (401)", async () => {
    // The critical isolation test: a scoped key aimed at the broad /projects
    // route must NOT be honoured (which would bypass its site/scope ceiling).
    expect((await fetch(`${API_URL}/projects`, { headers: key(readSecret) })).status).toBe(401);
    expect((await fetch(`${API_URL}/docs?projectId=${projectId}`, { headers: key(readSecret) })).status).toBe(401);
    expect((await fetch(`${API_URL}/me`, { headers: key(readSecret) })).status).toBe(401);
  });
});

describe.skipIf(!apiServerUp)("API keys — scope enforcement (read vs read-write)", () => {
  let ownerToken = "";
  let projectId = "";
  let docId = "";
  let readSecret = "";
  let rwSecret = "";

  beforeAll(async () => {
    ownerToken = (await registerAndLogin("scope-owner")).token;
    const projRes = await fetch(`${API_URL}/projects`, {
      method: "POST", headers: jwt(ownerToken), body: JSON.stringify({ name: "Scope Project" }),
    });
    projectId = (await projRes.json<{ data: { id: string } }>()).data.id;
    const docRes = await fetch(`${API_URL}/docs`, {
      method: "POST", headers: jwt(ownerToken), body: JSON.stringify({ title: "Doc One", content: "# One", projectId }),
    });
    docId = (await docRes.json<{ data: { id: string } }>()).data.id;
    readSecret = (await createKey(ownerToken, projectId, { scope: "read" })).secret!;
    rwSecret = (await createKey(ownerToken, projectId, { scope: "readwrite" })).secret!;
  });

  it("read key can list and get docs", async () => {
    const list = await fetch(`${API_URL}/v1/docs`, { headers: key(readSecret) });
    expect(list.status).toBe(200);
    const body = await list.json<{ ok: boolean; data: { id: string }[] }>();
    expect(body.data.some(d => d.id === docId)).toBe(true);

    const get = await fetch(`${API_URL}/v1/docs/${docId}`, { headers: key(readSecret) });
    expect(get.status).toBe(200);
    expect((await get.json<{ data: { content: string } }>()).data.content).toContain("One");
  });

  it("read key is rejected on every mutation (403)", async () => {
    const create = await fetch(`${API_URL}/v1/docs`, { method: "POST", headers: key(readSecret), body: JSON.stringify({ title: "Nope" }) });
    expect(create.status).toBe(403);
    const patch = await fetch(`${API_URL}/v1/docs/${docId}`, { method: "PATCH", headers: key(readSecret), body: JSON.stringify({ title: "Nope" }) });
    expect(patch.status).toBe(403);
    const del = await fetch(`${API_URL}/v1/docs/${docId}`, { method: "DELETE", headers: key(readSecret) });
    expect(del.status).toBe(403);
  });

  it("read key cannot touch members (403 — no canInvite)", async () => {
    expect((await fetch(`${API_URL}/v1/members`, { headers: key(readSecret) })).status).toBe(403);
    const post = await fetch(`${API_URL}/v1/members`, { method: "POST", headers: key(readSecret), body: JSON.stringify({ email: "x@y.z", role: "viewer" }) });
    expect(post.status).toBe(403);
  });

  it("read-write key can create, edit, move and delete docs", async () => {
    // Create
    const create = await fetch(`${API_URL}/v1/docs`, { method: "POST", headers: key(rwSecret), body: JSON.stringify({ title: "RW Doc", content: "# RW" }) });
    expect(create.status).toBe(201);
    const newId = (await create.json<{ data: { id: string } }>()).data.id;

    // Edit
    const patch = await fetch(`${API_URL}/v1/docs/${newId}`, { method: "PATCH", headers: key(rwSecret), body: JSON.stringify({ title: "RW Doc Edited" }) });
    expect(patch.status).toBe(200);
    expect((await patch.json<{ data: { title: string } }>()).data.title).toBe("RW Doc Edited");

    // Move: invalid folder → 400; root (null) → 200.
    const badMove = await fetch(`${API_URL}/v1/docs/${newId}`, { method: "PATCH", headers: key(rwSecret), body: JSON.stringify({ folderId: "no-such-folder" }) });
    expect(badMove.status).toBe(400);
    const move = await fetch(`${API_URL}/v1/docs/${newId}`, { method: "PATCH", headers: key(rwSecret), body: JSON.stringify({ folderId: null }) });
    expect(move.status).toBe(200);

    // Delete
    const del = await fetch(`${API_URL}/v1/docs/${newId}`, { method: "DELETE", headers: key(rwSecret) });
    expect(del.status).toBe(200);
    expect((await fetch(`${API_URL}/v1/docs/${newId}`, { headers: key(rwSecret) })).status).toBe(404);
  });
});

describe.skipIf(!apiServerUp)("API keys — cross-site isolation", () => {
  let aToken = "";
  let bToken = "";
  let projectA = "";
  let docInB = "";
  let aRwSecret = "";

  beforeAll(async () => {
    aToken = (await registerAndLogin("iso-a")).token;
    bToken = (await registerAndLogin("iso-b")).token;
    projectA = (await (await fetch(`${API_URL}/projects`, { method: "POST", headers: jwt(aToken), body: JSON.stringify({ name: "Iso A" }) })).json<{ data: { id: string } }>()).data.id;
    const projectB = (await (await fetch(`${API_URL}/projects`, { method: "POST", headers: jwt(bToken), body: JSON.stringify({ name: "Iso B" }) })).json<{ data: { id: string } }>()).data.id;
    docInB = (await (await fetch(`${API_URL}/docs`, { method: "POST", headers: jwt(bToken), body: JSON.stringify({ title: "B doc", content: "# B", projectId: projectB }) })).json<{ data: { id: string } }>()).data.id;
    aRwSecret = (await createKey(aToken, projectA, { scope: "readwrite", canInvite: true })).secret!;
  });

  it("a key scoped to site A cannot read a doc in site B (404)", async () => {
    expect((await fetch(`${API_URL}/v1/docs/${docInB}`, { headers: key(aRwSecret) })).status).toBe(404);
  });

  it("a key scoped to site A cannot edit or delete a doc in site B (404)", async () => {
    expect((await fetch(`${API_URL}/v1/docs/${docInB}`, { method: "PATCH", headers: key(aRwSecret), body: JSON.stringify({ title: "hijack" }) })).status).toBe(404);
    expect((await fetch(`${API_URL}/v1/docs/${docInB}`, { method: "DELETE", headers: key(aRwSecret) })).status).toBe(404);
  });

  it("a key's doc list only contains its own site's docs", async () => {
    const list = await fetch(`${API_URL}/v1/docs`, { headers: key(aRwSecret) });
    const body = await list.json<{ data: { id: string }[] }>();
    expect(body.data.some(d => d.id === docInB)).toBe(false);
  });
});

describe.skipIf(!apiServerUp)("API keys — key is only a ceiling on the owner's live role", () => {
  it("a read-write key owned by a viewer cannot write, and dies when the owner is removed", async () => {
    const owner = await registerAndLogin("ceil-owner");
    const viewer = await registerAndLogin("ceil-viewer");

    const projectId = (await (await fetch(`${API_URL}/projects`, { method: "POST", headers: jwt(owner.token), body: JSON.stringify({ name: "Ceiling Project" }) })).json<{ data: { id: string } }>()).data.id;

    // Invite the viewer and have them accept (becomes an accepted member).
    const invite = await fetch(`${API_URL}/projects/${projectId}/members`, {
      method: "POST", headers: jwt(owner.token), body: JSON.stringify({ email: viewer.email, role: "viewer" }),
    });
    const inviteId = (await invite.json<{ data: { id: string } }>()).data.id;
    const accept = await fetch(`${API_URL}/pending-invites/${inviteId}/accept`, { method: "POST", headers: jwt(viewer.token) });
    expect(accept.status).toBe(200);

    // A non-admin cannot mint an invite-capable key at all — the management
    // endpoint rejects canInvite when the creator's role is below admin.
    const inviteAttempt = await createKey(viewer.token, projectId, { scope: "readwrite", canInvite: true });
    expect(inviteAttempt.status).toBe(403);

    // The viewer can still mint a read-write key (the scope is a ceiling, not a
    // grant — it can't actually write while their live role is below editor).
    const rw = await createKey(viewer.token, projectId, { scope: "readwrite", canInvite: false });
    expect(rw.status).toBe(201);

    // Read works (viewer can read)…
    expect((await fetch(`${API_URL}/v1/docs`, { headers: key(rw.secret!) })).status).toBe(200);
    // …but writing is refused: the live viewer role is below editor.
    expect((await fetch(`${API_URL}/v1/docs`, { method: "POST", headers: key(rw.secret!), body: JSON.stringify({ title: "should fail" }) })).status).toBe(403);
    // …and member management is refused: this key has no canInvite capability.
    expect((await fetch(`${API_URL}/v1/members`, { method: "POST", headers: key(rw.secret!), body: JSON.stringify({ email: "x@y.z", role: "viewer" }) })).status).toBe(403);

    // Remove the viewer from the site → the key is instantly neutered.
    const remove = await fetch(`${API_URL}/projects/${projectId}/members/${viewer.userId}`, { method: "DELETE", headers: jwt(owner.token) });
    expect(remove.status).toBe(200);
    expect((await fetch(`${API_URL}/v1/docs`, { headers: key(rw.secret!) })).status).toBe(403);
  });
});

describe.skipIf(!apiServerUp)("API keys — invites via /v1/members", () => {
  let ownerToken = "";
  let projectId = "";
  let inviteeEmail = "";
  let inviteeUserId = "";
  let inviteSecret = "";
  let rwOnlySecret = "";

  beforeAll(async () => {
    ownerToken = (await registerAndLogin("inv-owner")).token;
    const invitee = await registerAndLogin("inv-target");
    inviteeEmail = invitee.email;
    inviteeUserId = invitee.userId;
    projectId = (await (await fetch(`${API_URL}/projects`, { method: "POST", headers: jwt(ownerToken), body: JSON.stringify({ name: "Invite Project" }) })).json<{ data: { id: string } }>()).data.id;
    inviteSecret = (await createKey(ownerToken, projectId, { scope: "read", canInvite: true })).secret!;
    rwOnlySecret = (await createKey(ownerToken, projectId, { scope: "readwrite", canInvite: false })).secret!;
  });

  it("an invite-capable key (owner is admin) can invite a user", async () => {
    const res = await fetch(`${API_URL}/v1/members`, {
      method: "POST", headers: key(inviteSecret), body: JSON.stringify({ email: inviteeEmail, role: "viewer" }),
    });
    expect(res.status).toBe(201);
    const list = await fetch(`${API_URL}/v1/members`, { headers: key(inviteSecret) });
    const body = await list.json<{ data: { userId: string; accepted: boolean }[] }>();
    expect(body.data.some(m => m.userId === inviteeUserId && m.accepted === false)).toBe(true);
  });

  it("cannot assign the owner role via the API (400)", async () => {
    const res = await fetch(`${API_URL}/v1/members`, {
      method: "POST", headers: key(inviteSecret), body: JSON.stringify({ email: "someone@example.com", role: "owner" }),
    });
    expect(res.status).toBe(400);
  });

  it("a key without canInvite cannot invite or list members (403)", async () => {
    expect((await fetch(`${API_URL}/v1/members`, { method: "POST", headers: key(rwOnlySecret), body: JSON.stringify({ email: inviteeEmail, role: "viewer" }) })).status).toBe(403);
    expect((await fetch(`${API_URL}/v1/members`, { headers: key(rwOnlySecret) })).status).toBe(403);
  });

  it("can revoke a pending invite", async () => {
    const res = await fetch(`${API_URL}/v1/members/${inviteeUserId}`, { method: "DELETE", headers: key(inviteSecret) });
    expect(res.status).toBe(200);
    const list = await fetch(`${API_URL}/v1/members`, { headers: key(inviteSecret) });
    const body = await list.json<{ data: { userId: string }[] }>();
    expect(body.data.some(m => m.userId === inviteeUserId)).toBe(false);
  });
});

describe.skipIf(!apiServerUp)("API keys — rate limiting", () => {
  it("a burst on /v1 only ever yields 200 or 429 (never 5xx)", async () => {
    const owner = await registerAndLogin("rl-owner");
    const projectId = (await (await fetch(`${API_URL}/projects`, { method: "POST", headers: jwt(owner.token), body: JSON.stringify({ name: "RL Project" }) })).json<{ data: { id: string } }>()).data.id;
    const secret = (await createKey(owner.token, projectId, { scope: "read" })).secret!;

    const statuses = await Promise.all(
      Array.from({ length: 140 }, () => fetch(`${API_URL}/v1/docs`, { headers: key(secret) }).then(r => r.status)),
    );
    // Wiring assertion: every response is a well-formed success or a rate-limit,
    // never a crash. When the limiter enforces locally, some are 429.
    expect(statuses.every(s => s === 200 || s === 429)).toBe(true);
  });
});
