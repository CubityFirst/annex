import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { computeTableEnter, countCells } from "./tableEnter";

// Build a fully-parsed state (GFM tables come from markdownLanguage) with the
// selection at `anchor`(-`head`), matching how the Enter command sees the doc.
function stateFor(doc: string, anchor: number, head = anchor): EditorState {
  const state = EditorState.create({
    doc,
    selection: { anchor, head },
    extensions: [markdown({ base: markdownLanguage })],
  });
  ensureSyntaxTree(state, doc.length, 5000);
  return state;
}

function apply(doc: string, anchor: number, head = anchor): { doc: string; cursor: number } | null {
  const state = stateFor(doc, anchor, head);
  const spec = computeTableEnter(state);
  if (!spec) return null;
  const tr = state.update(spec);
  return { doc: tr.state.doc.toString(), cursor: tr.state.selection.main.head };
}

const TABLE = "| a | b |\n| --- | --- |\n| x | y |";

describe("countCells", () => {
  it("counts pipe-delimited cells", () => {
    expect(countCells("| a | b |")).toBe(2);
    expect(countCells("| a | b | c |")).toBe(3);
  });
  it("treats \\| escaped pipes as cell content, not separators (T-L2)", () => {
    expect(countCells("| a \\| b |")).toBe(1);
    expect(countCells("| a \\| b | c |")).toBe(2);
  });
  it("handles rows without outer pipes", () => {
    expect(countCells("a | b")).toBe(2);
  });
  it("handles single-cell and degenerate rows", () => {
    expect(countCells("| |")).toBe(1);
    expect(countCells("|")).toBe(1);
    expect(countCells("| a | b")).toBe(2); // no trailing pipe
  });
});

describe("computeTableEnter - row continuation", () => {
  it("Enter at the end of a body row appends a matching empty row", () => {
    const res = apply(TABLE, TABLE.length);
    expect(res).not.toBeNull();
    expect(res!.doc).toBe(TABLE + "\n| | |");
    // caret inside the first new cell, after "\n| "
    expect(res!.cursor).toBe(TABLE.length + 3);
  });

  it("keeps 1-cell tables at one cell", () => {
    const doc = "| a |\n| --- |\n| b |";
    const res = apply(doc, doc.length);
    expect(res!.doc).toBe(doc + "\n| |");
  });

  it("respects \\| escaped pipes in the source row", () => {
    const doc = "| h |\n| --- |\n| a \\| b |";
    const res = apply(doc, doc.length);
    expect(res!.doc).toBe(doc + "\n| |"); // one cell, not two
  });
});

describe("computeTableEnter - header row (T-M3)", () => {
  it("Enter at the end of the header row inserts AFTER the delimiter, not between", () => {
    const headerEnd = "| a | b |".length;
    const res = apply(TABLE, headerEnd);
    expect(res).not.toBeNull();
    expect(res!.doc).toBe("| a | b |\n| --- | --- |\n| | |\n| x | y |");
    // line 2 is still the delimiter - the table survives
    expect(res!.doc.split("\n")[1]).toBe("| --- | --- |");
    // caret inside the first cell of the inserted row
    const delimEnd = "| a | b |\n| --- | --- |".length;
    expect(res!.cursor).toBe(delimEnd + 3);
  });

  it("works on a header+delimiter-only table (appends after the delimiter)", () => {
    const doc = "| a | b |\n| --- | --- |";
    const res = apply(doc, "| a | b |".length);
    expect(res!.doc).toBe(doc + "\n| | |");
  });

  it("declines on a lone header line (not a table without its delimiter)", () => {
    expect(apply("| a | b |", 9)).toBeNull();
  });
});

describe("computeTableEnter - empty trailing row exits the table (T-M4)", () => {
  const doc = "| a |\n| --- |\n| x |\n| |";

  it("Enter at the end of an empty trailing row deletes it and leaves the caret on the blank line", () => {
    const res = apply(doc, doc.length);
    expect(res).not.toBeNull();
    expect(res!.doc).toBe("| a |\n| --- |\n| x |\n");
    expect(res!.cursor).toBe("| a |\n| --- |\n| x |\n".length);
  });

  it("also exits when the caret is mid-way through the empty row (double-Enter flow)", () => {
    const res = apply(doc, doc.length - 1);
    expect(res!.doc).toBe("| a |\n| --- |\n| x |\n");
  });

  it("does NOT exit on an empty row that is not the last row", () => {
    const mid = "| a |\n| --- |\n| |\n| x |";
    const emptyRowEnd = "| a |\n| --- |\n| |".length;
    const res = apply(mid, emptyRowEnd);
    // normal continuation instead: a new row is inserted, nothing deleted
    expect(res).not.toBeNull();
    expect(res!.doc).toBe("| a |\n| --- |\n| |\n| |\n| x |");
  });

  it("does NOT treat an empty header row as an exit", () => {
    const doc2 = "| |\n| --- |";
    const res = apply(doc2, "| |".length);
    // header path: row inserted after the delimiter, header untouched
    expect(res).not.toBeNull();
    expect(res!.doc).toBe("| |\n| --- |\n| |");
  });
});

describe("computeTableEnter - declines", () => {
  it("declines outside a table", () => {
    expect(apply("hello", 5)).toBeNull();
  });

  it("declines mid-row (caret not at end of line)", () => {
    expect(apply(TABLE, TABLE.length - 3)).toBeNull();
  });

  it("declines on a non-empty selection", () => {
    expect(apply(TABLE, 2, 4)).toBeNull();
  });

  it("declines inside a blockquoted table (rows would need '> ' prefixes)", () => {
    const quoted = "> | a | b |\n> | --- | --- |\n> | x | y |";
    expect(apply(quoted, quoted.length)).toBeNull();
  });
});
