import { describe, it, expect } from "vitest";
import {
  extractRefs,
  buildFolderPaths,
  buildResolutionContext,
  resolveDoc,
  computeLinksForDoc,
  reindexProject,
  type DocRow,
  type FolderRow,
} from "./docLinks";
import { createSqliteD1 } from "../test/sqliteD1";

// ── extractRefs ──────────────────────────────────────────────────────────────

describe("extractRefs", () => {
  it("extracts a [[wikilink]]", () => {
    expect(extractRefs("See [[My Page]] for details")).toEqual(["My Page"]);
  });

  it("extracts the title from [[Title|Display]]", () => {
    expect(extractRefs("[[My Page|Click here]]")).toEqual(["My Page"]);
  });

  it("extracts the title from [[Title#anchor]]", () => {
    expect(extractRefs("[[My Page#section]]")).toEqual(["My Page"]);
  });

  it("extracts multiple wikilinks", () => {
    expect(extractRefs("[[A]] and [[B]] and [[C]]")).toEqual(["A", "B", "C"]);
  });

  it("extracts a doc:// link and decodes it", () => {
    expect(extractRefs("[link](doc://My%20Page)")).toEqual(["My Page"]);
  });

  it("extracts a relative .md link, stripping .md extension", () => {
    expect(extractRefs("[link](./guide.md)")).toEqual(["guide"]);
  });

  it("strips leading ./ from relative links", () => {
    expect(extractRefs("[link](./sub/page.md)")).toEqual(["sub/page"]);
  });

  it("returns empty array for content with no links", () => {
    expect(extractRefs("No links here.")).toEqual([]);
  });

  it("combines refs from all three link styles", () => {
    const content = "[[Wiki]] and [d](doc://Direct) and [r](./rel.md)";
    expect(extractRefs(content)).toEqual(["Wiki", "Direct", "rel"]);
  });
});

// ── buildFolderPaths ─────────────────────────────────────────────────────────

describe("buildFolderPaths", () => {
  it("returns empty map for empty input", () => {
    expect(buildFolderPaths([])).toEqual(new Map());
  });

  it("maps a top-level folder to its name", () => {
    const folders: FolderRow[] = [{ id: "f1", name: "Docs", parent_id: null }];
    expect(buildFolderPaths(folders).get("f1")).toBe("Docs");
  });

  it("builds a two-level path", () => {
    const folders: FolderRow[] = [
      { id: "f1", name: "Docs", parent_id: null },
      { id: "f2", name: "Guide", parent_id: "f1" },
    ];
    const paths = buildFolderPaths(folders);
    expect(paths.get("f1")).toBe("Docs");
    expect(paths.get("f2")).toBe("Docs/Guide");
  });

  it("builds a three-level path", () => {
    const folders: FolderRow[] = [
      { id: "f1", name: "A", parent_id: null },
      { id: "f2", name: "B", parent_id: "f1" },
      { id: "f3", name: "C", parent_id: "f2" },
    ];
    expect(buildFolderPaths(folders).get("f3")).toBe("A/B/C");
  });

  it("handles siblings independently", () => {
    const folders: FolderRow[] = [
      { id: "root", name: "Root", parent_id: null },
      { id: "a", name: "A", parent_id: "root" },
      { id: "b", name: "B", parent_id: "root" },
    ];
    const paths = buildFolderPaths(folders);
    expect(paths.get("a")).toBe("Root/A");
    expect(paths.get("b")).toBe("Root/B");
  });
});

// ── buildResolutionContext ───────────────────────────────────────────────────

describe("buildResolutionContext", () => {
  const docs: DocRow[] = [{ id: "d1", title: "My Doc", folder_id: null }];

  it("indexes docs by id", () => {
    const ctx = buildResolutionContext(docs, []);
    expect(ctx.byId.get("d1")).toBe(docs[0]);
  });

  it("indexes docs by lowercase title", () => {
    const ctx = buildResolutionContext(docs, []);
    expect(ctx.byTitle.get("my doc")).toBe(docs[0]);
  });

  it("does not overwrite first title match with a duplicate", () => {
    const d1: DocRow = { id: "d1", title: "Page", folder_id: null };
    const d2: DocRow = { id: "d2", title: "Page", folder_id: null };
    const ctx = buildResolutionContext([d1, d2], []);
    expect(ctx.byTitle.get("page")).toBe(d1);
  });

  it("builds fullPaths for docs in folders", () => {
    const folders: FolderRow[] = [{ id: "f1", name: "Guide", parent_id: null }];
    const inFolder: DocRow[] = [{ id: "d1", title: "Intro", folder_id: "f1" }];
    const ctx = buildResolutionContext(inFolder, folders);
    const entry = ctx.fullPaths[0];
    expect(entry.segments).toEqual(["guide", "intro"]);
  });
});

// ── resolveDoc ───────────────────────────────────────────────────────────────

