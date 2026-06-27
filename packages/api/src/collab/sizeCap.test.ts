/**
 * Integration tests for the realtime collab size caps + reset endpoint.
 *
 * Prerequisites:
 *   1. Start both workers from the repo root:  pnpm dev
 *   2. wrangler CLI must be available from packages/api (already a dev dep) - the test
 *      uses it to flip the REALTIME flag on the test project, since there's no API
 *      route for that today (see CLAUDE.md, "Enabling for a project locally").
 *
 * Tests skip automatically when the dev API isn't reachable.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import * as Y from "yjs";
import * as encoding from "lib0/encoding";

const AUTH_URL = "http://localhost:8788";
const API_URL  = "http://localhost:8787";
const WS_URL   = "ws://localhost:8787";
const TURNSTILE_TOKEN = "test-bypass-token";

const RUN_ID = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const FAKE_IP = `10.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}`;

let serversUp = false;
try {
  const res = await fetch(`${API_URL}/projects`, { signal: AbortSignal.timeout(1500) });
  serversUp = res.status < 500;
  // Probe auth too - collab tests need register/login to work.
  const authRes = await fetch(`${AUTH_URL}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(1500),
  });
  serversUp = serversUp && authRes.status < 500;
} catch { /* not running */ }

const MSG_SYNC = 0;
const SYNC_STEP_2 = 2;

function encodeSyncStep2(update: Uint8Array): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MSG_SYNC);
  encoding.writeVarUint(enc, SYNC_STEP_2);
  encoding.writeVarUint8Array(enc, update);
  return encoding.toUint8Array(enc);
}

// Flip the REALTIME bit (= 4) on a project's `features` column. There's no API route for
// this - production toggling happens via an admin script - so the test shells out to wrangler.
function enableRealtime(projectId: string): void {
  execSync(
    `npx wrangler d1 execute cubedocs-main --local --persist-to ../../.wrangler/state --command "UPDATE projects SET features = features | 4 WHERE id = '${projectId}';"`,
    { stdio: "pipe" },
  );
}

interface CloseInfo { code: number; reason: string }

function waitForClose(ws: WebSocket, timeoutMs: number): Promise<CloseInfo> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`WS did not close within ${timeoutMs}ms`)), timeoutMs);
    ws.addEventListener("close", (ev) => {
      clearTimeout(timer);
      const e = ev as CloseEvent;
      resolve({ code: e.code, reason: e.reason });
    });
  });
}

function waitForOpen(ws: WebSocket, timeoutMs = 5_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WS did not open within timeout")), timeoutMs);
    ws.addEventListener("open", () => { clearTimeout(timer); resolve(); });
    ws.addEventListener("close", (ev) => {
      // Closed before opening - auth/upgrade rejected. Surface the close so tests fail fast
      // rather than timing out.
      clearTimeout(timer);
      const e = ev as CloseEvent;
      reject(new Error(`WS closed before open: code=${e.code} reason=${e.reason}`));
    });
  });
}

// `@cloudflare/workers-types` overrides the global WebSocket with the worker-side variant
// (no URL constructor). In Node 22+ the runtime exposes the browser-style constructor; cast
// to it for the test.
const WSCtor = WebSocket as unknown as new (url: string) => WebSocket;

