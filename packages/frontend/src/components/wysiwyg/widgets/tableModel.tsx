import { createElement, type ReactNode } from "react";
import { AuthenticatedImage } from "@/components/AuthenticatedImage";
import { useRendererCtx } from "../context/RendererContext";
import { parseImageAttrs, styleFromAttrs, parseInlineStyle } from "@/lib/imageAttrs";
import { sanitizeHref } from "../decorations/inline/link";

// Pure table-parsing + cell-rendering helpers for TableWidget, extracted to a
// module so they're unit-testable without an EditorView.

export type Align = "left" | "center" | "right" | null;

export interface ParsedTable {
  headers: string[];
  rows: string[][];
  aligns: Align[];
}

// Splits a GFM table row into cells. `\|` is an escaped pipe (literal `|`
// inside a cell), not a cell boundary - the backslash is consumed, matching
// how GFM renders it.
export function splitRow(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
  if (trimmed.endsWith("|") && !trimmed.endsWith("\\|")) trimmed = trimmed.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]!;
    if (ch === "\\" && trimmed[i + 1] === "|") {
      cur += "|";
      i++;
      continue;
    }
    if (ch === "|") {
      cells.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

function parseDelimiter(cell: string): Align {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  if (left && right) return "center";
  if (left) return "left";
  if (right) return "right";
  return null;
}

export function parseTable(source: string): ParsedTable {
  const lines = source.split("\n").filter(l => l.trim().length > 0);
  if (lines.length < 2) return { headers: [], rows: [], aligns: [] };
  const headers = splitRow(lines[0]!);
  const aligns = splitRow(lines[1]!).map(parseDelimiter);
  const rows = lines.slice(2).map(splitRow);
  return { headers, rows, aligns };
}

function TableImage({ src, alt, style }: { src: string; alt: string; style?: string }) {
  const ctx = useRendererCtx();
  return createElement(AuthenticatedImage, {
    src,
    alt,
    projectId: ctx.projectId,
    isPublic: ctx.isPublic,
    style: style ? parseInlineStyle(style) : undefined,
    className: "cm-wysiwyg-image cm-wysiwyg-image--inline",
  });
}

// Minimal inline-markdown renderer for table cells. Handles the common
// constructs: **bold**, *italic*, _italic_, __underline__, ~~strike~~,
// `code`, ![alt](src), [text](url). Does NOT recurse into nested formatting.
// Link and image URLs go through the same sanitizeHref gate as standalone
// links - an unsafe scheme (javascript:, data:, ...) renders as plain text.
export function renderInline(text: string): ReactNode {
  const out: ReactNode[] = [];
  let pending = "";
  let i = 0;
  let key = 0;

  const flush = () => {
    if (pending) {
      out.push(pending);
      pending = "";
    }
  };

  while (i < text.length) {
    const rest = text.slice(i);
    let m: RegExpMatchArray | null;

    if ((m = rest.match(/^\*\*([^*]+?)\*\*/))) {
      flush();
      out.push(createElement("strong", { key: key++ }, m[1]));
      i += m[0].length; continue;
    }
    if ((m = rest.match(/^__([^_]+?)__/))) {
      flush();
      out.push(createElement("u", { key: key++ }, m[1]));
      i += m[0].length; continue;
    }
    if ((m = rest.match(/^~~([^~]+?)~~/))) {
      flush();
      out.push(createElement("s", { key: key++ }, m[1]));
      i += m[0].length; continue;
    }
    if ((m = rest.match(/^\*([^*\s][^*]*?)\*/))) {
      flush();
      out.push(createElement("em", { key: key++ }, m[1]));
      i += m[0].length; continue;
    }
    if ((m = rest.match(/^_([^_\s][^_]*?)_/))) {
      flush();
      out.push(createElement("em", { key: key++ }, m[1]));
      i += m[0].length; continue;
    }
    if ((m = rest.match(/^`([^`]+?)`/))) {
      flush();
      out.push(createElement("code", { key: key++, className: "cm-inline-code" }, m[1]));
      i += m[0].length; continue;
    }
    if ((m = rest.match(/^!\[([^\]]*)\]\(\s*([^)\s]+?)\s*\)(?:\{([^}\n]*)\})?/))) {
      const alt = m[1] ?? "";
      const safeSrc = sanitizeHref(m[2] ?? "");
      if (safeSrc === null) {
        // Unsafe scheme - keep the raw markdown visible as plain text.
        pending += m[0];
        i += m[0].length; continue;
      }
      flush();
      const style = m[3] != null ? styleFromAttrs(parseImageAttrs(m[3])) : undefined;
      out.push(createElement(TableImage, { key: key++, src: safeSrc, alt, style }));
      i += m[0].length; continue;
    }
    if ((m = rest.match(/^\[([^\]]+?)\]\(([^)\s]+?)\)/))) {
      const safeHref = sanitizeHref(m[2] ?? "");
      if (safeHref === null) {
        // Unsafe scheme - keep the raw markdown visible as plain text.
        pending += m[0];
        i += m[0].length; continue;
      }
      flush();
      out.push(createElement(
        "a",
        { key: key++, href: safeHref, target: "_blank", rel: "noopener noreferrer", className: "cm-link" },
        m[1],
      ));
      i += m[0].length; continue;
    }

    pending += text[i];
    i++;
  }
  flush();
  return out;
}