describe("resolveDoc", () => {
  const docs: DocRow[] = [
    { id: "d1", title: "Getting Started", folder_id: null },
    { id: "d2", title: "API Reference",   folder_id: "f1" },
  ];
  const folders: FolderRow[] = [{ id: "f1", name: "Reference", parent_id: null }];
  const ctx = buildResolutionContext(docs, folders);

  it("resolves by exact title (case-insensitive)", () => {
    expect(resolveDoc("Getting Started", ctx)).toBe(docs[0]);
    expect(resolveDoc("getting started", ctx)).toBe(docs[0]);
  });

  it("resolves by id: prefix", () => {
    expect(resolveDoc("id:d1", ctx)).toBe(docs[0]);
    expect(resolveDoc("id:d2", ctx)).toBe(docs[1]);
  });

  it("returns undefined for an unknown title", () => {
    expect(resolveDoc("Nonexistent", ctx)).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(resolveDoc("", ctx)).toBeUndefined();
  });

  it("resolves a doc by partial folder path", () => {
    // "Reference/API Reference" - two-segment match
    expect(resolveDoc("Reference/API Reference", ctx)).toBe(docs[1]);
  });

  it("resolves a doc by title-only even when it is nested in a folder", () => {
    expect(resolveDoc("API Reference", ctx)).toBe(docs[1]);
  });

  it("does not match when path segments exceed the doc's full path length", () => {
    expect(resolveDoc("Extra/Reference/API Reference", ctx)).toBeUndefined();
  });
});

// ── computeLinksForDoc ───────────────────────────────────────────────────────

describe("computeLinksForDoc", () => {
  const docs: DocRow[] = [
    { id: "src", title: "Source", folder_id: null },
    { id: "tgt", title: "Target", folder_id: null },
    { id: "other", title: "Other", folder_id: null },
  ];
  const ctx = buildResolutionContext(docs, []);

  it("returns a set of target doc IDs for wikilinks found in content", () => {
    const links = computeLinksForDoc("src", "See [[Target]]", ctx);
    expect(links).toEqual(new Set(["tgt"]));
  });

  it("excludes self-links", () => {
    const links = computeLinksForDoc("src", "[[Source]]", ctx);
    expect(links.has("src")).toBe(false);
  });

  it("returns empty set when content has no known links", () => {
    const links = computeLinksForDoc("src", "No links here.", ctx);
    expect(links.size).toBe(0);
  });

  it("collects multiple distinct targets", () => {
    const links = computeLinksForDoc("src", "[[Target]] and [[Other]]", ctx);
    expect(links).toEqual(new Set(["tgt", "other"]));
  });

  it("deduplicates multiple references to the same target", () => {
    const links = computeLinksForDoc("src", "[[Target]] and [[Target]] again", ctx);
    expect(links.size).toBe(1);
  });
});

// ── reindexProject (real SQLite) ────────────────────────────────────────────

describe("reindexProject", () => {
  async function setup(bodies: Record<string, string>, storedTags: Record<string, string | null>) {
    const { db, sqlite } = createSqliteD1();
    const T = "2026-01-01T00:00:00.000Z";
    sqlite.prepare("INSERT INTO projects (id, name, owner_id, created_at, graph_indexed_at) VALUES ('p1', 'Site', 'u1', ?, NULL)").run(T);
    for (const id of Object.keys(bodies)) {
      sqlite.prepare("INSERT INTO docs (id, title, project_id, author_id, created_at, updated_at, tags) VALUES (?, ?, 'p1', 'u1', ?, ?, ?)")
        .run(id, id.toUpperCase(), T, T, storedTags[id] ?? null);
    }
    const prepareSpy: string[] = [];
    const DB = new Proxy(db, {
      get(target, prop, recv) {
        if (prop === "prepare") return (s: string) => { prepareSpy.push(s); return target.prepare(s); };
        return Reflect.get(target, prop, recv);
      },
    });
    const env = {
      DB,
      ASSETS: { get: async (key: string) => { const b = bodies[key.split("/")[1]]; return b === undefined ? null : { text: async () => b }; } },
    } as unknown as Parameters<typeof reindexProject>[0];
    return { env, sqlite, prepareSpy };
  }

  it("rebuilds the links and leaves graph_indexed_at to the caller", async () => {
    const { env, sqlite } = await setup({ a: "see [[B]]", b: "back to [[A]]", c: "" }, {});
    sqlite.prepare("INSERT INTO doc_links (source_doc_id, target_doc_id, project_id) VALUES ('c', 'a', 'p1')").run();
    await reindexProject(env, "p1");
    const links = sqlite.prepare("SELECT source_doc_id AS s, target_doc_id AS t FROM doc_links ORDER BY s").all();
    expect(links).toEqual([{ s: "a", t: "b" }, { s: "b", t: "a" }]);
    const proj = sqlite.prepare("SELECT graph_indexed_at FROM projects WHERE id = 'p1'").get() as { graph_indexed_at: string | null };
    expect(proj.graph_indexed_at).toBeNull();
  });

  it("writes docs.tags only for rows that drifted from the body", async () => {
    const { env, sqlite, prepareSpy } = await setup(
      { a: "---\ntags: [x, y]\n---\nbody", b: "---\ntags: [z]\n---\n", c: "no frontmatter" },
      { a: JSON.stringify(["x", "y"]), b: null, c: JSON.stringify(["stale"]) },
    );
    await reindexProject(env, "p1");
    const tags = Object.fromEntries(
      (sqlite.prepare("SELECT id, tags FROM docs ORDER BY id").all() as { id: string; tags: string | null }[]).map(r => [r.id, r.tags]),
    );
    expect(tags).toEqual({ a: JSON.stringify(["x", "y"]), b: JSON.stringify(["z"]), c: null });
    // In sync (a) costs no write: only b and c were updated.
    expect(prepareSpy.filter(s => s.startsWith("UPDATE docs SET tags"))).toHaveLength(2);
  });
});
