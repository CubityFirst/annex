import { StateEffect, StateField, type EditorState } from "@codemirror/state";

// Position tracking for deferred edits (C1 / C2).
//
// Ranges captured "now" but consumed later - an async image upload, or a
// link/image/compare dialog held open while the user (or a remote collab peer)
// keeps editing - must be remapped through every document change in between,
// otherwise the eventual splice lands at stale offsets and replaces arbitrary
// text. This field owns that mapping: every transaction (local typing, remote
// Yjs ops - both arrive as CodeMirror transactions) maps the stored ranges
// through `tr.changes`.
//
// Association rules: `from` maps with assoc 1 and `to` with assoc -1, so text
// inserted exactly at either boundary stays OUTSIDE the tracked range - a
// remote peer typing at the edge of a pending dialog selection doesn't get
// their text swallowed by the eventual replacement.

export interface TrackedRange {
  id: number;
  from: number;
  to: number;
}

let nextId = 1;
export function newTrackedRangeId(): number {
  return nextId++;
}

/** Add a range (positions in the transaction's NEW document coordinates). */
export const addTrackedRange = StateEffect.define<TrackedRange>();
/** Remove a range by id. */
export const clearTrackedRange = StateEffect.define<number>();

export const trackedRangesField = StateField.define<readonly TrackedRange[]>({
  create: () => [],
  update(ranges, tr) {
    let next: readonly TrackedRange[] = ranges;
    if (tr.docChanged && next.length > 0) {
      next = next.map((r) => {
        const from = tr.changes.mapPos(r.from, 1);
        const to = Math.max(from, tr.changes.mapPos(r.to, -1));
        return { id: r.id, from, to };
      });
    }
    for (const e of tr.effects) {
      if (e.is(addTrackedRange)) next = [...next, e.value];
      else if (e.is(clearTrackedRange)) next = next.filter((r) => r.id !== e.value);
    }
    return next;
  },
});

export function getTrackedRange(state: EditorState, id: number): TrackedRange | null {
  return state.field(trackedRangesField, false)?.find((r) => r.id === id) ?? null;
}
