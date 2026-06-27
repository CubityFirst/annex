import { StateEffect, StateField, type EditorState } from "@codemirror/state";

// Per-callout collapse state for foldable callouts (`> [!type]+` / `> [!type]-`).
//
// Folding is a *view* concern, not a document edit - clicking the chevron must
// not rewrite the markdown source. We keep the user's explicit open/closed
// choices in this field, keyed by the callout header line's start position. The
// `+`/`-` marker only supplies the *default* when the user hasn't toggled.

export const toggleCalloutFold = StateEffect.define<{ from: number; collapsed: boolean }>();

export const calloutFoldField = StateField.define<Map<number, boolean>>({
  create() {
    return new Map();
  },
  update(value, tr) {
    let next = value;
    if (tr.docChanged) {
      // Reading mode is read-only, but the doc can still be replaced wholesale
      // by the external-value sync. Remap header positions so toggles survive.
      next = new Map();
      for (const [pos, collapsed] of value) {
        next.set(tr.changes.mapPos(pos, 1), collapsed);
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
