import { describe, it, expect } from "vitest";
import { ImageWidget } from "../../widgets/ImageWidget";
import { stateFor, entriesFor, widgetsForDoc, visibleTextFor } from "../testSupport";

function imageEntries(doc: string) {
  return entriesFor(stateFor(doc)).filter((e) => e.deco.spec.widget instanceof ImageWidget);
}

describe("visitImage - inline vs block", () => {
  it("an image alone on its line renders as a block widget", () => {
    const [entry] = imageEntries("![alt](img.png)");
    expect(entry).toBeDefined();
    expect(entry!.deco.spec.block).toBe(true);
  });

  it("an image with surrounding text renders inline", () => {
    const doc = "before ![alt](img.png) after";
    const [entry] = imageEntries(doc);
    expect(entry).toBeDefined();
    expect(entry!.deco.spec.block).toBeFalsy();
    expect(entry!.from).toBe("before ".length);
    expect(entry!.to).toBe("before ![alt](img.png)".length);
  });

  it("a `]` in the alt text bails out (no widget)", () => {
    expect(imageEntries("![a]b](img.png)")).toHaveLength(0);
  });
});

describe("visitImage - attribute blocks (D18)", () => {
  it("a complete attr block is consumed with the image", () => {
    expect(visibleTextFor(stateFor("x ![a](i.png){width=50%} y"))).toBe("x  y");
  });

  it("an attr block longer than 200 chars is still fully consumed", () => {
    const attrs = `{width=50% data-note=${"a".repeat(300)}}`;
    expect(visibleTextFor(stateFor(`x ![a](i.png)${attrs} y`))).toBe("x  y");
  });

  it("a partially-typed attr block is consumed to end of line", () => {
    expect(visibleTextFor(stateFor("x ![a](i.png){wid"))).toBe("x ");
  });
});

describe("visitImage - cursor reveal (D26)", () => {
  it("cursor on the image reveals raw source with the cm-image-source class", () => {
    const state = stateFor("![a](i.png)", { ctx: { revealOnCursor: true }, cursor: 2 });
    expect(widgetsForDoc("![a](i.png)", { ctx: { revealOnCursor: true }, cursor: 2 })
      .some((w) => w instanceof ImageWidget)).toBe(false);
    const marks = entriesFor(state).filter((e) => e.deco.spec.class === "cm-image-source");
    expect(marks).toHaveLength(1);
    expect(marks[0]!.from).toBe(0);
    expect(marks[0]!.to).toBe("![a](i.png)".length);
  });
});
