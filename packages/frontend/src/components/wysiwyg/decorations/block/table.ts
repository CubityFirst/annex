import { Decoration } from "@codemirror/view";
import { cursorTouches, type Visitor } from "../types";
import { TableWidget } from "../../widgets/TableWidget";

export const visitTable: Visitor = ({ node, state, sel, reveal, decos }) => {
  const startLine = state.doc.lineAt(node.from);
  const endLine = state.doc.lineAt(Math.min(node.to, state.doc.length));
  const cursorIn = reveal && cursorTouches(sel, node.from, node.to);

  if (cursorIn) {
    // Cursor inside - show raw lines so columns align by monospace, and the
    // user can edit the markdown directly.
    for (let n = startLine.number; n <= endLine.number; n++) {
      const line = state.doc.line(n);
      decos.push(Decoration.line({ class: "cm-table-line" }).range(line.from));
    }
    return;
  }

  const source = state.doc.sliceString(node.from, node.to);
  decos.push(
    Decoration.replace({
      widget: new TableWidget(source),
      block: true,
    }).range(startLine.from, endLine.to),
  );
};
