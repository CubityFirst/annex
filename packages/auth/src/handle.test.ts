import { describe, it, expect } from "vitest";
import { normalizeHandle, handleProblem, isValidHandle } from "./handle";

describe("normalizeHandle", () => {
  it("trims, drops a single leading @ and lowercases", () => {
    expect(normalizeHandle("  @Cubity_First ")).toBe("cubity_first");
    expect(normalizeHandle("@@x")).toBe("@x");
  });
});

describe("handleProblem", () => {
  it("accepts letters, digits, underscores and inner hyphens", () => {
    for (const h of ["abc", "a-b_c", "user123", "9lives", "x".repeat(30)]) {
      expect(handleProblem(h), h).toBeNull();
    }
  });

  it("enforces the 3-30 length window", () => {
    expect(handleProblem("ab")).toBe("length");
    expect(handleProblem("x".repeat(31))).toBe("length");
  });

  it("rejects disallowed characters and leading/trailing punctuation", () => {
    for (const h of ["has space", "dot.ted", "Upper", "-lead", "trail_", "emoji😀x", "a/b", "..."]) {
      expect(handleProblem(h), h).toBe("characters");
    }
  });

  it("rejects reserved names", () => {
    expect(handleProblem("admin")).toBe("reserved");
    expect(handleProblem("support")).toBe("reserved");
    expect(isValidHandle("admin")).toBe(false);
    expect(isValidHandle("admin2")).toBe(true);
  });
});
