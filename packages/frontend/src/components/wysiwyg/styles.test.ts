import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Plain fs read: under the jsdom env import.meta.url is not a file: URL, and
// vitest stubs .css imports (even ?raw) to empty strings. Vitest's cwd is
// always the package root.
const css = readFileSync(resolve(process.cwd(), "src/components/wysiwyg/styles.css"), "utf8");

// Regression guards for styles.css (T-H1 / T-L4 / T-M8). The theme tokens in
// index.css are full oklch() colors, so wrapping them in hsl(var(--x)) is
// invalid CSS and silently UNSETS the declaration - 16 rules were dropped
// that way before 2026-07.

describe("wysiwyg styles.css", () => {
  it("never wraps a CSS custom property in hsl() (T-H1)", () => {
    expect(css).not.toMatch(/hsl\(\s*var\(/);
  });

  it("has no rules for the never-emitted code-fence marker/info classes (T-L4)", () => {
    expect(css).not.toContain("cm-code-fence-marker");
    expect(css).not.toContain("cm-code-fence-info");
  });

  it("styles the emitted cm-code-line--first/--last classes (T-L4)", () => {
    expect(css).toContain(".cm-code-line--first");
    expect(css).toContain(".cm-code-line--last");
  });

  it("has no hardcoded hex HR colors (T-L5)", () => {
    expect(css).not.toContain("#3a3a3a");
    expect(css).not.toContain("#b0b0b0");
  });

  it("defines every callout tone variable in both light and dark blocks (T-M8)", () => {
    const tones = ["zinc", "cyan", "blue", "teal", "green", "yellow", "amber", "orange", "red", "purple"];
    for (const tone of tones) {
      const declarations = css.match(new RegExp(`--callout-tone-${tone}:`, "g")) ?? [];
      expect(declarations.length, `--callout-tone-${tone} light+dark`).toBe(2);
      // and the tone rule consumes the variable rather than a literal color
      expect(css).toContain(`.cm-callout-tone-${tone} { background-color:`);
      expect(css).toContain(`border-left-color: var(--callout-tone-${tone})`);
    }
  });
});
