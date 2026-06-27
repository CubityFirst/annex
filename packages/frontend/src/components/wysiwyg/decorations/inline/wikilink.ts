import { Decoration } from "@codemirror/view";
import { cursorTouches, type Visitor } from "../types";
import { parseWikilink, WikilinkWidget } from "../../widgets/WikilinkWidget";

export const visitWikilink: Visitor = ({ node, state, sel, reveal, decos }) => {
  const cursorOn = reveal && cursorTouches(sel, node.from, node.to);
  if (cursorOn) {
    decos.push(Decoration.mark({ class: "cm-wikilink-source" }).range(node.from, node.to));
    return;
  }

  // Strip the surrounding [[ ]] - they're WikilinkMark children but for parsing
  // we just slice 2 chars off each side.
  const inner = state.doc.sliceString(node.from + 2, node.to - 2);
  const parsed = parseWikilink(inner);
  if (!parsed) {
    decos.push(Decoration.mark({ class: "cm-wikilink-source" }).range(node.from, node.to));
    return;
  }

  decos.push(
    Decoration.replace({ widget: new WikilinkWidget(parsed) }).range(node.from, node.to),
  );
};
