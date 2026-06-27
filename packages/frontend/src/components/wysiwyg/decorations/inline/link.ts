import { Decoration } from "@codemirror/view";
import { cursorTouches, type Visitor } from "../types";
import { LinkWidget } from "../../widgets/LinkWidget";

// Block `javascript:`, `data:`, `vbscript:`, etc. URL parsing is robust to
// percent-encoded scheme delimiters and case tricks; entity-encoded payloads
// have invalid scheme characters and parse as relative.
function sanitizeHref(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed, "https://placeholder.invalid/");
    const protocol = parsed.protocol.toLowerCase();
    if (
      protocol === "http:" ||
      protocol === "https:" ||
      protocol === "mailto:" ||
      protocol === "tel:"
    ) {
      return trimmed;
    }
    return null;
  } catch {
    return null;
  }
}

export const visitLink: Visitor = ({ node, state, sel, reveal, decos }) => {
  // Walk children to extract the text range and URL. Bail out if this isn't
  // a complete `[text](url)` - Lezer also marks `[text]` (without url) as a
  // Link node, and we don't want to underline plain bracketed text.
  const parent = node.node;
  let textFrom = -1;
  let textTo = -1;
  let url = "";
  let foundOpenBracket = false;
  let foundCloseBracket = false;
  let cur = parent.firstChild;
  while (cur) {
    if (cur.name === "LinkMark") {
      const ch = state.doc.sliceString(cur.from, cur.to);
      if (ch === "[" && !foundOpenBracket) {
        foundOpenBracket = true;
        textFrom = cur.to;
      } else if (ch === "]" && !foundCloseBracket) {
        foundCloseBracket = true;
        textTo = cur.from;
      }
    } else if (cur.name === "URL") {
      url = state.doc.sliceString(cur.from, cur.to);
    }
    cur = cur.nextSibling;
  }

  if (!url) return; // partial / shortcut reference - leave as plain text

  const cursorOn = reveal && cursorTouches(sel, node.from, node.to);
  if (cursorOn) {
    decos.push(Decoration.mark({ class: "cm-link-source" }).range(node.from, node.to));
    return;
  }

  const text = textFrom >= 0 && textTo > textFrom
    ? state.doc.sliceString(textFrom, textTo)
    : "";
  if (!text) return;

  const safeHref = sanitizeHref(url);
  if (safeHref === null) return; // unsafe scheme - leave raw markdown visible

  decos.push(
    Decoration.replace({ widget: new LinkWidget({ text, href: safeHref }) }).range(node.from, node.to),
  );
};
