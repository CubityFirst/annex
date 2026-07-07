import { Decoration } from "@codemirror/view";
import { cursorTouches, type VisitorArgs } from "../types";
import type { MarkRange } from "../helpers";
import { DiceWidget } from "../../widgets/DiceWidget";

// Inline `dice: …` is detected post-hoc inside the InlineCode visitor so we
// don't need a Lezer extension. Called only when the inline-code content
// starts with "dice:" - the caller passes the CodeMark edges it already
// found, so we don't re-scan them.
export function renderDice(
  { node, state, sel, reveal, decos }: VisitorArgs,
  marks: { first: MarkRange; last: MarkRange },
): void {
  const cursorOn = reveal && cursorTouches(sel, node.from, node.to);
  if (cursorOn) {
    decos.push(Decoration.mark({ class: "cm-inline-code" }).range(node.from, node.to));
    return;
  }

  const inner = state.doc.sliceString(marks.first.to, marks.last.from).slice("dice:".length).trim();
  decos.push(
    Decoration.replace({ widget: new DiceWidget(inner) }).range(node.from, node.to),
  );
}
