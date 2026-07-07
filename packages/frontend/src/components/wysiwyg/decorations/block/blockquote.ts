import { Decoration } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { cursorTouches, type VisitorArgs } from "../types";
import { tryVisitCallout } from "./callout";
import { eachLine, forEachDescendant } from "../helpers";

/**
 * Hide every `>` quote marker (plus one following space/tab) in `parent`'s
 * subtree. Lezer emits a QuoteMark node for every marker, at any offset - so
 * this handles nested quotes (`> > inner`), indented quotes (`  > x`) and
 * quotes inside list items, which a line-anchored `^>\s?` regex misses.
 *
 * Deduped through the build pass so an ancestor and a descendant visitor
 * never stack identical replaces on the same marker.
 *
 * `perLineReveal` keeps the raw marker visible on lines the cursor touches
 * (plain blockquotes reveal per line; callouts reveal the whole block and
 * pass false because the cursor is known to be outside).
 */
export function hideQuoteMarks(
  args: VisitorArgs,
  parent: SyntaxNode,
  perLineReveal: boolean,
): void {
  const { state, sel, reveal, decos, pass } = args;
  forEachDescendant(parent, (c) => {
    if (c.name !== "QuoteMark") return;
    if (pass.hiddenQuoteMarks.has(c.from)) return;
    if (perLineReveal && reveal) {
      const line = state.doc.lineAt(c.from);
      if (cursorTouches(sel, line.from, line.to)) return;
    }
    pass.hiddenQuoteMarks.add(c.from);
    const after = state.doc.sliceString(c.to, c.to + 1);
    const hideTo = after === " " || after === "\t" ? c.to + 1 : c.to;
    decos.push(Decoration.replace({}).range(c.from, hideTo));
  });
}

// Returns false when the walker should NOT descend into this node's children
// (a collapsed callout - its body is hidden, so inline visitors must not add
// decorations inside the block-replaced range). Returns void to descend.
export const visitBlockquote = (args: VisitorArgs): false | void => {
  const result = tryVisitCallout(args);
  if (result === "collapsed") return false;
  if (result === "open") return;

  const { node, state, decos, pass } = args;

  // One blockquote line class per line, no matter how deep the nesting -
  // the pass-level set stops descendants from re-stamping ancestor lines.
  eachLine(state, node, (line) => {
    if (pass.quoteLines.has(line.number)) return;
    pass.quoteLines.add(line.number);
    decos.push(Decoration.line({ class: "cm-blockquote" }).range(line.from));
  });

  // Per-line reveal: only the cursor's line keeps its raw `>` markers
  // visible; other lines hide them so the rendered blockquote reads cleanly.
  hideQuoteMarks(args, node.node, true);
};
