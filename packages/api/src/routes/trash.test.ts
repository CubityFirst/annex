import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleTrash } from "./trash";

vi.mock("../lib/access", () => ({ resolveRole: vi.fn() }));
vi.mock("../lib/trash", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/trash")>()),
  listTrash: vi.fn(),
  restoreFromTrash: vi.fn(),
  purgeTrashEntry: vi.fn(),
  emptyTrash: vi.fn(),
}));

import { resolveRole } from "../lib/access";
import { listTrash, restoreFromTrash, purgeTrashEntry, emptyTrash } from "../lib/trash";

const user = { userId: "user-1", email: "a@example.com" } as unknown as Parameters<typeof handleTrash>[2];

function makeEnv() {
  const firsts: unknown[] = [];
  const bindCalls: unknown[][] = [];
  const first = vi.fn(() => Promise.resolve(firsts.shift() ?? null));
  const bind = vi.fn((...args: unknown[]) => { bindCalls.push(args); return { first }; });
  const prepare = vi.fn(() => ({ bind }));
  return {
    env: { DB: { prepare } } as unknown as Parameters<typeof handleTrash>[1],
    bindCalls,
    queueFirst: (v: unknown) => firsts.push(v),
  };
}

function call(env: Parameters<typeof handleTrash>[1], method: string, path: string) {
  const url = new URL(`http://localhost${path}`);
  return handleTrash(new Request(url.toString(), { method }), env, user, url);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveRole).mockResolvedValue("editor");
  vi.mocked(listTrash).mockResolvedValue([]);
  vi.mocked(restoreFromTrash).mockResolvedValue({ type: "doc", itemId: "d1", folderId: null });
  vi.mocked(emptyTrash).mockResolvedValue({ purged: 1, remaining: 0 });
});

describe("handleTrash access", () => {
  it("404s a non-member without touching the bin", async () => {
    vi.mocked(resolveRole).mockResolvedValue(null);
    const { env } = makeEnv();
    expect((await call(env, "GET", "/projects/p1/trash")).status).toBe(404);
    expect(listTrash).not.toHaveBeenCalled();
  });

  it("403s a viewer - viewers can't see or restore binned items", async () => {
    vi.mocked(resolveRole).mockResolvedValue("viewer");
    const { env } = makeEnv();
    expect((await call(env, "GET", "/projects/p1/trash")).status).toBe(403);
    expect((await call(env, "POST", "/projects/p1/trash/t1/restore")).status).toBe(403);
    expect(restoreFromTrash).not.toHaveBeenCalled();
  });

  it("checks the role against the site in the path", async () => {
    const { env } = makeEnv();
    await call(env, "GET", "/projects/p1/trash");
    expect(resolveRole).toHaveBeenCalledWith(env.DB, "p1", "user-1");
  });
});

describe("handleTrash list + restore (editor+)", () => {
  it("lists entries with retention and whether the caller may purge", async () => {
    const { env } = makeEnv();
    const res = await call(env, "GET", "/projects/p1/trash");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown }).data).toEqual({ entries: [], retentionDays: 30, canPurge: false });
    expect(listTrash).toHaveBeenCalledWith(env.DB, "p1");
  });

  it("reports canPurge for an admin", async () => {
    vi.mocked(resolveRole).mockResolvedValue("admin");
    const { env } = makeEnv();
    const res = await call(env, "GET", "/projects/p1/trash");
    expect(((await res.json()) as { data: { canPurge: boolean } }).data.canPurge).toBe(true);
  });

  it("restores an entry scoped to the site", async () => {
    const { env } = makeEnv();
    const res = await call(env, "POST", "/projects/p1/trash/t1/restore");
    expect(res.status).toBe(200);
    expect(restoreFromTrash).toHaveBeenCalledWith(env, "p1", "t1");
  });

  it("404s restoring an unknown entry", async () => {
    vi.mocked(restoreFromTrash).mockResolvedValue(null);
    const { env } = makeEnv();
    expect((await call(env, "POST", "/projects/p1/trash/nope/restore")).status).toBe(404);
  });
});

describe("handleTrash permanent delete (admin+)", () => {
  it("403s an editor deleting forever or emptying the bin", async () => {
    const { env, queueFirst } = makeEnv();
    queueFirst({ id: "t1", project_id: "p1" });
    expect((await call(env, "DELETE", "/projects/p1/trash/t1")).status).toBe(403);
    expect((await call(env, "DELETE", "/projects/p1/trash")).status).toBe(403);
    expect(purgeTrashEntry).not.toHaveBeenCalled();
    expect(emptyTrash).not.toHaveBeenCalled();
  });

  it("purges one entry for an admin, looked up within the site", async () => {
    vi.mocked(resolveRole).mockResolvedValue("admin");
    const { env, queueFirst, bindCalls } = makeEnv();
    queueFirst({ id: "t1", project_id: "p1" });
    const res = await call(env, "DELETE", "/projects/p1/trash/t1");
    expect(res.status).toBe(200);
    expect(bindCalls[0]).toEqual(["t1", "p1"]);
    expect(purgeTrashEntry).toHaveBeenCalledWith(env, { id: "t1", project_id: "p1" });
  });

  it("404s purging an entry from another site", async () => {
    vi.mocked(resolveRole).mockResolvedValue("owner");
    const { env } = makeEnv();
    expect((await call(env, "DELETE", "/projects/p1/trash/t-other")).status).toBe(404);
    expect(purgeTrashEntry).not.toHaveBeenCalled();
  });

  it("empties the bin for an owner", async () => {
    vi.mocked(resolveRole).mockResolvedValue("owner");
    const { env } = makeEnv();
    const res = await call(env, "DELETE", "/projects/p1/trash");
    expect(res.status).toBe(200);
    expect(emptyTrash).toHaveBeenCalledWith(env, "p1");
  });
});
