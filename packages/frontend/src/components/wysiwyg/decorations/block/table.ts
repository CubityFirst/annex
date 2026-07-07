import { Decoration } from "@codemirror/view";
import { cursorTouches, type Visitor } from "../types";
import { eachLine, forEachDescendant, type MarkRange } from "../helpers";
import { TableWidget } from "../../widgets/TableWidget";

// Returns false (don't descend) when the table rendered as a widget - inline
// decorations built under a block replace are invisible dead work. Descends
// only while the cursor keeps the raw lines visible.
export const visitTable: Visitor = ({ node, state, sel, reveal, decos }) => {
  const cursorIn = reveal && cursorTouches(sel, node.from, node.to);

  if (cursorIn) {
    // Cursor inside - show raw lines so columns align by monospace, and the
    // user can edit the markdown directly.
    eachLine(state, node, (line) => {
      decos.push(Decoration.line({ class: "cm-table-line" }).range(line.from));
    });
    return;
  }

  // A table inside a blockquote/callout carries the `> ` continuation
  // prefixes as QuoteMark nodes INSIDE the Table's range (between rows).
  // Splice them (plus one following space/tab) out of the source, otherwise
  // the widget parses the markers as cell content and grows a bogus column.
  const quoteMarks: MarkRange[] = [];
  forEachDescendant(node.node, (c) => {
    if (c.name === "QuoteMark") quoteMarks.push({ from: c.from, to: c.to });
  });
  quoteMarks.sort((a, b) => a.from - b.from);

  let source = "";
  let pos = node.from;
  for (const qm of quoteMarks) {
    if (qm.from < pos) continue;
    source += state.doc.sliceString(pos, qm.from);
    const after = state.doc.sliceString(qm.to, qm.to + 1);
    pos = after === " " || after === "\t" ? qm.to + 1 : qm.to;
  }
  source += state.doc.sliceString(pos, node.to);

  const startLine = state.doc.lineAt(node.from);
  const endLine = state.doc.lineAt(node.to);
  decos.push(
    Decoration.replace({
      widget: new TableWidget(source),
      block: true,
    }).range(startLine.from, endLine.to),
  );
  return false;
};
