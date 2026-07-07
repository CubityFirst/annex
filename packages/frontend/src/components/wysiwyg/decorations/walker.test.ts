import { describe, it, expect, vi, afterEach } from "vitest";
import { Decoration } from "@codemirror/view";

// Make one visitor throw so the walker's outer try/catch is exercised.
vi.mock("./inline/emphasis", () => ({
  visitStrong: () => {
    throw new Error("boom: visitor regression");
  },
  visitEmphasis: () => {},
  visitStrike: () => {},
}));

import { buildDecorations } from "./walker";
import { stateFor } from "./testSupport";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildDecorations - visitor error path", () => {
  it("a throwing visitor degrades to Decoration.none and logs", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const state = stateFor("some **bold** text");
    const result = buildDecorations(state);
    expect(result).toBe(Decoration.none);
    expect(result.size).toBe(0);
    expect(errSpy).toHaveBeenCalledWith(
      "[wysiwyg] decoration build failed",
      expect.any(Error),
    );
  });

  it("a doc that never hits the broken visitor still builds decorations", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const state = stateFor("# heading only");
    const result = buildDecorations(state);
    expect(result.size).toBeGreaterThan(0);
    expect(errSpy).not.toHaveBeenCalled();
  });
});
