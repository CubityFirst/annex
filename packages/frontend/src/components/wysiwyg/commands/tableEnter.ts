import type { EditorState, TransactionSpec } from "@codemirror/state";
import type { Command } from "@codemirror/view";
import { findAncestor } from "./astUtils";

/** `"\n| ".length` - the caret lands inside the first cell of an inserted row. */
const NEW_ROW_CURSOR_OFFSET = 3;

/**
 * Count the cells in a table row. A `\|` escaped pipe is cell CONTENT, not a
 * separator (GFM's escape for literal pipes, e.g. `[[Doc\|Alias]]` in a cell),
 * so escapes are skipped rather than counted.
 */
export function countCells(lineSrc: string): number {
  let s = lineSrc.trim();
  if (s.startsWith("|")) s = s.slice(1);
  let cells = 1;
  let sepAtEnd = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\") { i++; sepAtEnd = false; continue; }
    if (ch === "|") {
      cells++;
      sepAtEnd = i === s.length - 1;
    } else {
      sepAtEnd = false;
    }
  }
  // A trailing unescaped `|` closes the row rather than opening another cell.
  if (sepAtEnd) cells--;
  return Math.max(cells, 1);
}

/** A row consisting only of pipes and whitespace, e.g. `|  |  |`. */
function isEmptyRow(lineSrc: string): boolean {
  return /^\s*\|(\s*\|)*\s*$/.test(lineSrc);
}

/**
 * Pure core of `tableContinueOnEnter` - computes the transaction for an Enter
 * press inside a table, or null when the command should decline and let the
 * next Enter binding run. Exported for unit tests.
 */
export function computeTableEnter(state: EditorState): TransactionSpec | null {
  const sel = state.selection.main;
  if (!sel.empty) return null;

  const table = findAncestor(state, sel.from, "Table");
  if (!table) return null;

  const line = state.doc.lineAt(sel.from);

  // A table nested in a blockquote/callout needs `> `-prefixed rows; decline
  // so the markdown continuation keymap handles the quote instead of us
  // splicing an unquoted row into the middle of it.
  if (/^\s*>/.test(line.text)) return null;

  const tableStartLine = state.doc.lineAt(table.from);
  const tableEndLine = state.doc.lineAt(Math.min(table.to, state.doc.length));

  // Empty trailing row: Enter exits the table - delete the row so the line
  // becomes blank (terminating the table) and leave the caret on it. Mirrors
  // the "Enter on an empty list item / quote line exits" behaviour. Never
  // applies to the header (start) or delimiter (start + 1) lines.
  if (
    line.number === tableEndLine.number &&
    line.number > tableStartLine.number + 1 &&
    isEmptyRow(line.text)
  ) {
    return {
      changes: { from: line.from, to: line.to, insert: "" },
      selection: { anchor: line.from },
      scrollIntoView: true,
      userEvent: "delete",
    };
  }

  if (sel.from !== line.to) return null; // only at end-of-line

  const cells = countCells(line.text);
  const newRow = "\n|" + " |".repeat(cells);

  // Enter at the end of the HEADER row: inserting between the header and the
  // delimiter row would stop GFM from parsing the block as a table at all, so
  // the new row goes after the delimiter line instead.
  let insertAt = sel.from;
  if (line.number === tableStartLine.number) {
    if (tableEndLine.number === tableStartLine.number) return null; // no delimiter row
    insertAt = state.doc.line(line.number + 1).to;
  }

  return {
    changes: { from: insertAt, to: insertAt, insert: newRow },
    selection: { anchor: insertAt + NEW_ROW_CURSOR_OFFSET },
    scrollIntoView: true,
    // "input" (not "input.type") so history does NOT batch this structural
    // insert with adjacent typing - one undo removes just the inserted row.
    userEvent: "input",
  };
}

/**
 * Enter inside a table: insert a new row with the same column count (after
 * the delimiter when pressed at the end of the header row), or exit the
 * table when pressed on an empty trailing row.
 */
export const tableContinueOnEnter: Command = (view) => {
  const spec = computeTableEnter(view.state);
  if (!spec) return false;
  view.dispatch(spec);
  return true;
};
