import { Decoration } from "@codemirror/view";
import { cursorTouches, type Visitor } from "../types";
import { findEdgeMarks } from "../helpers";
import { renderDice } from "./dice";

export const visitInlineCode: Visitor = (args) => {
  const { node, state, sel, reveal, decos } = args;
  const marks = findEdgeMarks(node.node, "CodeMark");
  if (!marks) return;

  const innerSrc = state.doc.sliceString(marks.first.to, marks.last.from);
  if (innerSrc.startsWith("dice:")) {
    renderDice(args, marks);
    return;
  }

  decos.push(Decoration.mark({ class: "cm-inline-code", inclusive: false }).range(node.from, node.to));

  const cursorOn = reveal && cursorTouches(sel, node.from, node.to);
  if (!cursorOn) {
    decos.push(Decoration.replace({ atomicHide: true }).range(marks.first.from, marks.first.to));
    decos.push(Decoration.replace({ atomicHide: true }).range(marks.last.from, marks.last.to));
  }
};
