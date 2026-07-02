import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleSearch } from "./search";

vi.mock("../lib/access", () => ({ resolveRole: vi.fn() }));

import { resolveRole } from "../lib/access";

const user = { userId: "user-1", email: "a@example.com" } as unknown as Parameters<typeof handleSearch>[2];

function makeEnv() {
  const alls: unknown[] = [];
  const all = vi.fn(() => Promise.resolve(alls.shift() ?? { results: [] }));
  const bind = vi.fn(() => ({ all }));
  const prepare = vi.fn((_sql?: string) => ({ bind }));
  return {
    env: { DB: { prepare } } as unknown as Parameters<typeof handleSearch>[1],
    prepare,
    bind,
    queueAll: (v: unknown) => alls.push(v),
  };
}

function call(env: Parameters<typeof handleSearch>[1], qs: string) {
  const url = new URL(`http://localhost/search?${qs}`);
  return handleSearch(new Request(url.toString()), env, user, url);
}

interface SearchBody {
  ok: boolean;
  data: {
    docs: Array<{ doc_id: string; title: string; tags?: string[]; folder?: string | null }>;
    files: Array<{ file_id: string; name: string }>;
    folders: Array<{ folder_id: string; name: string; parent: string | null }>;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveRole).mockResolvedValue("editor");
});

describe("handleSearch", () => {
  it("404s on a non-GET method", async () => {
    const { env } = makeEnv();
    const url = new URL("http://localhost/search?projectId=p1&q=hi");
    const res = await handleSearch(new Request(url.toString(), { method: "POST" }), env, user, url);
    expect(res.status).toBe(404);
  });

  it("400s when projectId is missing", async () => {
    const { env } = makeEnv();
    const res = await call(env, "q=hello");
    expect(res.status).toBe(400);
  });

  it("400s when neither q nor tag is given", async () => {
    const { env } = makeEnv();
    const res = await call(env, "projectId=p1");
    expect(res.status).toBe(400);
  });

  it("403s when the caller isn't a member", async () => {
    vi.mocked(resolveRole).mockResolvedValue(null);
    const { env } = makeEnv();
    const res = await call(env, "projectId=p1&q=hello");
    expect(res.status).toBe(403);
  });

  it("runs a full-text search and returns doc + file + folder hits", async () => {
    const { env, prepare, bind, queueAll } = makeEnv();
    queueAll({ results: [{ doc_id: "d1", title: "Doc", excerpt: "<mark>hello</mark>", folder: null, updated_at: "2026-01-01" }] });
    queueAll({ results: [{ file_id: "f1", name: "hello.png", mime_type: "image/png", folder: "Assets", updated_at: "2026-01-02" }] });
    queueAll({ results: [{ folder_id: "fo1", name: "Hello world", parent: null }] });
    const res = await call(env, "projectId=p1&q=hello");
    expect(res.status).toBe(200);
    const json = (await res.json()) as SearchBody;
    expect(json.data.docs).toHaveLength(1);
    expect(json.data.docs[0].doc_id).toBe("d1");
    expect(json.data.files).toHaveLength(1);
    expect(json.data.files[0].file_id).toBe("f1");
    expect(json.data.folders).toHaveLength(1);
    expect(json.data.folders[0].folder_id).toBe("fo1");
    // The non-limited doc path must MATCH the FTS table AND scope by project,
    // with no doc_shares join, weighting title over body. sanitizeFtsQuery
    // prefix-stars the last word for search-as-you-type; bind order is
    // (query, projectId).
    const docSql = prepare.mock.calls[0][0] as string;
    expect(docSql).toContain("docs_fts MATCH ?");
    expect(docSql).toContain("f.project_id = ?");
    expect(docSql).toContain("bm25(docs_fts, 5.0, 1.0)");
    expect(docSql).not.toContain("doc_shares");
    expect(bind).toHaveBeenCalledWith('"hello"*', "p1");
    // The file and folder queries scope by project and LIKE-match the raw term.
    const fileSql = prepare.mock.calls[1][0] as string;
    expect(fileSql).toContain("FROM files fi");
    expect(fileSql).toContain("fi.name LIKE");
    const folderSql = prepare.mock.calls[2][0] as string;
    expect(folderSql).toContain("FROM folders fo");
    expect(folderSql).toContain("fo.name LIKE");
    expect(bind).toHaveBeenCalledWith("p1", "hello");
  });

  it("prefix-stars only the last word of a multi-word query", async () => {
    const { env, bind } = makeEnv();
    await call(env, "projectId=p1&q=hello+worl");
    expect(bind).toHaveBeenCalledWith('"hello" "worl"*', "p1");
  });

  it("escapes LIKE wildcards in the file-name term", async () => {
    const { env, bind } = makeEnv();
    await call(env, `projectId=p1&q=${encodeURIComponent("100%_done")}`);
    expect(bind).toHaveBeenCalledWith("p1", "100\\%\\_done");
  });

  it("runs a tag search and parses the tags JSON", async () => {
    const { env, prepare, bind, queueAll } = makeEnv();
    queueAll({ results: [{ doc_id: "d1", title: "Doc", tags: JSON.stringify(["alpha", "beta"]), folder: "Guides", updated_at: "2026-01-01" }] });
    const res = await call(env, "projectId=p1&tag=alph");
    expect(res.status).toBe(200);
    const json = (await res.json()) as SearchBody;
    expect(json.data.docs[0].tags).toEqual(["alpha", "beta"]);
    expect(json.data.docs[0].folder).toBe("Guides");
    expect(json.data.files).toEqual([]);
    // Non-limited tag search scopes by project and binds (projectId, tag).
    const sql = prepare.mock.calls[0][0] as string;
    expect(sql).toContain("d.project_id = ?");
    expect(bind).toHaveBeenCalledWith("p1", "alph");
  });

  it("uses the doc-shares-scoped tag query for a limited member", async () => {
    vi.mocked(resolveRole).mockResolvedValue("limited");
    const { env, prepare, bind, queueAll } = makeEnv();
    queueAll({ results: [] });
    await call(env, "projectId=p1&tag=alph");
    // limited path joins doc_shares and binds (userId, projectId, tag) in order.
    const sql = prepare.mock.calls[0][0] as string;
    expect(sql).toContain("doc_shares");
    expect(bind).toHaveBeenCalledWith("user-1", "p1", "alph");
  });

  it("uses the doc-shares-scoped query and skips files + folders for a limited member", async () => {
    vi.mocked(resolveRole).mockResolvedValue("limited");
    const { env, prepare, bind, queueAll } = makeEnv();
    queueAll({ results: [] });
    const res = await call(env, "projectId=p1&q=hello");
    // limited path binds the userId first (for the doc_shares join)
    expect(bind).toHaveBeenCalledWith("user-1", expect.anything(), "p1");
    // limited members have no file/folder access, so only the doc query runs.
    expect(prepare).toHaveBeenCalledTimes(1);
    const json = (await res.json()) as SearchBody;
    expect(json.data.files).toEqual([]);
    expect(json.data.folders).toEqual([]);
  });
});
