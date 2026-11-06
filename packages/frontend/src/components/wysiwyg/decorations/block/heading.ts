import { Decoration } from "@codemirror/view";
import { cursorTouches, type Visitor } from "../types";
import { toHeadingId } from "@/lib/headingSlug";
import { findEdgeMarks } from "../helpers";
import { HeadingAnchorWidget } from "../../widgets/HeadingAnchorWidget";

export const visitHeading: Visitor = ({ node, state, sel, reveal, decos, pass }) => {
  const atxMatch = node.name.match(/^ATXHeading(\d)$/);
  if (!atxMatch) return; // Setext deferred
  const level = Math.min(parseInt(atxMatch[1]!, 10), 6);

  const line = state.doc.lineAt(node.from);

  // Heading text sits between the leading HeaderMark and the optional ATX
  // closing sequence (`# Title #`). Deriving it from the tree (not a
  // line-anchored regex) means indented headings get slugs too.
  const marks = findEdgeMarks(node.node, "HeaderMark");
  const hasClosing = marks !== null && marks.last.from > marks.first.from;
  const textFrom = marks ? marks.first.to : node.from;
  const textTo = hasClosing ? marks!.last.from : node.to;
  const rawText = textTo > textFrom ? state.doc.sliceString(textFrom, textTo).trim() : "";
  let slug = rawText ? toHeadingId(rawText) : "";

  // Duplicate heading texts get `-1`, `-2`, … suffixes so DOM ids stay unique
  // (first occurrence keeps the bare slug, matching findHeadingLine's
  // first-match anchor resolution).
  if (slug) {
    const seen = pass.headingSlugs.get(slug) ?? 0;
    pass.headingSlugs.set(slug, seen + 1);
    if (seen > 0) slug = `${slug}-${seen}`;
  }

  const spec: { class: string; attributes?: { id: string } } = { class: `cm-h${level}` };
  if (slug) spec.attributes = { id: slug };
  decos.push(Decoration.line(spec).range(line.from));

  // The conventional blank line after a heading would otherwise add a full
  // line of space under it (and none when the author omits it), so headings
  // sat at different distances from their content. Shrink that blank line
  // so the heading-to-body gap is consistent either way.
  if (line.number < state.doc.lines) {
    const next = state.doc.line(line.number + 1);
    if (next.text.trim() === "") {
      decos.push(Decoration.line({ class: "cm-heading-gap" }).range(next.from));
    }
  }

  const cursorOnLine = reveal && cursorTouches(sel, line.from, line.to);
  if (cursorOnLine) {
    // Revealed for editing: keep the `#` markup visible but muted, so it reads
    // as syntax rather than as part of the heading text.
    for (let cur = node.node.firstChild; cur; cur = cur.nextSibling) {
      if (cur.name === "HeaderMark" && cur.to > cur.from) {
        decos.push(Decoration.mark({ class: "cm-md-syntax" }).range(cur.from, cur.to));
      }
    }
    return;
  }

  // In reading mode, append a click-to-copy heading-link icon at the end of
  // the line. Hidden by default; CSS reveals it on line hover.
  if (!reveal && slug) {
    decos.push(
      Decoration.widget({ widget: new HeadingAnchorWidget(slug), side: 1 }).range(line.to),
    );
  }

  // Hide EVERY HeaderMark: the leading `#…` (plus one following space/tab)
  // and the optional ATX closing sequence (plus the whitespace before it).
  for (let cur = node.node.firstChild; cur; cur = cur.nextSibling) {
    if (cur.name !== "HeaderMark") continue;
    let hideFrom = cur.from;
    if (cur.from > textFrom) {
      // Closing mark - swallow the run of spaces/tabs separating it from the
      // heading text so no stray gap renders at the end of the line.
      while (hideFrom > line.from && /[ \t]/.test(state.doc.sliceString(hideFrom - 1, hideFrom))) {
        hideFrom--;
      }
    }
    const after = state.doc.sliceString(cur.to, cur.to + 1);
    const hideTo = after === " " || after === "\t" ? cur.to + 1 : cur.to;
    if (hideTo > hideFrom) decos.push(Decoration.replace({}).range(hideFrom, hideTo));
  }
};
