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

function patch(path: string, body: unknown): Promise<ApiResult> {
  return api(path, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

function del(path: string): Promise<ApiResult> {
  return api(path, { method: "DELETE" });
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

describe("demo server search", () => {
  it("returns doc hits with excerpt, folder and updated_at under data.docs", async () => {
    const res = await api("/search?projectId=demo-project&q=coffee");
    expect(res.ok).toBe(true);
    const hit = res.data.docs.find((d: { title: string }) => d.title === "Coffee brewing guide");
    expect(hit).toBeTruthy();
    expect(hit.excerpt).toContain("<mark>");
    expect(hit).toHaveProperty("folder");
    expect(hit.updated_at).toBeTruthy();
  });

  it("returns filename hits with mime and folder under data.files", async () => {
    const res = await api("/search?projectId=demo-project&q=kickoff");
    expect(res.ok).toBe(true);
    const hit = res.data.files.find((f: { name: string }) => f.name === "kickoff-notes.txt");
    expect(hit).toBeTruthy();
    expect(hit.mime_type).toBe("text/plain");
    expect(hit.updated_at).toBeTruthy();
  });

  it("returns tag matches with no file or folder hits", async () => {
    const res = await api("/search?projectId=demo-project&tag=coff");
    expect(res.ok).toBe(true);
    expect(res.data.docs.map((d: { title: string }) => d.title)).toContain("Coffee brewing guide");
    expect(res.data.docs[0].tags).toBeTruthy();
    expect(res.data.files).toEqual([]);
    expect(res.data.folders).toEqual([]);
  });

  it("returns folder-name hits under data.folders", async () => {
    const res = await api("/search?projectId=demo-project&q=guides");
    expect(res.ok).toBe(true);
    const hit = res.data.folders.find((f: { name: string }) => f.name === "Guides");
    expect(hit).toBeTruthy();
    expect(hit.parent).toBeNull();
  });
});

describe("demo server project settings (PATCH)", () => {
  it("saves name, description and publish state and echoes the full project shape", async () => {
    const res = await patch("/projects/demo-site", { name: "Renamed Site", description: "New blurb", publishedAt: "2026-07-01T00:00:00.000Z" });
    expect(res.ok).toBe(true);
    expect(res.data.name).toBe("Renamed Site");
    expect(res.data.description).toBe("New blurb");
    expect(res.data.published_at).toBe("2026-07-01T00:00:00.000Z");
    expect(res.data.role).toBe("owner");

    const unpublished = await patch("/projects/demo-site", { publishedAt: null });
    expect(unpublished.data.published_at).toBeNull();
  });

  it("persists changelog mode, AI and graph toggles; disabling graph clears the published-graph flag", async () => {
    const on = await patch("/projects/demo-site", { changelogMode: "on", aiEnabled: true, graphEnabled: true, publishedGraphEnabled: true });
    expect(on.data.changelog_mode).toBe("on");
    expect(on.data.ai_enabled).toBe(1);
    expect(on.data.graph_enabled).toBe(1);
    expect(on.data.published_graph_enabled).toBe(1);

    const off = await patch("/projects/demo-site", { changelogMode: "off", aiEnabled: false, graphEnabled: false });
    expect(off.data.graph_enabled).toBe(0);
    expect(off.data.published_graph_enabled).toBe(0);
  });

  it("creates a Home doc once when enabled and only unsets the pointer when disabled", async () => {
    const enabled = await patch("/projects/demo-site", { homeDocEnabled: true });
    const homeId = enabled.data.home_doc_id as string;
    expect(homeId).toBeTruthy();
    expect((await api(`/docs/${homeId}`)).data.title).toBe("Home");

    // Re-enabling must not create a second doc.
    const again = await patch("/projects/demo-site", { homeDocEnabled: true });
    expect(again.data.home_doc_id).toBe(homeId);

    const disabled = await patch("/projects/demo-site", { homeDocEnabled: false });
    expect(disabled.data.home_doc_id).toBeNull();
    expect((await api(`/docs/${homeId}`)).ok).toBe(true); // doc survives
    await del(`/docs/${homeId}`);
  });

  it("refuses site deletion, member invites and export with readable messages", async () => {
    expect((await del("/projects/demo-site")).error).toBe("Site deletion is disabled in the demo.");
    expect((await post("/projects/demo-site/members", { email: "x@y.z", role: "editor" })).error).toBe("Inviting members is disabled in the demo.");
    expect((await api("/projects/demo-site/export")).error).toBe("Site export is disabled in the demo.");
    expect((await patch("/projects/demo-site", { vanitySlug: "demo" })).error).toBe("Custom links aren't available in the demo.");
  });

  it("answers unknown routes with a human-readable error", async () => {
    const res = await api("/definitely-not-a-route");
    expect(res.status).toBe(404);
    expect(res.error).toBe("Not available in the demo.");
  });
});

describe("demo server published site", () => {
  it("404s the public project, search and site-published-only docs while unpublished", async () => {
    await patch("/projects/demo-site", { publishedAt: null });
    expect((await api("/public/projects/demo-site")).status).toBe(404);
    expect((await api("/public/search?projectId=demo-site&q=coffee")).status).toBe(404);
    const docId = await createDoc("Site-only doc");
    expect((await api(`/public/docs/demo-site/${docId}`)).status).toBe(404);
    await del(`/docs/${docId}`);
  });

  it("serves a per-doc-published doc while the site is unpublished, without nav lists", async () => {
    await patch("/projects/demo-site", { publishedAt: null });
    const docId = await createDoc("Solo published doc");
    await put(`/docs/${docId}`, { publishedAt: "2026-07-01T00:00:00.000Z" });

    const res = await api(`/public/docs/demo-site/${docId}`);
    expect(res.ok).toBe(true);
    expect(res.data.doc.title).toBe("Solo published doc");
    expect(res.data.sitePublished).toBe(false);
    expect(res.data.docs).toBeNull();
    await del(`/docs/${docId}`);
  });

  it("serves the public project with docs/folders/files once the site is published", async () => {
    await patch("/projects/demo-site", { publishedAt: "2026-07-01T00:00:00.000Z" });
    const res = await api("/public/projects/demo-site");
    expect(res.ok).toBe(true);
    expect(res.data.docs.length).toBeGreaterThan(0);
    expect(res.data.folders.map((f: { name: string }) => f.name)).toContain("Guides");
    expect(res.data.files.map((f: { name: string }) => f.name)).toContain("roadmap.excalidraw");

    const search = await api("/public/search?projectId=demo-site&q=coffee");
    expect(search.ok).toBe(true);
    expect(search.data.docs.length).toBeGreaterThan(0);

    const doc = await api("/public/docs/demo-site/demo-doc-coffee");
    expect(doc.ok).toBe(true);
    expect(doc.data.sitePublished).toBe(true);
    expect(doc.data.docs).not.toBeNull();
    // Frontmatter-derived fields mirror the real public route.
    expect(doc.data.doc.content).toContain("Coffee brewing guide");
    await patch("/projects/demo-site", { publishedAt: null });
  });

  it("serves public file content only while the site is published", async () => {
    await patch("/projects/demo-site", { publishedAt: "2026-07-01T00:00:00.000Z" });
    const res = await window.fetch("/api/public/files/demo-file-image/content?projectId=demo-site");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/svg+xml");
    expect((await api("/public/files/demo-file-image?projectId=demo-site")).data.name).toBe("demo-illustration.svg");
    expect((await api("/public/files/demo-file-image/stream-url?projectId=demo-site")).data.url).toBeNull();

    await patch("/projects/demo-site", { publishedAt: null });
    const gone = await window.fetch("/api/public/files/demo-file-image/content?projectId=demo-site");
    expect(gone.status).toBe(404);
  });

  it("refuses the Report User POST with a human-readable demo error", async () => {
    const res = await window.fetch("/api/users/someone-else/report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note: "demo report" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Reporting is disabled in the demo.");
  });

  it("refuses the Report Site POST with a human-readable demo error", async () => {
    await patch("/projects/demo-site", { publishedAt: "2026-07-01T00:00:00.000Z" });
    const res = await window.fetch("/api/public/projects/demo-site/report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note: "demo report" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Reporting is disabled in the demo.");
    await patch("/projects/demo-site", { publishedAt: null });
  });

  it("gates the public graph on publishedGraphEnabled", async () => {
    await patch("/projects/demo-site", { publishedAt: "2026-07-01T00:00:00.000Z", graphEnabled: true, publishedGraphEnabled: false });
    expect((await api("/public/projects/demo-site/graph")).status).toBe(404);
    await patch("/projects/demo-site", { publishedGraphEnabled: true });
    const res = await api("/public/projects/demo-site/graph");
    expect(res.ok).toBe(true);
    expect(res.data.nodes.length).toBeGreaterThan(0);
    await patch("/projects/demo-site", { publishedAt: null, graphEnabled: false });
  });
});

describe("demo server graph", () => {
  it("derives edges from wikilinks between docs", async () => {
    const aId = await createDoc("Graph source doc");
    const bId = await createDoc("Graph target doc");
    await put(`/docs/${aId}`, { content: "Links to [[Graph target doc]] and [[Graph target doc|again]]." });

    const res = await api("/projects/demo-site/graph");
    expect(res.ok).toBe(true);
    const nodeIds = res.data.nodes.map((n: { id: string }) => n.id);
    expect(nodeIds).toContain(aId);
    expect(nodeIds).toContain(bId);
    // Duplicate links collapse to one edge.
    expect(res.data.edges.filter((e: { source: string; target: string }) => e.source === aId && e.target === bId)).toHaveLength(1);
    const target = res.data.nodes.find((n: { id: string }) => n.id === bId);
    expect(target.links).toBe(1);
    await del(`/docs/${aId}`);
    await del(`/docs/${bId}`);
  });
});

describe("demo server user prefs", () => {
  it("persists name, timezone, bio and fonts through /me and reflects them in reads", async () => {
    const renamed = await patch("/me", { name: "Demo Renamed" });
    expect(renamed.data.name).toBe("Demo Renamed");
    await patch("/me", { timezone: "Europe/London" });
    await patch("/me/bio", { bio: "Hello from the demo" });
    await patch("/me/reading-font", { readingFont: "serif", uiFont: null });

    const me = await api("/me");
    expect(me.data.name).toBe("Demo Renamed");
    expect(me.data.timezone).toBe("Europe/London");
    expect(me.data.bio).toBe("Hello from the demo");
    expect(me.data.readingFont).toBe("serif");
    expect(me.data.emailVerified).toBe(true);

    // The one demo member row follows the rename.
    const members = await api("/projects/demo-site/members");
    expect(members.data[0].name).toBe("Demo Renamed");
    await patch("/me", { name: "Demo User", timezone: null });
    await patch("/me/bio", { bio: null });
    await patch("/me/reading-font", { readingFont: null });
  });

  it("refuses avatar changes and account deletion with readable messages", async () => {
    expect((await post("/avatar?variant=default")).error).toBe("Avatar changes are disabled in the demo.");
    expect((await del("/avatar?variant=default")).error).toBe("Avatar changes are disabled in the demo.");
    expect((await del("/me")).error).toBe("Account deletion is disabled in the demo.");
  });
});

describe("demo server files and docs hygiene", () => {
  it("bumps updated_at when a drawing's content is overwritten", async () => {
    const before = (await api("/files/demo-file-drawing")).data.updated_at as string;
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2027, 0, 1)));
    const saved = await api("/files/demo-file-drawing/content", { method: "PUT", body: JSON.stringify({ type: "excalidraw", version: 2, elements: [], appState: {}, files: {} }) });
    vi.useRealTimers();
    expect(saved.ok).toBe(true);
    expect(saved.data.updated_at).not.toBe(before);
    expect((await api("/files/demo-file-drawing")).data.updated_at).toBe(saved.data.updated_at);
  });

  it("drops a doc's revisions when the doc is deleted", async () => {
    const docId = await createDoc("Ephemeral doc");
    await put(`/docs/${docId}`, { content: "v1" });
    expect((await api(`/docs/${docId}/revisions`)).data).toHaveLength(1);
    await del(`/docs/${docId}`);
    expect((await api(`/docs/${docId}/revisions`)).status).toBe(404);
  });
});
