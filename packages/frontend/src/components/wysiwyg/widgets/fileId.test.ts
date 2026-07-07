import { describe, it, expect } from "vitest";
import { isSafeFileId } from "./fileId";

describe("isSafeFileId (W-S2)", () => {
  it("accepts UUID-ish and URL-safe ids", () => {
    expect(isSafeFileId("0b9e2f6a-9f2d-4d7a-8f3a-1c2d3e4f5a6b")).toBe(true);
    expect(isSafeFileId("file-abc123")).toBe(true);
    expect(isSafeFileId("A_Z-09")).toBe(true);
  });

  it("rejects the empty string", () => {
    expect(isSafeFileId("")).toBe(false);
  });

  it("rejects path traversal and separators", () => {
    expect(isSafeFileId("../projects")).toBe(false);
    expect(isSafeFileId("..")).toBe(false);
    expect(isSafeFileId("a/b")).toBe(false);
    expect(isSafeFileId("a\\b")).toBe(false);
  });

  it("rejects query/fragment/percent-encoding characters", () => {
    expect(isSafeFileId("a?x=1")).toBe(false);
    expect(isSafeFileId("a#frag")).toBe(false);
    expect(isSafeFileId("a%2e%2e")).toBe(false);
    expect(isSafeFileId("a&b")).toBe(false);
  });

  it("rejects whitespace and non-ASCII", () => {
    expect(isSafeFileId("a b")).toBe(false);
    expect(isSafeFileId("a\n")).toBe(false);
    expect(isSafeFileId("fïle")).toBe(false);
  });
});
