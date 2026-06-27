// Shared callout parsing - used by both the ReactMarkdown remark plugin and the
// CodeMirror WYSIWYG renderer. Implements the Obsidian callout spec:
// https://help.obsidian.md/callouts

export const CANONICAL_TYPES = new Set([
  "note", "abstract", "info", "todo", "tip", "success",
  "question", "warning", "failure", "danger", "bug", "example", "quote",
]);

export const ALIASES: Record<string, string> = {
  summary: "abstract",
  tldr: "abstract",
  hint: "tip",
  important: "tip",
  check: "success",
  done: "success",
  help: "question",
  faq: "question",
  caution: "warning",
  attention: "warning",
  fail: "failure",
  missing: "failure",
  error: "danger",
  cite: "quote",
};

// Matches: [!type][-+]? optional title
export const CALLOUT_LINE_RE = /^\[!([a-zA-Z]+)\]([+\-]?)\s*(.*)/;

export function resolveCalloutType(raw: string): string | null {
  const lower = raw.toLowerCase();
  if (CANONICAL_TYPES.has(lower)) return lower;
  return ALIASES[lower] ?? null;
}

export interface ParsedCalloutHeader {
  type: string;
  fold: "" | "+" | "-";
  title: string;
}

export function parseCalloutHeader(line: string): ParsedCalloutHeader | null {
  const m = line.match(CALLOUT_LINE_RE);
  if (!m) return null;
  const type = resolveCalloutType(m[1]!);
  if (!type) return null;
  return { type, fold: (m[2] as "" | "+" | "-") ?? "", title: m[3]!.trim() };
}
