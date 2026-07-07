import { describe, it, expect } from "vitest";
import type { EditorState } from "@codemirror/state";
import { stateFor, entriesFor, visibleTextFor } from "./testSupport";

// Line-decoration id attributes per 1-indexed line number.
function headingIdsFor(state: EditorState): Map<number, string> {
  const out = new Map<number, string>();
  for (const e of entriesFor(state)) {
    if (e.from !== e.to) continue;
    const id = (e.deco.spec.attributes as { id?: string } | undefined)?.id;
    if (!id) continue;
    out.set(state.doc.lineAt(e.from).number, id);
  }
  return out;
}

describe("visitHeading - slug generation (D15)", () => {
  it("duplicate heading texts get -1/-2 suffixes; first keeps the bare slug", () => {
    const state = stateFor("# Dup\n\n## Dup\n\n### Dup\n\n# Other");
    const ids = headingIdsFor(state);
    expect(ids.get(1)).toBe("dup");
    expect(ids.get(3)).toBe("dup-1");
    expect(ids.get(5)).toBe("dup-2");
    expect(ids.get(7)).toBe("other");
  });

  it("indented headings get slugs too", () => {
    const state = stateFor("   # Indented Heading");
    expect(headingIdsFor(state).get(1)).toBe("indented-heading");
  });

  it("an ATX closing sequence is not part of the slug", () => {
    const state = stateFor("# Title #");
    expect(headingIdsFor(state).get(1)).toBe("title");
  });
});

describe("visitHeading - marker hiding (D12)", () => {
  it("hides the leading marks", () => {
    expect(visibleTextFor(stateFor("# One\n\n## Two"))).toBe("One\n\nTwo");
  });

  it("hides the ATX closing sequence and its separating whitespace", () => {
    expect(visibleTextFor(stateFor("# Title #"))).toBe("Title");
    expect(visibleTextFor(stateFor("## Sub ##"))).toBe("Sub");
  });

  it("cursor on the heading line reveals all markers in editing mode", () => {
    const state = stateFor("# Title #", { ctx: { revealOnCursor: true }, cursor: 2 });
    expect(visibleTextFor(state)).toBe("# Title #");
  });
});
