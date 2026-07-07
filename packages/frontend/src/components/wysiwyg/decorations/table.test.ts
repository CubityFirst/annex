import { describe, it, expect } from "vitest";
import { TableWidget } from "../widgets/TableWidget";
import { stateFor, entriesFor, widgetsFor } from "./testSupport";

const QUOTED_TABLE = "> | a | b |\n> | - | - |\n> | 1 | 2 |";
const PLAIN_TABLE = "| a | b |\n| - | - |\n| 1 | 2 |";

describe("visitTable - quote-prefix stripping (D3)", () => {
  it("a table inside a blockquote strips the `> ` continuation prefixes", () => {
    const widgets = widgetsFor(stateFor(QUOTED_TABLE));
    const table = widgets.find((w) => w instanceof TableWidget) as TableWidget;
    expect(table).toBeDefined();
    expect(table.eq(new TableWidget(PLAIN_TABLE))).toBe(true);
  });

  it("a table inside a callout strips the prefixes too", () => {
    // The blank quoted line is required - a GFM table can't interrupt the
    // callout's title paragraph.
    const widgets = widgetsFor(stateFor(`> [!tip] t\n>\n${QUOTED_TABLE}`));
    const table = widgets.find((w) => w instanceof TableWidget) as TableWidget;
    expect(table).toBeDefined();
    expect(table.eq(new TableWidget(PLAIN_TABLE))).toBe(true);
  });

  it("a plain table's source is untouched", () => {
    const widgets = widgetsFor(stateFor(PLAIN_TABLE));
    const table = widgets.find((w) => w instanceof TableWidget) as TableWidget;
    expect(table.eq(new TableWidget(PLAIN_TABLE))).toBe(true);
  });
});

describe("visitTable - descend gating (D22/W-L11)", () => {
  const BOLD_CELL_TABLE = "| a |\n| - |\n| **b** |";

  it("no inline decorations are built under a rendered table widget", () => {
    const state = stateFor(BOLD_CELL_TABLE); // reading mode - widget renders
    const entries = entriesFor(state);
    expect(entries.some((e) => e.deco.spec.widget instanceof TableWidget)).toBe(true);
    // The **b** cell must NOT produce a cm-strong mark - the walker skips
    // descending into a table that the block widget replaces.
    expect(entries.some((e) => e.deco.spec.class === "cm-strong")).toBe(false);
  });

  it("raw table lines (cursor inside, editing mode) still get inline decorations", () => {
    const state = stateFor(BOLD_CELL_TABLE, { ctx: { revealOnCursor: true }, cursor: 2 });
    const entries = entriesFor(state);
    expect(entries.some((e) => e.deco.spec.widget instanceof TableWidget)).toBe(false);
    expect(entries.some((e) => e.deco.spec.class === "cm-table-line")).toBe(true);
    expect(entries.some((e) => e.deco.spec.class === "cm-strong")).toBe(true);
  });
});
