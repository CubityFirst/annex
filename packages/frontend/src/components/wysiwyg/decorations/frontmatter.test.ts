import { describe, it, expect } from "vitest";
import { HrWidget } from "../widgets/HrWidget";
import { FrontmatterWidget } from "../widgets/FrontmatterWidget";
import { CodeFenceWidget } from "../widgets/CodeFenceWidget";
import { stateFor, widgetsFor, visibleTextFor } from "./testSupport";

const FM_DOC = "---\ntitle: x\n---\n\nBody";

describe("frontmatterPass - hiding", () => {
  it("reading mode hides the YAML block entirely (no HR widgets for ---)", () => {
    const state = stateFor(FM_DOC);
    const visible = visibleTextFor(state);
    expect(visible).not.toContain("title");
    expect(visible).toContain("Body");
    expect(widgetsFor(state).some((w) => w instanceof HrWidget)).toBe(false);
  });

  it("hideFrontmatter hides it in editing mode too", () => {
    const state = stateFor(FM_DOC, { ctx: { revealOnCursor: true, hideFrontmatter: true }, cursor: FM_DOC.length });
    expect(visibleTextFor(state)).not.toContain("title");
  });

  it("editing mode + cursor outside renders the FrontmatterWidget card", () => {
    const state = stateFor(FM_DOC, { ctx: { revealOnCursor: true }, cursor: FM_DOC.length });
    expect(widgetsFor(state).some((w) => w instanceof FrontmatterWidget)).toBe(true);
  });

  it("editing mode + cursor inside shows raw YAML", () => {
    const state = stateFor(FM_DOC, { ctx: { revealOnCursor: true }, cursor: 6 });
    expect(widgetsFor(state).some((w) => w instanceof FrontmatterWidget)).toBe(false);
    expect(visibleTextFor(state)).toContain("title: x");
  });
});

describe("frontmatter + walker - content below still decorates", () => {
  // Regression: the walker's frontmatter node-skip pruned the tree ROOT
  // (which also starts at 0 when frontmatter opens the doc), so every doc
  // with frontmatter rendered its whole body as raw markdown.
  it("a heading and inline markup after the frontmatter get decorations", () => {
    const doc = "---\ncover: /api/files/x/content\n---\n\n# Hello\n\nSome **bold** text.\n";
    const state = stateFor(doc);
    const visible = visibleTextFor(state);
    expect(visible).not.toContain("cover:");
    expect(visible).not.toContain("# Hello"); // heading mark hidden
    expect(visible).toContain("Hello");
    expect(visible).not.toContain("**"); // emphasis marks hidden
  });

  it("special fences after frontmatter still become widgets", () => {
    const doc = "---\ntitle: x\n---\n\n```js\nconst a = 1;\n```\n";
    const state = stateFor(doc);
    expect(widgetsFor(state).some((w) => w instanceof CodeFenceWidget)).toBe(true);
  });
});

describe("frontmatterPass - edge cases", () => {
  it("an unclosed --- is not frontmatter; the opening --- degrades to an HR", () => {
    const state = stateFor("---\ntitle: x\n\nBody");
    expect(visibleTextFor(state)).toContain("title: x");
    expect(widgetsFor(state).some((w) => w instanceof HrWidget)).toBe(true);
  });

  it("frontmatter longer than the 4096-char fast path is still detected", () => {
    const doc = `---\n${"key: value\n".repeat(400)}---\nBody`;
    expect(doc.length).toBeGreaterThan(4096);
    const visible = visibleTextFor(stateFor(doc));
    expect(visible).not.toContain("key: value");
    expect(visible).toContain("Body");
  });
});

describe("walker frontmatter skip (D14)", () => {
  it("a node starting inside the YAML but extending past it is skipped", () => {
    // The unclosed ``` swallows the closing --- and the rest of the doc into
    // one FencedCode node that STARTS inside the frontmatter range. Letting
    // it through would stack a second block replace partially overlapping
    // the frontmatter's own.
    const doc = "---\na: 1\n```\n---\nafter";
    const state = stateFor(doc);
    expect(widgetsFor(state).some((w) => w instanceof CodeFenceWidget)).toBe(false);
    expect(visibleTextFor(state)).toBe("\nafter");
  });
});
