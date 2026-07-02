// Unit tests for the demo-mode in-memory API, focused on revision-history
// parity with the real API: keyset pagination (limit/before/beforeId,
// created_at DESC id DESC), `title` on revision rows, the POST .../restore
// route, and the "content only echoed when it changed" PUT/restore shape.
//
// The demo server patches window.fetch, so these tests drive it exactly the
// way the app does. The store is module-global; each test that mutates state
// works on a doc it created itself (the seeded welcome doc is only restored).

import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { enterDemoMode } from "./demo";
import { installDemoServer } from "./demoServer";

interface ApiResult {
  status: number;
  ok: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
  error?: string;
}

async function api(path: string, init?: RequestInit): Promise<ApiResult> {
  const res = await window.fetch(`/api${path}`, init);
  const body = await res.json() as { ok: boolean; data?: unknown; error?: string };
  return { status: res.status, ok: body.ok, data: body.data, error: body.error };
}

function put(path: string, body: unknown): Promise<ApiResult> {
  return api(path, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

function post(path: string, body?: unknown): Promise<ApiResult> {
  return api(path, {
    method: "POST",
    ...(body !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
}

async function createDoc(title: string): Promise<string> {
  const res = await post("/docs", { title, content: "" });
  expect(res.ok).toBe(true);
  return res.data.id as string;
}

beforeAll(() => {
  enterDemoMode();
  installDemoServer();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("demo server revisions", () => {
  it("lists revisions newest-first with the title captured at each revision", async () => {
    const res = await api("/docs/demo-doc-welcome/revisions");
    expect(res.ok).toBe(true);
    expect(res.data).toHaveLength(2);
    expect(res.data[0].id).toBe("demo-rev-2");
    expect(res.data[0].title).toBe("Welcome to the Annex demo");
    expect(res.data[1].id).toBe("demo-rev-1");
    expect(res.data[1].title).toBe("Welcome");
  });

  it("paginates with limit/before/beforeId, returning strictly older rows", async () => {
    const docId = await createDoc("Paginated doc");
    vi.useFakeTimers();
    for (let i = 1; i <= 5; i++) {
      vi.setSystemTime(new Date(Date.UTC(2026, 0, 1, 0, i)));
      const res = await put(`/docs/${docId}`, { content: `v${i}`, changelog: `save ${i}` });
      expect(res.ok).toBe(true);
    }
    vi.useRealTimers();

    const page1 = await api(`/docs/${docId}/revisions?limit=2`);
    expect(page1.data.map((r: { changelog: string }) => r.changelog)).toEqual(["save 5", "save 4"]);

    const cursor1 = page1.data[page1.data.length - 1];
    const page2 = await api(`/docs/${docId}/revisions?limit=2&before=${encodeURIComponent(cursor1.created_at)}&beforeId=${cursor1.id}`);
    expect(page2.data.map((r: { changelog: string }) => r.changelog)).toEqual(["save 3", "save 2"]);

    const cursor2 = page2.data[page2.data.length - 1];
    const page3 = await api(`/docs/${docId}/revisions?limit=2&before=${encodeURIComponent(cursor2.created_at)}&beforeId=${cursor2.id}`);
    // Short page - the caller knows there is nothing older.
    expect(page3.data.map((r: { changelog: string }) => r.changelog)).toEqual(["save 1"]);
  });

  it("applies the default limit of 50 and caps at 200", async () => {
    const docId = await createDoc("Limits doc");
    vi.useFakeTimers();
    for (let i = 1; i <= 55; i++) {
      vi.setSystemTime(new Date(Date.UTC(2026, 1, 1, 0, i)));
      await put(`/docs/${docId}`, { content: `rev ${i}` });
    }
    vi.useRealTimers();

    const defaulted = await api(`/docs/${docId}/revisions`);
    expect(defaulted.data).toHaveLength(50);
    const capped = await api(`/docs/${docId}/revisions?limit=9999`);
    expect(capped.data).toHaveLength(55);
    const explicit = await api(`/docs/${docId}/revisions?limit=51`);
    expect(explicit.data).toHaveLength(51);
  });

  it("restores content and title server-side with an auto-changelog", async () => {
    const restored = await post("/docs/demo-doc-welcome/revisions/demo-rev-1/restore");
    expect(restored.ok).toBe(true);
    expect(restored.data.title).toBe("Welcome");
    expect(restored.data.content).toBe("# Welcome\n\nThis page is being written…");

    const doc = await api("/docs/demo-doc-welcome");
    expect(doc.data.title).toBe("Welcome");

    const list = await api("/docs/demo-doc-welcome/revisions");
    expect(list.data).toHaveLength(3);
    expect(list.data[0].changelog).toMatch(/^Restored version from \d{4}-/);
    expect(list.data[0].title).toBe("Welcome");
  });

  it("uses a caller-provided changelog and omits content on a no-op restore", async () => {
    const docId = await createDoc("Restore doc");
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 2, 1, 0, 1)));
    await put(`/docs/${docId}`, { content: "v1" });
    vi.setSystemTime(new Date(Date.UTC(2026, 2, 1, 0, 2)));
    await put(`/docs/${docId}`, { content: "v2" });
    vi.useRealTimers();

    const list = await api(`/docs/${docId}/revisions`);
    const v1 = list.data[1];

    const restored = await post(`/docs/${docId}/revisions/${v1.id}/restore`, { changelog: "back to v1" });
    expect(restored.data.content).toBe("v1");
    const after = await api(`/docs/${docId}/revisions`);
    expect(after.data).toHaveLength(3);
    expect(after.data[0].changelog).toBe("back to v1");

    // Restoring a revision whose content already matches is a no-op: no new
    // revision, and the response omits `content` (same shape as the doc PUT).
    const noop = await post(`/docs/${docId}/revisions/${v1.id}/restore`);
    expect(noop.ok).toBe(true);
    expect("content" in noop.data).toBe(false);
    expect((await api(`/docs/${docId}/revisions`)).data).toHaveLength(3);
  });

  it("records a revision for a title-only restore (content unchanged, title differs)", async () => {
    const docId = await createDoc("Title doc");
    await put(`/docs/${docId}`, { content: "body" });
    const [rev] = (await api(`/docs/${docId}/revisions`)).data;
    expect(rev.title).toBe("Title doc");

    // Title-only rename - no revision is written for it, matching the API.
    await put(`/docs/${docId}`, { title: "Renamed" });
    const before = (await api(`/docs/${docId}/revisions`)).data.length;

    // Restoring flips the title back; content already matches, but the doc
    // mutated, so a revision (carrying the changelog) must be recorded.
    const restored = await post(`/docs/${docId}/revisions/${rev.id}/restore`);
    expect(restored.ok).toBe(true);
    expect(restored.data.title).toBe("Title doc");
    expect("content" in restored.data).toBe(false);
    const after = (await api(`/docs/${docId}/revisions`)).data;
    expect(after).toHaveLength(before + 1);
    expect(after[0].title).toBe("Title doc");
    expect(after[0].changelog).toMatch(/^Restored version from /);
  });

  it("404s when restoring an unknown revision", async () => {
    const res = await post("/docs/demo-doc-welcome/revisions/nope/restore");
    expect(res.status).toBe(404);
  });

  it("omits content and records no revision on a no-op PUT", async () => {
    const docId = await createDoc("Noop doc");
    await put(`/docs/${docId}`, { content: "same" });
    const before = (await api(`/docs/${docId}/revisions`)).data.length;

    const noop = await put(`/docs/${docId}`, { title: "Noop doc", content: "same", changelog: "ignored" });
    expect(noop.ok).toBe(true);
    expect("content" in noop.data).toBe(false);
    expect((await api(`/docs/${docId}/revisions`)).data).toHaveLength(before);
  });
});
