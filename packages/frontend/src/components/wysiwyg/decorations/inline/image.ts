import { Decoration } from "@codemirror/view";
import { cursorTouches, type Visitor } from "../types";
import { ImageWidget } from "../../widgets/ImageWidget";
import { AudioWidget } from "../../widgets/AudioWidget";
import { ATTR_BLOCK_RE, PARTIAL_ATTR_BLOCK_RE, parseImageAttrs, styleFromAttrs } from "@/lib/imageAttrs";
import { looksLikeAudio, parseAudioSize } from "@/lib/audioUrl";

const IMG_RE = /^!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)$/;

export const visitImage: Visitor = ({ node, state, sel, reveal, decos }) => {
  const fullSrc = state.doc.sliceString(node.from, node.to);
  const m = fullSrc.match(IMG_RE);
  if (!m) return;
  const alt = m[1] ?? "";
  const url = m[2] ?? "";

  // Peek at any trailing {…} attribute block - both complete and unfinished.
  // We consume the whole block (including unrecognized or partially-typed
  // attrs) so the source-mode reveal covers it; otherwise the rendered image
  // and the trailing `{thing}` text would show side-by-side.
  const lookahead = state.doc.sliceString(node.to, Math.min(node.to + 200, state.doc.length));
  let attrs: Record<string, string> = {};
  let consumeTo = node.to;
  const completeMatch = lookahead.match(ATTR_BLOCK_RE);
  if (completeMatch) {
    attrs = parseImageAttrs(completeMatch[1]!);
    consumeTo = node.to + completeMatch[0].length;
  } else {
    const partialMatch = lookahead.match(PARTIAL_ATTR_BLOCK_RE);
    if (partialMatch) consumeTo = node.to + partialMatch[0].length;
  }

  // Block layout when the image (with optional attrs) is the only non-whitespace
  // content on its line - replace the whole line with a block widget.
  const line = state.doc.lineAt(node.from);
  const before = state.doc.sliceString(line.from, node.from);
  const after = state.doc.sliceString(consumeTo, line.to);
  const inline = before.trim().length > 0 || after.trim().length > 0;

  // align needs `display: block` to take effect, which breaks the layout of an
  // inline span widget - most visibly inside a revealed table row, where every
  // image is forced inline by the surrounding `| … |`. Rendered table cells
  // hit a separate code path in TableWidget and keep their alignment.
  if (inline) delete attrs.align;
  const style = styleFromAttrs(attrs);

  // Reveal scope: for inline images, only the image+attrs range itself; for
  // block images, the whole line (since the line IS the image).
  const revealFrom = inline ? node.from : line.from;
  const revealTo = inline ? consumeTo : line.to;
  const cursorOn = reveal && cursorTouches(sel, revealFrom, revealTo);
  if (cursorOn) return;

  if (looksLikeAudio(url, alt)) {
    // Inline placement forces the compact variant - the full player needs a
    // row to itself. Stand-alone lines honor the author's choice (default full).
    const size = inline ? "small" : parseAudioSize(attrs.size);
    if (inline) {
      decos.push(
        Decoration.replace({
          widget: new AudioWidget({ src: url, alt, size, style, inline: true }),
        }).range(node.from, consumeTo),
      );
    } else {
      decos.push(
        Decoration.replace({
          widget: new AudioWidget({ src: url, alt, size, style, inline: false }),
          block: true,
        }).range(line.from, line.to),
      );
    }
    return;
  }

  if (inline) {
    decos.push(
      Decoration.replace({
        widget: new ImageWidget({ src: url, alt, style, inline: true }),
      }).range(node.from, consumeTo),
    );
  } else {
    decos.push(
      Decoration.replace({
        widget: new ImageWidget({ src: url, alt, style, inline: false }),
        block: true,
      }).range(line.from, line.to),
    );
  }
};
