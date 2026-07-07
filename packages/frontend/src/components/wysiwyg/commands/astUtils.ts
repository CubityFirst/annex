import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";

/**
 * Resolve the innermost syntax node at `pos` (biased to the left, matching
 * how the Enter commands look "behind" the cursor) and walk up to the nearest
 * enclosing node named `name`. Returns null when no such ancestor exists.
 */
export function findAncestor(state: EditorState, pos: number, name: string): SyntaxNode | null {
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1);
  while (node && node.name !== name) node = node.parent;
  return node;
}
