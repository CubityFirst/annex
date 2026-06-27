/**
 * Integration tests that run against the local dev servers.
 *
 * Prerequisites:
 *   1. Start both workers from the repo root:  pnpm dev
 *   2. Set TURNSTILE_SECRET=1x0000000000000000000000000000000AA in
 *      packages/auth/.dev.vars (Cloudflare's always-pass test secret).
 *
 * Tests are skipped automatically when the servers are not reachable.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";

const AUTH_URL = "http://localhost:8788";
const API_URL  = "http://localhost:8787";

// Any token is accepted by Cloudflare's always-pass test secret.
const TURNSTILE_TOKEN = "test-bypass-token";

// Unique per-run values to avoid conflicts and rate-limit collisions between runs.
const RUN_ID = Date.now();
const EMAIL    = `integration-test-${RUN_ID}@example.com`;
const PASSWORD = "Integration-Test-P@ssw0rd!";
const NAME     = "Integration Test User";

// Pass a unique IP per run so each run gets its own rate-limit bucket.
// In local wrangler dev, CF-Connecting-IP is read as a plain header.
const FAKE_IP = `10.${Math.floor(RUN_ID / 1e10) % 256}.${Math.floor(RUN_ID / 1e7) % 256}.${RUN_ID % 256}`;

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { "Content-Type": "application/json", "CF-Connecting-IP": FAKE_IP, ...extra };
}

let authServerUp = false;
let apiServerUp  = false;

try {
  const res = await fetch(`${AUTH_URL}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(1500),
  });
  authServerUp = res.status < 500;
} catch { /* not running */ }

try {
  const res = await fetch(`${API_URL}/projects`, {
    signal: AbortSignal.timeout(1500),
  });
  apiServerUp = res.status < 500;
} catch { /* not running */ }

const serversUp = authServerUp && apiServerUp;

// ── Auth worker ──────────────────────────────────────────────────────────────

describe.skipIf(!authServerUp)("auth worker - /register and /login", () => {
  it("rejects register with missing fields", async () => {
    const res = await fetch(`${AUTH_URL}/register`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ email: EMAIL }),
    });
    expect(res.status).toBe(400);
  });

  it("registers a new user successfully", async () => {
    const res = await fetch(`${AUTH_URL}/register`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ email: EMAIL, password: PASSWORD, name: NAME, turnstileToken: TURNSTILE_TOKEN }),
    });
    expect(res.status).toBe(201);
    const body = await res.json<{ ok: boolean }>();
    expect(body.ok).toBe(true);
  });

  it("rejects a duplicate registration", async () => {
    const res = await fetch(`${AUTH_URL}/register`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ email: EMAIL, password: PASSWORD, name: NAME, turnstileToken: TURNSTILE_TOKEN }),
    });
    expect(res.status).toBe(409);
  });

  it("rejects login with wrong password", async () => {
    const res = await fetch(`${AUTH_URL}/login`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ email: EMAIL, password: "wrong-password", turnstileToken: TURNSTILE_TOKEN }),
    });
    expect(res.status).toBe(401);
  });

  it("logs in successfully and returns a JWT", async () => {
    const res = await fetch(`${AUTH_URL}/login`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ email: EMAIL, password: PASSWORD, turnstileToken: TURNSTILE_TOKEN }),
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean; data: { token: string } }>();
    expect(body.ok).toBe(true);
    expect(typeof body.data.token).toBe("string");
    expect(body.data.token.split(".")).toHaveLength(3);
  });
});

// ── Full API flow ────────────────────────────────────────────────────────────

