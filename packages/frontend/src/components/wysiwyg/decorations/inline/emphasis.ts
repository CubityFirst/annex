import { Decoration } from "@codemirror/view";
import { cursorTouches, type Visitor } from "../types";
import { findEdgeMarks } from "../helpers";

function visitWrapped(
  markName: string,
  contentClass: string,
  isUnderline: (sourceFirstChar: string) => boolean,
): Visitor {
  return ({ node, state, sel, reveal, decos }) => {
    const marks = findEdgeMarks(node.node, markName);
    if (!marks) return;

    const innerFrom = marks.first.to;
    const innerTo = marks.last.from;
    if (innerFrom >= innerTo) return;

    // `__text__` parses as Strong but should render as underline.
    const useUnderline = isUnderline(state.doc.sliceString(marks.first.from, marks.first.from + 1));
    const cls = useUnderline ? "cm-underline" : contentClass;
    decos.push(Decoration.mark({ class: cls }).range(innerFrom, innerTo));

    const cursorOn = reveal && cursorTouches(sel, node.from, node.to);
    if (!cursorOn) {
      decos.push(Decoration.replace({ atomicHide: true }).range(marks.first.from, marks.first.to));
      decos.push(Decoration.replace({ atomicHide: true }).range(marks.last.from, marks.last.to));
    }
  };
}

export const visitStrong: Visitor = visitWrapped("EmphasisMark", "cm-strong", (c) => c === "_");
export const visitEmphasis: Visitor = visitWrapped("EmphasisMark", "cm-em", () => false);
export const visitStrike: Visitor = visitWrapped("StrikethroughMark", "cm-strike", () => false);
