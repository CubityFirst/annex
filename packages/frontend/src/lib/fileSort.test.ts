import { describe, it, expect } from "vitest";
import { sortFolders, sortDocs, sortFiles, SortCol, type SortState } from "./fileSort";

const asc = (colIdx: number): SortState => ({ colIdx, dir: "asc" });
const desc = (colIdx: number): SortState => ({ colIdx, dir: "desc" });

const names = <T extends { name: string }>(rows: T[]) => rows.map(r => r.name);
const titles = <T extends { title: string }>(rows: T[]) => rows.map(r => r.title);

describe("sortFolders", () => {
  const folders = [{ name: "Zeta" }, { name: "alpha" }, { name: "item10" }, { name: "item2" }];

  it("sorts by name ascending, case-insensitive and natural numeric", () => {
    expect(names(sortFolders(folders, asc(SortCol.Name)))).toEqual([
      "alpha",
      "item2",
      "item10",
      "Zeta",
    ]);
  });

  it("sorts by name descending", () => {
    expect(names(sortFolders(folders, desc(SortCol.Name)))).toEqual([
      "Zeta",
      "item10",
      "item2",
      "alpha",
    ]);
  });

  it("falls back to name-ascending for non-Name columns", () => {
    for (const col of [SortCol.CreatedBy, SortCol.Size, SortCol.Updated]) {
      expect(names(sortFolders(folders, desc(col)))).toEqual([
        "alpha",
        "item2",
        "item10",
        "Zeta",
      ]);
    }
  });

  it("returns the input untouched when sort is null", () => {
    expect(sortFolders(folders, null)).toBe(folders);
  });
});

describe("sortDocs", () => {
  const docs = [
    { title: "Banana", author_name: "Carol", updated_at: "2026-01-10T00:00:00Z" },
    { title: "apple", author_name: "alice", updated_at: "2026-03-01T00:00:00Z" },
    { title: "Cherry", updated_at: "2026-02-15T00:00:00Z" }, // no author_name
  ];

  it("sorts by title (Name column)", () => {
    expect(titles(sortDocs(docs, asc(SortCol.Name)))).toEqual(["apple", "Banana", "Cherry"]);
    expect(titles(sortDocs(docs, desc(SortCol.Name)))).toEqual(["Cherry", "Banana", "apple"]);
  });

  it("sorts by author_name and pushes missing author to the end in both directions", () => {
    expect(titles(sortDocs(docs, asc(SortCol.CreatedBy)))).toEqual(["apple", "Banana", "Cherry"]);
    expect(titles(sortDocs(docs, desc(SortCol.CreatedBy)))).toEqual(["Banana", "apple", "Cherry"]);
  });

  it("sorts by updated_at as dates", () => {
    expect(titles(sortDocs(docs, asc(SortCol.Updated)))).toEqual(["Banana", "Cherry", "apple"]);
    expect(titles(sortDocs(docs, desc(SortCol.Updated)))).toEqual(["apple", "Cherry", "Banana"]);
  });

  it("falls back to title-ascending for the Size column (docs have no size)", () => {
    expect(titles(sortDocs(docs, desc(SortCol.Size)))).toEqual(["apple", "Banana", "Cherry"]);
  });
});

describe("sortFiles", () => {
  const files = [
    { name: "b.txt", uploader_name: "Bob", size: 500, created_at: "2026-01-01T00:00:00Z" },
    { name: "a.txt", uploader_name: "ann", size: 90, created_at: "2026-05-01T00:00:00Z" },
    { name: "c.txt", size: 1500, created_at: "2026-03-01T00:00:00Z" }, // no uploader_name
  ];

  it("sorts by raw byte size numerically (not lexically)", () => {
    expect(names(sortFiles(files, asc(SortCol.Size)))).toEqual(["a.txt", "b.txt", "c.txt"]);
    expect(names(sortFiles(files, desc(SortCol.Size)))).toEqual(["c.txt", "b.txt", "a.txt"]);
  });

  it("sorts by created_at as dates", () => {
    expect(names(sortFiles(files, asc(SortCol.Updated)))).toEqual(["b.txt", "c.txt", "a.txt"]);
  });

  it("prefers updated_at over created_at for the Updated column (mutable drawings)", () => {
    const withUpdated = [
      { name: "old-upload.png", size: 1, created_at: "2026-01-05T00:00:00Z" },
      // Created first but saved most recently - must sort as newest.
      { name: "drawing.excalidraw", size: 1, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-09T00:00:00Z" },
      { name: "new-upload.png", size: 1, created_at: "2026-01-07T00:00:00Z" },
    ];
    expect(names(sortFiles(withUpdated, desc(SortCol.Updated)))).toEqual([
      "drawing.excalidraw",
      "new-upload.png",
      "old-upload.png",
    ]);
  });

  it("sorts by uploader_name with missing uploader last in both directions", () => {
    expect(names(sortFiles(files, asc(SortCol.CreatedBy)))).toEqual(["a.txt", "b.txt", "c.txt"]);
    expect(names(sortFiles(files, desc(SortCol.CreatedBy)))).toEqual(["b.txt", "a.txt", "c.txt"]);
  });
});

describe("stability", () => {
  it("keeps original relative order for equal keys (asc and desc)", () => {
    const rows = [
      { name: "x", size: 10, uploader_name: "u", created_at: "2026-01-01T00:00:00Z", id: 1 },
      { name: "x", size: 10, uploader_name: "u", created_at: "2026-01-01T00:00:00Z", id: 2 },
      { name: "x", size: 10, uploader_name: "u", created_at: "2026-01-01T00:00:00Z", id: 3 },
    ];
    expect(sortFiles(rows, asc(SortCol.Name)).map(r => r.id)).toEqual([1, 2, 3]);
    expect(sortFiles(rows, desc(SortCol.Name)).map(r => r.id)).toEqual([1, 2, 3]);
  });
});
