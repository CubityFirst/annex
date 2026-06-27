import { describe, it, expect } from "vitest";
import {
  extractRefs,
  buildFolderPaths,
  buildResolutionContext,
  resolveDoc,
  computeLinksForDoc,
  type DocRow,
  type FolderRow,
} from "./docLinks";

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

  it("resolves by last segment when partial path matches", () => {
    // Just the leaf "API Reference" should resolve
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
