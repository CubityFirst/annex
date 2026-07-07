import { Decoration } from "@codemirror/view";
import type { EditorState, Line } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";
import { cursorTouches, type VisitorArgs } from "../types";
import { parseCalloutHeader } from "@/lib/callout";
import { CalloutIconWidget, CALLOUT_CONFIG } from "../../widgets/CalloutIconWidget";
import { isCalloutCollapsed } from "../calloutFold";
import { eachLine, type MarkRange } from "../helpers";
import { hideQuoteMarks } from "./blockquote";

// Anchored at the callout's own Blockquote node start (NOT at line start), so
// indented callouts (`  > [!tip]`) and callouts nested inside quotes / lists /
// other callouts (`> > [!note]`) all match. `[ \t]` (never `\s`) so the match
// can't run across a newline.
const HEADER_PREFIX_RE = /^>[ \t]*\[!([a-zA-Z]+)\]([+\-]?)[ \t]?/;

// Leading `>` marker strip, relative to the blockquote node's own start.
const NODE_MARKER_RE = /^>[ \t]*/;

// "collapsed" → handled, body hidden, walker should NOT descend.
// "open"      → handled as a normal callout, walker should descend.
// false       → not a callout.
export type CalloutResult = "collapsed" | "open" | false;

/** Is this Blockquote node a callout? (Checks its own header line.) */
export function isCalloutNode(state: EditorState, bq: SyntaxNode): boolean {
  const line = state.doc.lineAt(bq.from);
  const src = state.doc.sliceString(bq.from, line.to);
  return parseCalloutHeader(src.replace(NODE_MARKER_RE, "")) !== null;
}

export function tryVisitCallout(args: VisitorArgs): CalloutResult {
  const { node, state, sel, reveal, decos } = args;

  const firstLine = state.doc.lineAt(node.from);
  // Slice from the node (this blockquote's own `>`), not from line start - an
  // indented or nested callout's marker sits mid-line.
  const firstSrc = state.doc.sliceString(node.from, firstLine.to);
  const stripped = firstSrc.replace(NODE_MARKER_RE, "");
  const parsed = parseCalloutHeader(stripped);
  if (!parsed) return false;

  const tone = (CALLOUT_CONFIG[parsed.type] ?? CALLOUT_CONFIG.note!).tone;
  const startLine = firstLine.number;
  const endLine = state.doc.lineAt(node.to).number;

  const foldable = parsed.fold === "+" || parsed.fold === "-";
  // When the cursor is anywhere in the callout, leave the source raw so the
  // user can edit it - never collapse under the cursor.
  const cursorIn = reveal && cursorTouches(sel, node.from, node.to);
  const collapsed =
    foldable && !cursorIn && isCalloutCollapsed(state, firstLine.from, parsed.fold);

  if (collapsed) {
    // Only the header line stays; it gets bottom rounding via --last.
    decos.push(
      Decoration.line({
        class: `cm-callout-header-line cm-callout-tone-${tone} cm-callout-body--last`,
      }).range(firstLine.from),
    );

    const prefixMatch = firstSrc.match(HEADER_PREFIX_RE);
    if (prefixMatch && prefixMatch[0].length > 0) {
      decos.push(
        Decoration.replace({
          widget: new CalloutIconWidget({
            type: parsed.type,
            showLabel: parsed.title.length === 0,
            foldable: true,
            collapsed: true,
          }),
        }).range(node.from, node.from + prefixMatch[0].length),
      );
    }

    // Hide every body line as a single block - the following content flows
    // straight after the header (same approach as the frontmatter hide).
    if (endLine > startLine) {
      const bodyStart = state.doc.line(startLine + 1);
      const lastLine = state.doc.line(endLine);
      decos.push(
        Decoration.replace({ block: true }).range(bodyStart.from, lastLine.to),
      );
    }
    return "collapsed";
  }

  // Tone styling on every line of the callout, except lines owned by a nested
  // callout - that one stamps its own header/tone classes (it renders as a
  // callout in its own right). Header line is a separate class so it can
  // carry top rounded corners; the last *stamped* line carries the bottom
  // rounding.
  const nestedCallouts: MarkRange[] = [];
  for (let c = node.node.firstChild; c; c = c.nextSibling) {
    if (c.name === "Blockquote" && isCalloutNode(state, c)) {
      nestedCallouts.push({ from: c.from, to: c.to });
    }
  }
  const stamped: Line[] = [];
  eachLine(state, node, (line) => {
    for (const r of nestedCallouts) {
      if (line.from < r.to && line.to > r.from) return;
    }
    stamped.push(line);
  });
  stamped.forEach((line, i) => {
    const isFirst = line.number === startLine;
    const isLast = i === stamped.length - 1;
    const classes = [
      isFirst ? "cm-callout-header-line" : "cm-callout-body",
      `cm-callout-tone-${tone}`,
      isLast ? "cm-callout-body--last" : "",
    ].filter(Boolean).join(" ");
    decos.push(Decoration.line({ class: classes }).range(line.from));
  });

  // Cursor inside - leave the source raw so the user can edit. Don't replace
  // the prefix with the icon widget.
  if (cursorIn) return "open";

  // Replace just "> [!type][+-]? " with an icon. Title text remains as real
  // markdown text so click coordinates land on the exact character.
  const prefixMatch = firstSrc.match(HEADER_PREFIX_RE);
  if (prefixMatch && prefixMatch[0].length > 0) {
    decos.push(
      Decoration.replace({
        widget: new CalloutIconWidget({
          type: parsed.type,
          showLabel: parsed.title.length === 0,
          foldable,
          collapsed: false,
        }),
      }).range(node.from, node.from + prefixMatch[0].length),
    );
  }

  // Hide every `>` marker in the callout body - any nesting depth, so quotes
  // and callouts inside the body render without stray markers. The cursor is
  // known to be outside the whole callout here (cursorIn returned above).
  hideQuoteMarks(args, node.node, false);

  return "open";
}
