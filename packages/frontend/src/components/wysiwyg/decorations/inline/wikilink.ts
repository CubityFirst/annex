import { Decoration } from "@codemirror/view";
import { cursorTouches, type Visitor } from "../types";
import { parseWikilink, WikilinkWidget } from "../../widgets/WikilinkWidget";
import { LinkWidget } from "../../widgets/LinkWidget";

export const visitWikilink: Visitor = ({ node, state, sel, reveal, ctx, decos }) => {
  const cursorOn = reveal && cursorTouches(sel, node.from, node.to);
  if (cursorOn) {
    decos.push(Decoration.mark({ class: "cm-wikilink-source" }).range(node.from, node.to));
    return;
  }

  // Strip the surrounding [[ ]] - they're WikilinkMark children but for parsing
  // we just slice 2 chars off each side.
  const inner = state.doc.sliceString(node.from + 2, node.to - 2);

  // `[[#anchor]]` - a same-doc heading link. parseWikilink requires a title,
  // so handle it here: link to the current doc's own anchor.
  if (inner.startsWith("#")) {
    const anchor = inner.slice(1).trim();
    if (anchor && ctx.buildUrl && ctx.currentDocId) {
      const href = ctx.buildUrl(ctx.currentDocId, anchor);
      decos.push(
        Decoration.replace({ widget: new LinkWidget({ text: inner, href }) }).range(node.from, node.to),
      );
      return;
    }
    decos.push(Decoration.mark({ class: "cm-wikilink-source" }).range(node.from, node.to));
    return;
  }

  const parsed = parseWikilink(inner);
  if (!parsed) {
    decos.push(Decoration.mark({ class: "cm-wikilink-source" }).range(node.from, node.to));
    return;
  }

  decos.push(
    Decoration.replace({ widget: new WikilinkWidget(parsed) }).range(node.from, node.to),
  );
};
