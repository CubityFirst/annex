import { syntaxTree } from "@codemirror/language";
import { Decoration, type DecorationSet } from "@codemirror/view";
import type { EditorState } from "@codemirror/state";
import type { DecoRange } from "./types";
import { rendererCtxFacet } from "../context/RendererContext";
import { visitHeading } from "./block/heading";
import { visitStrong, visitEmphasis, visitStrike } from "./inline/emphasis";
import { visitInlineCode } from "./inline/inlineCode";
import { visitHr } from "./block/hr";
import { visitBlockquote } from "./block/blockquote";
import { visitCodeFence } from "./block/codeFence";
import { visitTable } from "./block/table";
import { visitListItem } from "./block/list";
import { visitLink } from "./inline/link";
import { visitImage } from "./inline/image";
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

  const fmRange = frontmatterPass(state, sel, reveal, ctx, decos);

  syntaxTree(state).iterate({
    enter: (node) => {
      // Skip any node fully inside the frontmatter range - the frontmatter
      // pass owns that region and Lezer would otherwise see the `---` lines
      // as HorizontalRule nodes.
      if (fmRange && node.from >= fmRange.from && node.to <= fmRange.to) {
        return false;
      }
      const args = { node, state, sel, reveal, ctx, decos };
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
          visitTable(args);
          return; // descend so emphasis/links inside cells still apply
        case "Image":
          visitImage(args);
          return;
        case "Wikilink":
          visitWikilink(args);
          return false;
        case "MdComment":
          visitComment(args);
          return false;
        case "Link":
          visitLink(args);
          return false;
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
