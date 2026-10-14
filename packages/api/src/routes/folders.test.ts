import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleFolders } from "./folders";

vi.mock("../lib/access", () => ({ resolveRole: vi.fn() }));
vi.mock("../lib/trash", () => ({ moveToTrash: vi.fn() }));
vi.mock("../lib", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib")>()),
  folderInProject: vi.fn(),
  wouldCreateFolderCycle: vi.fn(),
}));

import { resolveRole } from "../lib/access";
import { moveToTrash } from "../lib/trash";
import { folderInProject, wouldCreateFolderCycle } from "../lib";

const user = { userId: "user-1", email: "a@example.com" } as unknown as Parameters<typeof handleFolders>[2];

function makeEnv() {
  const firsts: unknown[] = [];
  const alls: unknown[] = [];
  const runs: unknown[] = [];
  const first = vi.fn(() => Promise.resolve(firsts.shift() ?? null));
  const all = vi.fn(() => Promise.resolve(alls.shift() ?? { results: [] }));
  const run = vi.fn(() => Promise.resolve(runs.shift() ?? { meta: { changes: 1 } }));
  const bind = vi.fn(() => ({ first, all, run }));
  const prepare = vi.fn(() => ({ bind }));
  return {
    env: { DB: { prepare } } as unknown as Parameters<typeof handleFolders>[1],
    run,
    queueFirst: (v: unknown) => firsts.push(v),
    queueAll: (v: unknown) => alls.push(v),
  };
}

function call(env: Parameters<typeof handleFolders>[1], method: string, path: string, body?: unknown) {
  const url = new URL(`http://localhost${path}`);
  return handleFolders(
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
  vi.mocked(resolveRole).mockResolvedValue("editor");
  vi.mocked(folderInProject).mockResolvedValue(true);
  vi.mocked(wouldCreateFolderCycle).mockResolvedValue(false);
});

describe("handleFolders GET list", () => {
  it("400s without projectId", async () => {
    const { env } = makeEnv();
    const res = await call(env, "GET", "/folders");
    expect(res.status).toBe(400);
  });

  it("403s for a non-member", async () => {
    vi.mocked(resolveRole).mockResolvedValue(null);
    const { env } = makeEnv();
    const res = await call(env, "GET", "/folders?projectId=p1");
    expect(res.status).toBe(403);
  });

  it("returns the folder rows for a member", async () => {
    const { env, queueAll } = makeEnv();
    queueAll({ results: [{ id: "f1", name: "Folder" }] });
    const res = await call(env, "GET", "/folders?projectId=p1");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: unknown[] };
    expect(json.data).toHaveLength(1);
  });
});

describe("handleFolders POST", () => {
  it("400s without name/projectId", async () => {
    const { env } = makeEnv();
    const res = await call(env, "POST", "/folders", { name: "X" });
    expect(res.status).toBe(400);
  });

  it("403s for a viewer (below editor)", async () => {
    vi.mocked(resolveRole).mockResolvedValue("viewer");
    const { env } = makeEnv();
    const res = await call(env, "POST", "/folders", { name: "X", projectId: "p1" });
    expect(res.status).toBe(403);
  });

  it("400s when the parent folder isn't in the project", async () => {
    vi.mocked(folderInProject).mockResolvedValue(false);
    const { env } = makeEnv();
    const res = await call(env, "POST", "/folders", { name: "X", projectId: "p1", parentId: "bad" });
    expect(res.status).toBe(400);
  });

  it("creates a folder (201) for an editor", async () => {
    const { env, run } = makeEnv();
    const res = await call(env, "POST", "/folders", { name: "X", projectId: "p1" });
    expect(res.status).toBe(201);
    expect(run).toHaveBeenCalled();
    const json = (await res.json()) as { data: { name: string; project_id: string } };
    expect(json.data.name).toBe("X");
  });
});

describe("handleFolders PUT", () => {
  it("404s when the folder is missing", async () => {
    const { env } = makeEnv(); // first() → null
    const res = await call(env, "PUT", "/folders/f1", { name: "New" });
    expect(res.status).toBe(404);
  });

  it("403s for a viewer", async () => {
    vi.mocked(resolveRole).mockResolvedValue("viewer");
    const { env, queueFirst } = makeEnv();
    queueFirst({ id: "f1", name: "Old", type: "docs", project_id: "p1", parent_id: null });
    const res = await call(env, "PUT", "/folders/f1", { name: "New" });
    expect(res.status).toBe(403);
  });

  it("rejects a reparent that would create a cycle", async () => {
    vi.mocked(wouldCreateFolderCycle).mockResolvedValue(true);
    const { env, queueFirst } = makeEnv();
    queueFirst({ id: "f1", name: "Old", type: "docs", project_id: "p1", parent_id: null });
    const res = await call(env, "PUT", "/folders/f1", { parentId: "f2" });
    expect(res.status).toBe(400);
  });

  it("renames the folder for an editor", async () => {
    const { env, queueFirst, run } = makeEnv();
    queueFirst({ id: "f1", name: "Old", type: "docs", project_id: "p1", parent_id: null });
    const res = await call(env, "PUT", "/folders/f1", { name: "New" });
    expect(res.status).toBe(200);
    expect(run).toHaveBeenCalled();
    const json = (await res.json()) as { data: { name: string } };
    expect(json.data.name).toBe("New");
  });
});

describe("handleFolders DELETE", () => {
  it("404s when the folder is missing", async () => {
    const { env } = makeEnv();
    const res = await call(env, "DELETE", "/folders/f1");
    expect(res.status).toBe(404);
  });

  it("moves the folder subtree to the recycle bin for an editor", async () => {
    vi.mocked(moveToTrash).mockResolvedValue({ entryId: "t1", homeDocMoved: true });
    const { env, queueFirst, run } = makeEnv();
    queueFirst({ project_id: "p1" });
    const res = await call(env, "DELETE", "/folders/f1");
    expect(res.status).toBe(200);
    expect(moveToTrash).toHaveBeenCalledWith(env, expect.objectContaining({ projectId: "p1", type: "folder", id: "f1" }));
    // No direct DELETE any more - that SET-NULL-dumped the contents at the root.
    expect(run).not.toHaveBeenCalled();
    expect(((await res.json()) as { data: { homeDocMoved: boolean } }).data.homeDocMoved).toBe(true);
  });

  it("403s for a viewer", async () => {
    vi.mocked(resolveRole).mockResolvedValue("viewer");
    const { env, queueFirst } = makeEnv();
    queueFirst({ project_id: "p1" });
    const res = await call(env, "DELETE", "/folders/f1");
    expect(res.status).toBe(403);
    expect(moveToTrash).not.toHaveBeenCalled();
  });
});
