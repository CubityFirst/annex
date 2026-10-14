import { describe, it, expect } from "vitest";
import { daysUntilPurge, restoredItemUrl, trashContentsLabel } from "./trash";

describe("trashContentsLabel", () => {
  it("summarises a binned folder's contents with pluralisation", () => {
    expect(trashContentsLabel({ item_type: "folder", doc_count: 3, file_count: 1, folder_count: 2 })).toBe("3 docs, 1 file, 2 folders");
    expect(trashContentsLabel({ item_type: "folder", doc_count: 1, file_count: 0, folder_count: 1 })).toBe("1 doc, 1 folder");
  });

  it("is empty for an empty folder or a lone doc/file", () => {
    expect(trashContentsLabel({ item_type: "folder", doc_count: 0, file_count: 0, folder_count: 0 })).toBe("");
    expect(trashContentsLabel({ item_type: "doc", doc_count: 1, file_count: 0, folder_count: 0 })).toBe("");
  });
});

describe("daysUntilPurge", () => {
  const deletedAt = "2026-10-01T00:00:00.000Z";
  const day = 24 * 60 * 60 * 1000;

  it("counts whole days remaining, rounding up", () => {
    expect(daysUntilPurge(deletedAt, 30, Date.parse(deletedAt))).toBe(30);
    expect(daysUntilPurge(deletedAt, 30, Date.parse(deletedAt) + 29.5 * day)).toBe(1);
  });

  it("never goes negative for an overdue entry", () => {
    expect(daysUntilPurge(deletedAt, 30, Date.parse(deletedAt) + 31 * day)).toBe(0);
  });
});

describe("restoredItemUrl", () => {
  it("points at the restored item's own page", () => {
    expect(restoredItemUrl("p1", { type: "doc", itemId: "d1", folderId: null })).toBe("/projects/p1/docs/d1");
    expect(restoredItemUrl("p1", { type: "file", itemId: "f1", folderId: "x" })).toBe("/projects/p1/files/f1");
    expect(restoredItemUrl("p1", { type: "folder", itemId: "a", folderId: null })).toBe("/projects/p1/folders/a");
  });
});
