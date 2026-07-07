import { StateEffect, StateField, type EditorState, type Text } from "@codemirror/state";

// Per-callout collapse state for foldable callouts (`> [!type]+` / `> [!type]-`).
//
// Folding is a *view* concern, not a document edit - clicking the chevron must
// not rewrite the markdown source. We keep the user's explicit open/closed
// choices in this field, keyed by the callout header line's start position. The
// `+`/`-` marker only supplies the *default* when the user hasn't toggled.

export const toggleCalloutFold = StateEffect.define<{ from: number; collapsed: boolean }>();

// Loose shape-check for "the mapped position still points at a callout
// header": a line start whose line begins with (indented, possibly nested)
// `>` markers followed by `[!type]`. Entries whose position no longer looks
// like a header are pruned - deleted callouts must not accumulate in the map
// for the life of the session, and a heavily-edited doc must not leave stale
// keys squatting on unrelated positions.
function looksLikeCalloutHeader(doc: Text, pos: number): boolean {
  if (pos < 0 || pos > doc.length) return false;
  const line = doc.lineAt(pos);
  if (line.from !== pos) return false;
  return /^[ \t]*(?:>[ \t]*)+\[![a-zA-Z]+\]/.test(line.text);
}

export const calloutFoldField = StateField.define<Map<number, boolean>>({
  create() {
    return new Map();
  },
  update(value, tr) {
    let next = value;
    if (tr.docChanged) {
      // Reading mode is read-only, but the doc can still be replaced wholesale
      // by the external-value sync. Remap header positions so toggles survive;
      // prune entries whose mapped position no longer starts a callout header
      // (the callout was deleted or the edit tore the header apart). If two
      // headers collapse onto one position, the first mapped entry wins.
      next = new Map();
      for (const [pos, collapsed] of value) {
        const mapped = tr.changes.mapPos(pos, 1);
        if (next.has(mapped)) continue;
        if (!looksLikeCalloutHeader(tr.newDoc, mapped)) continue;
        next.set(mapped, collapsed);
      }
    }
    for (const e of tr.effects) {
      if (e.is(toggleCalloutFold)) {
        if (next === value) next = new Map(value);
        next.set(e.value.from, e.value.collapsed);
      }
    }
    return next;
  },
});

/**
 * Effective collapsed state for a callout. Falls back to the `-` marker default
 * when the user hasn't explicitly toggled this callout.
 */
export function isCalloutCollapsed(
  state: EditorState,
  headerFrom: number,
  fold: "" | "+" | "-",
): boolean {
  if (fold !== "+" && fold !== "-") return false;
  const explicit = state.field(calloutFoldField, false)?.get(headerFrom);
  if (explicit !== undefined) return explicit;
  return fold === "-";
}
