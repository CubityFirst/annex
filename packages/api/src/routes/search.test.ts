import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleSearch, handlePublicSearch } from "./search";
import { createSqliteD1 } from "../test/sqliteD1";
import { upsertFtsRow } from "../lib/fts";

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
    // The non-limited doc path must MATCH the FTS table scoped to the site's
    // indexed pid token (and re-check project_id), with no doc_shares filter,
    // weighting title over body and pid not at all. The user's terms are
    // column-filtered to title/body and the last one prefix-starred for
    // search-as-you-type; bind order is (query, projectId).
    const docSql = prepare.mock.calls[0][0] as string;
    expect(docSql).toContain("docs_fts MATCH ?");
    expect(docSql).toContain("f.project_id = ?");
    expect(docSql).toContain("bm25(docs_fts, 5.0, 1.0, 0.0)");
    expect(docSql).not.toContain("doc_shares");
    expect(bind).toHaveBeenCalledWith('pid:"7031" AND {title body}:"hello"*', "p1");
    // The file and folder queries scope by project and LIKE-match the raw term.
    const fileSql = prepare.mock.calls[1][0] as string;
    expect(fileSql).toContain("FROM files fi");
    expect(fileSql).toContain("fi.name LIKE");
    const folderSql = prepare.mock.calls[2][0] as string;
    expect(folderSql).toContain("FROM folders fo");
    expect(folderSql).toContain("fo.name LIKE");
    expect(bind).toHaveBeenCalledWith("p1", "hello");
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
    // limited path filters the site's matches down to the caller's shares,
    // read from doc_shares by its (project_id, user_id) index.
    expect(prepare.mock.calls[0][0]).toContain("f.doc_id IN (SELECT doc_id FROM doc_shares WHERE project_id = ? AND user_id = ?)");
    expect(bind).toHaveBeenCalledWith(expect.stringContaining('pid:"7031"'), "p1", "p1", "user-1");
    // limited members have no file/folder access, so only the doc query runs.
    expect(prepare).toHaveBeenCalledTimes(1);
    const json = (await res.json()) as SearchBody;
    expect(json.data.files).toEqual([]);
    expect(json.data.folders).toEqual([]);
  });
});

// Real SQLite (FTS5) with every migration applied: the MATCH scoping is in the
// SQL, so this is what proves one site's search can't see another's docs.
describe("doc search against real SQLite", () => {
  const T0 = "2026-10-01T00:00:00.000Z";
  let env: Parameters<typeof handleSearch>[1];

  beforeEach(async () => {
    const { db, sqlite } = createSqliteD1();
    env = { DB: db } as unknown as Parameters<typeof handleSearch>[1];
    const exec = (sql: string, ...args: (string | null)[]) => sqlite.prepare(sql).run(...args);
    exec("INSERT INTO projects (id, name, owner_id, created_at, published_at) VALUES ('p1', 'One', 'u1', ?, ?)", T0, T0);
    exec("INSERT INTO projects (id, name, owner_id, created_at, published_at) VALUES ('p2', 'Two', 'u1', ?, ?)", T0, T0);
    for (const [id, p, title] of [["a1", "p1", "Dragon lore"], ["a2", "p1", "Dragon diet"], ["b1", "p2", "Dragon facts"]]) {
      exec("INSERT INTO docs (id, title, project_id, author_id, created_at, updated_at) VALUES (?, ?, ?, 'u1', ?, ?)", id, title, p, T0, T0);
    }
    await upsertFtsRow(db, "a1", "p1", "Dragon lore", "Old **dragons** sleep");
    await upsertFtsRow(db, "a2", "p1", "Dragon diet", "dragons eat a lot");
    await upsertFtsRow(db, "b1", "p2", "Dragon facts", "blue dragons");
    exec("INSERT INTO doc_shares (id, doc_id, user_id, project_id, granted_by, created_at) VALUES ('s1', 'a2', 'user-1', 'p1', 'u1', ?)", T0);
    // A share of another site's doc must not widen a limited member's p1 search.
    exec("INSERT INTO doc_shares (id, doc_id, user_id, project_id, granted_by, created_at) VALUES ('s2', 'b1', 'user-1', 'p2', 'u1', ?)", T0);
  });

  async function docIds(res: Response) {
    const json = (await res.json()) as SearchBody;
    return json.data.docs.map(d => d.doc_id).sort();
  }

  it("a member only sees the site's own docs", async () => {
    expect(await docIds(await call(env, "projectId=p1&q=drag"))).toEqual(["a1", "a2"]);
    expect(await docIds(await call(env, "projectId=p2&q=drag"))).toEqual(["b1"]);
  });

  it("returns the usual snippet", async () => {
    const res = await call(env, "projectId=p1&q=sleep");
    const json = (await res.json()) as { data: { docs: Array<{ doc_id: string; excerpt: string }> } };
    expect(json.data.docs).toEqual([expect.objectContaining({ doc_id: "a1", excerpt: "Old dragons <mark>sleep</mark>" })]);
  });

  it("a limited member only sees docs shared with them in this site", async () => {
    vi.mocked(resolveRole).mockResolvedValue("limited");
    expect(await docIds(await call(env, "projectId=p1&q=drag"))).toEqual(["a2"]);
  });

  it("public search is scoped to the published site", async () => {
    const url = new URL("http://localhost/public/search?projectId=p2&q=drag");
    const res = await handlePublicSearch(new Request(url.toString()), env, url);
    expect(await docIds(res)).toEqual(["b1"]);
  });
});
