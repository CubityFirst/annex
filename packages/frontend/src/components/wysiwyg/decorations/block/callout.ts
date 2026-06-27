import { Decoration } from "@codemirror/view";
import { cursorTouches, type Visitor } from "../types";
import { parseCalloutHeader } from "@/lib/callout";
import { CalloutIconWidget, CALLOUT_CONFIG } from "../../widgets/CalloutIconWidget";
import { isCalloutCollapsed } from "../calloutFold";

const HEADER_PREFIX_RE = /^>\s*\[!([a-zA-Z]+)\]([+\-]?)\s?/;

// "collapsed" → handled, body hidden, walker should NOT descend.
// "open"      → handled as a normal callout, walker should descend.
// false       → not a callout.
export type CalloutResult = "collapsed" | "open" | false;

export function tryVisitCallout(
  args: Parameters<Visitor>[0],
): CalloutResult {
  const { node, state, sel, reveal, decos } = args;

  const firstLine = state.doc.lineAt(node.from);
  const firstSrc = state.doc.sliceString(firstLine.from, firstLine.to);
  const stripped = firstSrc.replace(/^>\s?/, "");
  const parsed = parseCalloutHeader(stripped);
  if (!parsed) return false;

  const tone = (CALLOUT_CONFIG[parsed.type] ?? CALLOUT_CONFIG.note!).tone;
  const startLine = firstLine.number;
  const endLine = state.doc.lineAt(Math.min(node.to, state.doc.length)).number;

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
        }).range(firstLine.from, firstLine.from + prefixMatch[0].length),
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

  // Tone styling on every line of the callout. Header line is a separate
  // class so it can carry top rounded corners.
  for (let n = startLine; n <= endLine; n++) {
    const line = state.doc.line(n);
    const isFirst = n === startLine;
    const isLast = n === endLine;
    const classes = [
      isFirst ? "cm-callout-header-line" : "cm-callout-body",
      `cm-callout-tone-${tone}`,
      isLast ? "cm-callout-body--last" : "",
    ].filter(Boolean).join(" ");
    decos.push(Decoration.line({ class: classes }).range(line.from));
  }

  // Cursor inside - leave the source raw so the user can edit. Don't replace
  // the prefix with the icon widget.
  if (cursorIn) return "open";

  // Replace just "> [!type][+-]? " with an icon. Title text remains as real
  // markdown text so click coordinates land on the exact character.
  const prefixMatch = firstSrc.match(HEADER_PREFIX_RE);
  if (prefixMatch) {
    const prefixEnd = firstLine.from + prefixMatch[0].length;
    if (prefixEnd > firstLine.from) {
      decos.push(
        Decoration.replace({
          widget: new CalloutIconWidget({
            type: parsed.type,
            showLabel: parsed.title.length === 0,
            foldable,
            collapsed: false,
          }),
        }).range(firstLine.from, prefixEnd),
      );
    }
  }

  // Hide the leading "> " on each body line so the rendered callout shows
  // clean prose without blockquote markers.
  for (let n = startLine + 1; n <= endLine; n++) {
    const line = state.doc.line(n);
    const lineSrc = state.doc.sliceString(line.from, line.to);
    const m = lineSrc.match(/^>\s?/);
    if (m && m[0].length > 0) {
      decos.push(
        Decoration.replace({}).range(line.from, line.from + m[0].length),
      );
    }
  }

  return "open";
}
