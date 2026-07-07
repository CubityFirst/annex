import type { EditorState, Line } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";

export interface MarkRange {
  from: number;
  to: number;
}

/** Iterate every doc line the node's range spans. */
export function eachLine(
  state: EditorState,
  range: { from: number; to: number },
  fn: (line: Line) => void,
): void {
  const start = state.doc.lineAt(range.from).number;
  const end = state.doc.lineAt(range.to).number;
  for (let n = start; n <= end; n++) fn(state.doc.line(n));
}

/**
 * `eachLine`, but skips lines that overlap a DIRECT child of `node` whose name
 * is in `skipNames`. Nested block visitors own their lines (the walker visits
 * them separately), so ancestors skipping them prevents O(depth x lines)
 * duplicate line decorations and semantically-wrong stacked classes.
 */
export function eachDirectLine(
  state: EditorState,
  node: SyntaxNode,
  skipNames: readonly string[],
  fn: (line: Line) => void,
): void {
  const skips: MarkRange[] = [];
  for (let c = node.firstChild; c; c = c.nextSibling) {
    if (skipNames.includes(c.name)) skips.push({ from: c.from, to: c.to });
  }
  eachLine(state, node, (line) => {
    for (const s of skips) {
      if (line.from < s.to && line.to > s.from) return;
    }
    fn(line);
  });
}

/** Depth-first visit of every descendant of `node` (children, grandchildren, ...). */
export function forEachDescendant(node: SyntaxNode, fn: (n: SyntaxNode) => void): void {
  for (let c = node.firstChild; c; c = c.nextSibling) {
    fn(c);
    forEachDescendant(c, fn);
  }
}

/**
 * First and last direct children named `name` - the shared "find the edge
 * marks" scan used by emphasis / inline code / dice. Returns null when the
 * node has no such child (partial markup).
 */
export function findEdgeMarks(
  node: SyntaxNode,
  name: string,
): { first: MarkRange; last: MarkRange } | null {
  let first: MarkRange | null = null;
  let last: MarkRange | null = null;
  for (let c = node.firstChild; c; c = c.nextSibling) {
    if (c.name === name) {
      if (!first) first = { from: c.from, to: c.to };
      last = { from: c.from, to: c.to };
    }
  }
  return first && last ? { first, last } : null;
}
