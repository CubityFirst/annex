import { syntaxTree } from "@codemirror/language";
import { Decoration, type DecorationSet } from "@codemirror/view";
import type { EditorState } from "@codemirror/state";
import { createBuildPass, type DecoRange } from "./types";
import { rendererCtxFacet } from "../context/RendererContext";
import { visitHeading } from "./block/heading";
import { visitStrong, visitEmphasis, visitStrike } from "./inline/emphasis";
import { visitInlineCode } from "./inline/inlineCode";
import { visitHr } from "./block/hr";
import { visitBlockquote } from "./block/blockquote";
import { visitCodeFence } from "./block/codeFence";
import { visitTable } from "./block/table";
import { visitListItem } from "./block/list";
import { visitLink, visitUrl, visitAutolink } from "./inline/link";
import { visitImage } from "./inline/image";
import { visitEscape } from "./inline/escape";
import { visitWikilink } from "./inline/wikilink";
import { visitComment } from "./inline/comment";
import { frontmatterPass } from "./block/frontmatter";

export function buildDecorations(state: EditorState): DecorationSet {
  try {
    return buildDecorationsInner(state);
  } catch (err) {
    // Surface the error so a visitor regression doesn't silently render a
    // blank editor; degrade to an empty decoration set so the doc text is
    // still typeable while we fix the bug.
    console.error("[wysiwyg] decoration build failed", err);
    return Decoration.none;
  }
}

function buildDecorationsInner(state: EditorState): DecorationSet {
  const ctx = state.facet(rendererCtxFacet);
  const reveal = ctx.revealOnCursor !== false;
  const sel = state.selection.main;
  const decos: DecoRange[] = [];
  const pass = createBuildPass();

  const fmRange = frontmatterPass(state, sel, reveal, ctx, decos);

  syntaxTree(state).iterate({
    enter: (node) => {
      // Skip any node STARTING inside the frontmatter range - the frontmatter
      // pass owns that region and Lezer would otherwise see the `---` lines
      // as HorizontalRule nodes. Checking only the start (not `node.to <=
      // fmRange.to`) also catches malformed nodes that begin inside the YAML
      // but extend past it (e.g. an unclosed fence): letting those through
      // would stack a second block replace partially overlapping the
      // frontmatter's own, which CM renders unpredictably. The tree ROOT also
      // starts at 0 when frontmatter opens the doc - it must stay exempt or
      // this check prunes the entire document and everything below the
      // frontmatter renders as raw markdown.
      if (fmRange && node.from >= fmRange.from && node.from < fmRange.to && !node.type.isTop) {
        return false;
      }
      const args = { node, state, sel, reveal, ctx, decos, pass };
      switch (node.name) {
        case "ATXHeading1":
        case "ATXHeading2":
        case "ATXHeading3":
        case "ATXHeading4":
        case "ATXHeading5":
        case "ATXHeading6":
          visitHeading(args);
          return;
        case "StrongEmphasis":
          visitStrong(args);
          return;
        case "Emphasis":
          visitEmphasis(args);
          return;
        case "Strikethrough":
          visitStrike(args);
          return;
        case "InlineCode":
          visitInlineCode(args);
          return;
        case "FencedCode":
          visitCodeFence(args);
          return false;
        case "Table":
          // Descends only when the cursor is inside (raw lines) - a rendered
          // TableWidget replaces the whole block, so building inline
          // decorations underneath it is dead work.
          return visitTable(args);
        case "Image":
          // Same: descend only while revealed as raw source.
          return visitImage(args);
        case "URL":
          // Bare GFM autolinks (`https://…` / `www.…` in plain text).
          return visitUrl(args);
        case "Autolink":
          // Angle-bracketed autolinks (`<https://…>`).
          return visitAutolink(args);
        case "Escape":
          visitEscape(args);
          return;
        case "Wikilink":
          visitWikilink(args);
          return false;
        case "MdComment":
          visitComment(args);
          return false;
        case "Link":
          return visitLink(args);
        case "HorizontalRule":
          visitHr(args);
          return;
        case "Blockquote":
          return visitBlockquote(args);
        case "ListItem":
          visitListItem(args);
          return; // descend so inline marks inside list items still apply
      }
    },
  });

  return Decoration.set(decos, true);
}
