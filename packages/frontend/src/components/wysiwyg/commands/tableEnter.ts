import { syntaxTree } from "@codemirror/language";
import type { Command, EditorView } from "@codemirror/view";

function isInsideTable(view: EditorView): boolean {
  const sel = view.state.selection.main;
  const tree = syntaxTree(view.state);
  let node: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(sel.from, -1);
  while (node && node.name !== "Table") {
    node = node.parent;
  }
  return node !== null;
}

function countCells(lineSrc: string): number {
  let s = lineSrc.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return Math.max(s.split("|").length, 1);
}

/** Enter at the end of a table row: insert a new row with the same column count. */
export const tableContinueOnEnter: Command = (view) => {
  const sel = view.state.selection.main;
  if (sel.from !== sel.to) return false;
  if (!isInsideTable(view)) return false;

  const line = view.state.doc.lineAt(sel.from);
  if (sel.from !== line.to) return false; // only at end-of-line

  const cells = countCells(view.state.doc.sliceString(line.from, line.to));
  const newRow = "\n|" + " |".repeat(cells);
  // Position cursor inside the first new cell - "\n| " is 3 chars
  const cursorOffset = 3;

  view.dispatch({
    changes: { from: sel.from, to: sel.from, insert: newRow },
    selection: { anchor: sel.from + cursorOffset },
    scrollIntoView: true,
    userEvent: "input.type",
  });
  return true;
};