describe.skipIf(!serversUp)("API - authenticated project + doc flow", () => {
  let token = "";
  let projectId = "";
  let docId = "";

  beforeAll(async () => {
    // Register + login to get a token.  Re-register in case the auth-only suite
    // above was skipped (servers both up but auth wasn't probed separately).
    const flowEmail = `api-flow-${RUN_ID}@example.com`;
    await fetch(`${API_URL}/register`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ email: flowEmail, password: PASSWORD, name: NAME, turnstileToken: TURNSTILE_TOKEN }),
    });
    const loginRes = await fetch(`${API_URL}/login`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ email: flowEmail, password: PASSWORD, turnstileToken: TURNSTILE_TOKEN }),
    });
    const loginBody = await loginRes.json<{ ok: boolean; data: { token: string } }>();
    token = loginBody.data?.token ?? "";
  });

  it("returns 401 for unauthenticated requests to /projects", async () => {
    const res = await fetch(`${API_URL}/projects`);
    expect(res.status).toBe(401);
  });

  it("GET /projects returns an empty list for a new user", async () => {
    const res = await fetch(`${API_URL}/projects`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean; data: unknown[] }>();
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
  });

  it("POST /projects creates a project", async () => {
    const res = await fetch(`${API_URL}/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: "Integration Test Project" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json<{ ok: boolean; data: { id: string; name: string } }>();
    expect(body.ok).toBe(true);
    expect(body.data.name).toBe("Integration Test Project");
    projectId = body.data.id;
  });

  it("POST /docs creates a doc inside the project", async () => {
    const res = await fetch(`${API_URL}/docs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ title: "Hello World", content: "# Hello World\n\nTest content.", projectId }),
    });
    expect(res.status).toBe(201);
    const body = await res.json<{ ok: boolean; data: { id: string; title: string } }>();
    expect(body.ok).toBe(true);
    expect(body.data.title).toBe("Hello World");
    docId = body.data.id;
  });

  it("GET /docs/:id returns the doc", async () => {
    const res = await fetch(`${API_URL}/docs/${docId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean; data: { title: string } }>();
    expect(body.data.title).toBe("Hello World");
  });

  it("PUT /docs/:id updates the doc title", async () => {
    const res = await fetch(`${API_URL}/docs/${docId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ title: "Updated Title", content: "# Updated" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean; data: { title: string } }>();
    expect(body.data.title).toBe("Updated Title");
  });

  it("DELETE /docs/:id removes the doc", async () => {
    const res = await fetch(`${API_URL}/docs/${docId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
  });

  it("GET /docs/:id returns 404 after deletion", async () => {
    const res = await fetch(`${API_URL}/docs/${docId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
  });

  it("DELETE /projects/:id removes the project", async () => {
    const res = await fetch(`${API_URL}/projects/${projectId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
  });
});

// ── Drawing files - mutable content (PUT /files/:id/content) ─────────────────
// Drawings are the one file kind whose R2 blob may be overwritten in place. The
// route must accept overwrites only for the Excalidraw vendor MIME, bust the
// content ETag on save, and reject overwrites of immutable media.

describe.skipIf(!serversUp)("API - drawing file content overwrite", () => {
  let token = "";
  let projectId = "";
  let drawingId = "";
  let textId = "";

  const EXCALIDRAW_MIME = "application/vnd.excalidraw+json";
  const emptyScene = JSON.stringify({ type: "excalidraw", version: 2, source: "test", elements: [], appState: {}, files: {} });

  beforeAll(async () => {
    const email = `draw-flow-${RUN_ID}@example.com`;
    await fetch(`${API_URL}/register`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ email, password: PASSWORD, name: NAME, turnstileToken: TURNSTILE_TOKEN }),
    });
    const loginRes = await fetch(`${API_URL}/login`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ email, password: PASSWORD, turnstileToken: TURNSTILE_TOKEN }),
    });
    token = (await loginRes.json<{ data: { token: string } }>()).data?.token ?? "";

    const projRes = await fetch(`${API_URL}/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: "Drawing Test Project" }),
    });
    projectId = (await projRes.json<{ data: { id: string } }>()).data.id;

    const drawForm = new FormData();
    drawForm.append("file", new File([emptyScene], "diagram.excalidraw", { type: EXCALIDRAW_MIME }));
    drawForm.append("projectId", projectId);
    const drawRes = await fetch(`${API_URL}/files`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: drawForm,
    });
    drawingId = (await drawRes.json<{ data: { id: string } }>()).data.id;

    const textForm = new FormData();
    textForm.append("file", new File(["plain"], "notes.txt", { type: "text/plain" }));
    textForm.append("projectId", projectId);
    const textRes = await fetch(`${API_URL}/files`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: textForm,
    });
    textId = (await textRes.json<{ data: { id: string } }>()).data.id;
  });

  it("PUT /files/:id/content overwrites a drawing and busts the ETag", async () => {
    const before = await fetch(`${API_URL}/files/${drawingId}/content`, { headers: { Authorization: `Bearer ${token}` } });
    const etagBefore = before.headers.get("ETag");

    const updated = JSON.stringify({ type: "excalidraw", version: 2, source: "test", elements: [{ id: "a", type: "rectangle" }], appState: {}, files: {} });
    const putRes = await fetch(`${API_URL}/files/${drawingId}/content`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: updated,
    });
    expect(putRes.status).toBe(200);
    const putBody = await putRes.json<{ ok: boolean; data: { size: number; updated_at: string } }>();
    expect(putBody.ok).toBe(true);
    expect(putBody.data.size).toBe(new TextEncoder().encode(updated).length);
    expect(typeof putBody.data.updated_at).toBe("string");

    const after = await fetch(`${API_URL}/files/${drawingId}/content`, { headers: { Authorization: `Bearer ${token}` } });
    expect(after.headers.get("ETag")).not.toBe(etagBefore);
    expect(await after.text()).toContain("rectangle");
  });

  it("rejects overwriting a non-drawing file with 400", async () => {
    const res = await fetch(`${API_URL}/files/${textId}/content`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: "should not be allowed",
    });
    expect(res.status).toBe(400);
  });

  it("rejects an unauthenticated content overwrite with 401", async () => {
    const res = await fetch(`${API_URL}/files/${drawingId}/content`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: emptyScene,
    });
    expect(res.status).toBe(401);
  });

  afterAll(async () => {
    if (projectId && token) {
      await fetch(`${API_URL}/projects/${projectId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
    }
  });
});

// ── Public doc access - published-site semantics ─────────────────────────────
// A published *site* intentionally exposes ALL of its docs regardless of the
// per-doc published_at flag (which exists for other reasons). A doc is only
// hidden from /public when neither the site nor the doc is published. This
// suite locks in that intended behavior so it is not mistaken for an IDOR.

describe.skipIf(!serversUp)("API - public doc access (published-site semantics)", () => {
  let token = "";
  let projectId = "";
  let docId = "";

  // Distinct CF-Connecting-IP so this suite gets its own auth rate-limit
  // bucket - the other suites already burn most of the shared FAKE_IP budget.
  const suiteHeaders = (extra: Record<string, string> = {}): Record<string, string> => ({
    "Content-Type": "application/json",
    "CF-Connecting-IP": `172.16.${Math.floor(RUN_ID / 1e7) % 256}.${RUN_ID % 256}`,
    ...extra,
  });

  beforeAll(async () => {
    const flowEmail = `public-site-${RUN_ID}@example.com`;
    await fetch(`${API_URL}/register`, {
      method: "POST",
      headers: suiteHeaders(),
      body: JSON.stringify({ email: flowEmail, password: PASSWORD, name: NAME, turnstileToken: TURNSTILE_TOKEN }),
    });
    const loginRes = await fetch(`${API_URL}/login`, {
      method: "POST",
      headers: suiteHeaders(),
      body: JSON.stringify({ email: flowEmail, password: PASSWORD, turnstileToken: TURNSTILE_TOKEN }),
    });
    token = (await loginRes.json<{ data: { token: string } }>()).data?.token ?? "";
    expect(token, "login did not return a token (rate-limited?)").not.toBe("");

    const projRes = await fetch(`${API_URL}/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: "Public Site Semantics Project" }),
    });
    expect(projRes.status).toBe(201);
    projectId = (await projRes.json<{ data: { id: string } }>()).data.id;

    const docRes = await fetch(`${API_URL}/docs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ title: "Secret Draft", content: "# Secret Draft\n\nUnpublished.", projectId }),
    });
    expect(docRes.status).toBe(201);
    docId = (await docRes.json<{ data: { id: string } }>()).data.id;
  });

  it("hides a doc when neither the site nor the doc is published", async () => {
    const res = await fetch(`${API_URL}/public/docs/${projectId}/${docId}`);
    expect(res.status).toBe(404);
  });

  it("exposes an unpublished doc once the site is published (by design)", async () => {
    const pubSite = await fetch(`${API_URL}/projects/${projectId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ publishedAt: new Date().toISOString() }),
    });
    expect(pubSite.status).toBe(200);

    const res = await fetch(`${API_URL}/public/docs/${projectId}/${docId}`);
    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean; data: { doc: { title: string } } }>();
    expect(body.ok).toBe(true);
    expect(body.data.doc.title).toBe("Secret Draft");
  });

  afterAll(async () => {
    if (projectId && token) {
      await fetch(`${API_URL}/projects/${projectId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
    }
  });
});
