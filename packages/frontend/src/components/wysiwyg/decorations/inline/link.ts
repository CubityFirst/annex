import { Decoration } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { cursorTouches, type Visitor, type VisitorArgs } from "../types";
import type { MarkRange } from "../helpers";
import { LinkWidget } from "../../widgets/LinkWidget";

// Block `javascript:`, `data:`, `vbscript:`, etc. URL parsing is robust to
// percent-encoded scheme delimiters and case tricks; entity-encoded payloads
// have invalid scheme characters and parse as relative.
export function sanitizeHref(url: string): string | null {
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

// Collect the ranges of nested inline MARKUP inside a link's text so the
// rendered widget shows "bold link" instead of "**bold** link". Pragmatic
// subset: emphasis / strike / code marks are dropped, escapes lose their
// backslash, and a nested image contributes only its alt text. The remaining
// text renders unstyled inside the LinkWidget (styling nested constructs
// would need a richer widget) - but no literal markers leak through.
function collectMarkupStrips(parent: SyntaxNode, out: MarkRange[]): void {
  for (let c = parent.firstChild; c; c = c.nextSibling) {
    switch (c.name) {
      case "EmphasisMark":
      case "CodeMark":
      case "StrikethroughMark":
      case "LinkMark":
        out.push({ from: c.from, to: c.to });
        continue;
      case "Escape":
        out.push({ from: c.from, to: c.from + 1 });
        continue;
      case "Image": {
        // Keep only the alt text: strip everything before it ("![") and
        // everything after it ("](url)").
        let altFrom = -1;
        let altTo = -1;
        for (let m = c.firstChild; m; m = m.nextSibling) {
          if (m.name !== "LinkMark") continue;
          if (altFrom < 0) {
            altFrom = m.to; // end of "!["
          } else if (altTo < 0) {
            altTo = m.from; // start of "]"
          }
        }
        if (altFrom >= 0 && altTo >= altFrom) {
          out.push({ from: c.from, to: altFrom });
          out.push({ from: altTo, to: c.to });
        }
        continue;
      }
      default:
        collectMarkupStrips(c, out);
    }
  }
}

function stripRanges(state: VisitorArgs["state"], from: number, to: number, strips: MarkRange[]): string {
  const relevant = strips
    .filter((s) => s.from < to && s.to > from)
    .sort((a, b) => a.from - b.from);
  let text = "";
  let pos = from;
  for (const s of relevant) {
    if (s.from > pos) text += state.doc.sliceString(pos, s.from);
    pos = Math.max(pos, Math.min(s.to, to));
  }
  if (pos < to) text += state.doc.sliceString(pos, to);
  return text;
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

  if (!url) return false; // partial / shortcut reference - leave as plain text

  const cursorOn = reveal && cursorTouches(sel, node.from, node.to);
  if (cursorOn) {
    decos.push(Decoration.mark({ class: "cm-link-source" }).range(node.from, node.to));
    return false;
  }

  if (textFrom < 0 || textTo <= textFrom) return false;

  // Nested markup inside the link text ([**bold** link](url)) must not leak
  // literal markers into the widget - strip them from the display text.
  const strips: MarkRange[] = [];
  collectMarkupStrips(parent, strips);
  const text = stripRanges(state, textFrom, textTo, strips);
  if (!text) return false;

  const safeHref = sanitizeHref(url);
  if (safeHref === null) return false; // unsafe scheme - leave raw markdown visible

  decos.push(
    Decoration.replace({ widget: new LinkWidget({ text, href: safeHref }) }).range(node.from, node.to),
  );
  return false;
};

// GFM autolinks lack an explicit scheme for `www.…` and email forms - give
// them one so the anchor doesn't resolve as a relative in-app path.
function autolinkHref(url: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  if (url.includes("@")) return `mailto:${url}`;
  return `https://${url}`;
}

function renderBareUrl(args: VisitorArgs, from: number, to: number, url: string): void {
  const { decos } = args;
  const safeHref = sanitizeHref(autolinkHref(url));
  if (safeHref === null) return;
  decos.push(
    Decoration.replace({ widget: new LinkWidget({ text: url, href: safeHref }) }).range(from, to),
  );
}

// Bare autolinks: GFM emits a URL node directly in inline content for
// `https://…` / `www.…` text. URL nodes inside Link / Image / Autolink are
// owned by those visitors.
export const visitUrl: Visitor = (args) => {
  const { node, state, sel, reveal } = args;
  const parentName = node.node.parent?.name;
  if (parentName === "Link" || parentName === "Image" || parentName === "Autolink") return false;

  const cursorOn = reveal && cursorTouches(sel, node.from, node.to);
  if (cursorOn) {
    args.decos.push(Decoration.mark({ class: "cm-link-source" }).range(node.from, node.to));
    return false;
  }
  renderBareUrl(args, node.from, node.to, state.doc.sliceString(node.from, node.to));
  return false;
};

// Angle-bracketed autolinks (`<https://…>`, `<user@host>`): replace the whole
// node so the brackets disappear with the markup.
export const visitAutolink: Visitor = (args) => {
  const { node, state, sel, reveal } = args;
  const urlNode = node.node.getChild("URL");
  if (!urlNode) return false;

  const cursorOn = reveal && cursorTouches(sel, node.from, node.to);
  if (cursorOn) {
    args.decos.push(Decoration.mark({ class: "cm-link-source" }).range(node.from, node.to));
    return false;
  }
  renderBareUrl(args, node.from, node.to, state.doc.sliceString(urlNode.from, urlNode.to));
  return false;
};
