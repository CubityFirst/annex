import { describe, it, expect } from "vitest";
import {
  formatBytes,
  isDocImportName,
  moveDestinations,
  folderPathLabel,
  shiftSelectionRange,
  folderCountLabel,
  bumpFolderCounts,
  countedFolderFor,
  type MoveFolderLike,
} from "./fileManager";

function folder(id: string, parent_id: string | null = null, name = id): MoveFolderLike {
  return { id, name, parent_id };
}

describe("formatBytes", () => {
  it("picks the unit by magnitude", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});

describe("isDocImportName", () => {
  it("matches .md and .txt case-insensitively", () => {
    expect(isDocImportName("notes.md")).toBe(true);
    expect(isDocImportName("README.MD")).toBe(true);
    expect(isDocImportName("todo.TXT")).toBe(true);
    expect(isDocImportName("Mixed.Md")).toBe(true);
  });

  it("rejects other extensions and md/txt fragments elsewhere in the name", () => {
    expect(isDocImportName("drawing.excalidraw")).toBe(false);
    expect(isDocImportName("photo.png")).toBe(false);
    expect(isDocImportName("md.zip")).toBe(false);
    expect(isDocImportName("md")).toBe(false);
  });
});

describe("moveDestinations", () => {
  const tree = [
    folder("a"),
    folder("a1", "a"),
    folder("a1x", "a1"),
    folder("b"),
    folder("b1", "b"),
  ];

  it("returns everything for docs and files", () => {
    expect(moveDestinations(tree, { type: "doc", id: "a" }).map(f => f.id)).toEqual(["a", "a1", "a1x", "b", "b1"]);
    expect(moveDestinations(tree, { type: "file", id: "a" }).map(f => f.id)).toEqual(["a", "a1", "a1x", "b", "b1"]);
    expect(moveDestinations(tree, null).map(f => f.id)).toEqual(["a", "a1", "a1x", "b", "b1"]);
  });

  it("excludes a moved folder and its whole descendant chain", () => {
    expect(moveDestinations(tree, { type: "folder", id: "a" }).map(f => f.id)).toEqual(["b", "b1"]);
  });

  it("excludes deep descendants even when children appear before parents in the list", () => {
    const shuffled = [folder("a1x", "a1"), folder("b"), folder("a"), folder("a1", "a")];
    expect(moveDestinations(shuffled, { type: "folder", id: "a" }).map(f => f.id)).toEqual(["b"]);
  });
});

describe("folderPathLabel", () => {
  const tree = [folder("a", null, "Alpha"), folder("a1", "a", "Nested"), folder("a1x", "a1", "Deep")];

  it("builds the ancestor path root-first", () => {
    expect(folderPathLabel(tree, tree[2])).toBe("Alpha / Nested / Deep");
    expect(folderPathLabel(tree, tree[0])).toBe("Alpha");
  });

  it("stops on a missing parent or a cycle instead of looping", () => {
    expect(folderPathLabel(tree, folder("orphan", "gone", "Orphan"))).toBe("Orphan");
    const cyclic = [folder("x", "y", "X"), folder("y", "x", "Y")];
    expect(folderPathLabel(cyclic, cyclic[0])).toBe("Y / X");
  });
});

describe("shiftSelectionRange", () => {
  it("returns the inclusive range between anchor and click", () => {
    expect(shiftSelectionRange(2, 5, 10)).toEqual({ from: 2, to: 5 });
    expect(shiftSelectionRange(5, 2, 10)).toEqual({ from: 2, to: 5 });
  });

  it("returns null without an anchor or on an empty list", () => {
    expect(shiftSelectionRange(null, 3, 10)).toBeNull();
    expect(shiftSelectionRange(2, 3, 0)).toBeNull();
  });

  // FM-H1 regression: a stale anchor from a longer, previously-rendered list
  // must never produce indexes past the end of the current one.
  it("clamps a stale out-of-bounds anchor to the current list length", () => {
    expect(shiftSelectionRange(9, 0, 2)).toEqual({ from: 0, to: 1 });
    expect(shiftSelectionRange(9, 1, 2)).toEqual({ from: 1, to: 1 });
  });
});

describe("folderCountLabel", () => {
  it("labels docs, files and folders separately", () => {
    expect(folderCountLabel({ docs: 3, files: 5, folders: 0 })).toBe("3 docs, 5 files");
    expect(folderCountLabel({ docs: 1, files: 1, folders: 1 })).toBe("1 doc, 1 file, 1 folder");
    expect(folderCountLabel({ docs: 0, files: 2, folders: 0 })).toBe("2 files");
  });

  it("is empty for an empty folder", () => {
    expect(folderCountLabel({ docs: 0, files: 0, folders: 0 })).toBe("");
  });
});

describe("bumpFolderCounts", () => {
  it("applies the delta to one folder and returns a new map", () => {
    const counts = new Map([["a", { docs: 1, files: 2, folders: 0 }], ["b", { docs: 5, files: 0, folders: 1 }]]);
    const next = bumpFolderCounts(counts, "a", { docs: 1, folders: 2 });
    expect(next).not.toBe(counts);
    expect(next.get("a")).toEqual({ docs: 2, files: 2, folders: 2 });
    expect(next.get("b")).toEqual({ docs: 5, files: 0, folders: 1 });
    // Input untouched.
    expect(counts.get("a")).toEqual({ docs: 1, files: 2, folders: 0 });
  });

  it("starts a missing entry from zero", () => {
    expect(bumpFolderCounts(new Map(), "new", { files: 1 }).get("new")).toEqual({ docs: 0, files: 1, folders: 0 });
  });

  it("never goes negative", () => {
    const counts = new Map([["a", { docs: 0, files: 1, folders: 0 }]]);
    expect(bumpFolderCounts(counts, "a", { docs: -1, files: -3 }).get("a")).toEqual({ docs: 0, files: 0, folders: 0 });
  });
});

describe("countedFolderFor", () => {
  const tree = [folder("a"), folder("a1", "a"), folder("a1x", "a1"), folder("b")];
  const listed = new Set(["a", "b"]);

  it("returns a listed folder directly", () => {
    expect(countedFolderFor("b", listed)).toBe("b");
    expect(countedFolderFor("a", listed, tree)).toBe("a");
  });

  it("walks up to the nearest listed ancestor when the tree is known", () => {
    expect(countedFolderFor("a1x", listed, tree)).toBe("a");
    expect(countedFolderFor("a1", listed, tree)).toBe("a");
  });

  it("is null for the current folder / root, unknown folders, or without the tree", () => {
    expect(countedFolderFor(null, listed, tree)).toBeNull();
    expect(countedFolderFor("a1x", listed)).toBeNull();
    expect(countedFolderFor("gone", listed, tree)).toBeNull();
    // A parent (not a listed child) of the view has no badge.
    expect(countedFolderFor("a", new Set(["a1"]), tree)).toBeNull();
  });

  it("stops on a parent cycle instead of looping", () => {
    const cyclic = [folder("x", "y"), folder("y", "x")];
    expect(countedFolderFor("x", new Set(["z"]), cyclic)).toBeNull();
  });
});