describe.skipIf(!serversUp)("collab - size caps + reset", () => {
  let token = "";
  let projectId = "";
  let docId = "";

  beforeAll(async () => {
    const email = `collab-cap-${RUN_ID}@example.com`;
    const password = "Collab-Cap-P@ssw0rd!";
    const name = "Collab Cap Test User";

    await fetch(`${API_URL}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": FAKE_IP },
      body: JSON.stringify({ email, password, name, turnstileToken: TURNSTILE_TOKEN }),
    });
    const loginRes = await fetch(`${API_URL}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": FAKE_IP },
      body: JSON.stringify({ email, password, turnstileToken: TURNSTILE_TOKEN }),
    });
    const loginBody = await loginRes.json<{ ok: boolean; data?: { token: string } }>();
    token = loginBody.data?.token ?? "";
    if (!token) throw new Error("setup: login failed");

    const projectRes = await fetch(`${API_URL}/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: "Collab Cap Test Project" }),
    });
    const projectBody = await projectRes.json<{ ok: boolean; data: { id: string } }>();
    projectId = projectBody.data.id;
    enableRealtime(projectId);

    const docRes = await fetch(`${API_URL}/docs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ title: "Cap Test", content: "# Cap Test\n", projectId }),
    });
    const docBody = await docRes.json<{ ok: boolean; data: { id: string } }>();
    docId = docBody.data.id;
  });

  afterAll(async () => {
    if (docId) {
      await fetch(`${API_URL}/docs/${docId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => { /* */ });
    }
    if (projectId) {
      await fetch(`${API_URL}/projects/${projectId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => { /* */ });
    }
  });

  it("closes with 1009 when a single frame exceeds the per-message cap", async () => {
    const ws = new WSCtor(`${WS_URL}/docs/${docId}/collab?token=${encodeURIComponent(token)}`);
    ws.binaryType = "arraybuffer";
    await waitForOpen(ws);

    // Wait briefly so the server's initial step1 is sent (and ignored by us).
    await new Promise(r => setTimeout(r, 100));

    // 600 KB > 512 KB MAX_MESSAGE_BYTES. Contents are arbitrary - server rejects on size,
    // before parsing.
    const big = new Uint8Array(600 * 1024);
    ws.send(big);

    const close = await waitForClose(ws, 5_000);
    expect(close.code).toBe(1009);
  });

  // Streams ~2 MB of state in via small updates; each Y.encodeStateAsUpdate check on the
  // server is O(state size), so the cumulative work is meaningful - bump the per-test timeout
  // well past vitest's 5s default.
  it("closes with 1008 + freezes the room when total Y.Doc state exceeds the cap", { timeout: 60_000 }, async () => {
    // Reset first so this test is independent of any leftover state.
    await fetch(`${API_URL}/docs/${docId}/collab/reset`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });

    const ws = new WSCtor(`${WS_URL}/docs/${docId}/collab?token=${encodeURIComponent(token)}`);
    ws.binaryType = "arraybuffer";
    await waitForOpen(ws);
    await new Promise(r => setTimeout(r, 100));

    // Build a local Y.Doc and capture each update so we can stream them as individual
    // step2 messages, each well under the 512 KB per-message cap.
    const ydoc = new Y.Doc();
    const yText = ydoc.getText("content");
    const updates: Uint8Array[] = [];
    ydoc.on("update", (u: Uint8Array) => { updates.push(u); });

    // 30 × 100 KB inserts = 3 MB of content, comfortably past the 2 MB state cap. Each
    // insert produces one update of ~100 KB, well under 512 KB.
    for (let i = 0; i < 30; i++) {
      yText.insert(yText.length, "x".repeat(100_000));
    }

    const closePromise = waitForClose(ws, 30_000);

    for (const update of updates) {
      if (ws.readyState !== ws.OPEN) break;
      try {
        ws.send(encodeSyncStep2(update));
      } catch {
        break;
      }
      // Small pause so the server has a chance to process and freeze before we keep flooding.
      await new Promise(r => setTimeout(r, 25));
    }

    const close = await closePromise;
    expect(close.code).toBe(1008);

    // Reconnect should SUCCEED - `persist()` is a no-op while frozen, and `teardown()`
    // clears the flag once the last socket disconnects, so the next load reads the pre-bloat
    // snapshot from DO storage. This is the room's automatic recovery path.
    const ws2 = new WSCtor(`${WS_URL}/docs/${docId}/collab?token=${encodeURIComponent(token)}`);
    ws2.binaryType = "arraybuffer";
    await waitForOpen(ws2);
    const closedEarly = new Promise<"closed">((resolve) => {
      ws2.addEventListener("close", () => resolve("closed"));
    });
    const stable = new Promise<"stable">((resolve) => setTimeout(() => resolve("stable"), 500));
    const result = await Promise.race([closedEarly, stable]);
    expect(result).toBe("stable");
    ws2.close();
  });

  it("reset endpoint clears the frozen state", async () => {
    const resetRes = await fetch(`${API_URL}/docs/${docId}/collab/reset`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(resetRes.status).toBe(200);

    // Reconnect - should NOT close immediately. Stay-open verified by racing the close
    // event against a 500 ms timer; if the timer wins, the room is healthy.
    const ws = new WSCtor(`${WS_URL}/docs/${docId}/collab?token=${encodeURIComponent(token)}`);
    ws.binaryType = "arraybuffer";
    await waitForOpen(ws);

    const closeEarly = new Promise<"closed">((resolve) => {
      ws.addEventListener("close", () => resolve("closed"));
    });
    const stable = new Promise<"stable">((resolve) => setTimeout(() => resolve("stable"), 500));

    const result = await Promise.race([closeEarly, stable]);
    expect(result).toBe("stable");
    ws.close();
  });

  it("reset endpoint requires authentication", async () => {
    const res = await fetch(`${API_URL}/docs/${docId}/collab/reset`, {
      method: "POST",
    });
    expect(res.status).toBe(401);
  });

  it("reset endpoint returns 404 for unknown docs", async () => {
    const res = await fetch(`${API_URL}/docs/does-not-exist/collab/reset`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
  });
});
