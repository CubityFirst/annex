import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import {
  trackedRangesField,
  addTrackedRange,
  clearTrackedRange,
  getTrackedRange,
  newTrackedRangeId,
} from "./trackedRanges";

// C1/C2 position mapping: ranges captured when an async operation (image
// upload, dialog) starts must follow the text they refer to through any edits
// that land before the operation completes.

function makeState(doc: string): EditorState {
  return EditorState.create({ doc, extensions: [trackedRangesField] });
}

function withRange(doc: string, from: number, to: number): { state: EditorState; id: number } {
  const id = newTrackedRangeId();
  const state = makeState(doc).update({ effects: addTrackedRange.of({ id, from, to }) }).state;
  return { state, id };
}

describe("trackedRangesField", () => {
  it("stores and retrieves a range", () => {
    const { state, id } = withRange("hello world", 6, 11);
    expect(getTrackedRange(state, id)).toEqual({ id, from: 6, to: 11 });
  });

  it("returns null for an unknown id", () => {
    const { state } = withRange("hello", 0, 5);
    expect(getTrackedRange(state, 999_999)).toBeNull();
  });

  it("returns null when the field is not installed", () => {
    const bare = EditorState.create({ doc: "x" });
    expect(getTrackedRange(bare, 1)).toBeNull();
  });

  it("maps the range through an insertion before it", () => {
    const { state, id } = withRange("hello world", 6, 11);
    const next = state.update({ changes: { from: 0, insert: ">> " } }).state;
    expect(getTrackedRange(next, id)).toEqual({ id, from: 9, to: 14 });
  });

  it("maps through a deletion before it", () => {
    const { state, id } = withRange("hello world", 6, 11);
    const next = state.update({ changes: { from: 0, to: 3 } }).state;
    expect(getTrackedRange(next, id)).toEqual({ id, from: 3, to: 8 });
  });

  it("keeps text inserted exactly at the START outside the range", () => {
    const { state, id } = withRange("ab", 1, 2);
    const next = state.update({ changes: { from: 1, insert: "XX" } }).state;
    // `from` maps with assoc 1: the inserted text is not swallowed.
    expect(getTrackedRange(next, id)).toEqual({ id, from: 3, to: 4 });
  });

  it("keeps text inserted exactly at the END outside the range", () => {
    const { state, id } = withRange("ab", 0, 1);
    const next = state.update({ changes: { from: 1, insert: "XX" } }).state;
    // `to` maps with assoc -1: the range does not grow over the insertion.
    expect(getTrackedRange(next, id)).toEqual({ id, from: 0, to: 1 });
  });

  it("grows with text typed strictly inside the range", () => {
    const { state, id } = withRange("hello", 1, 4);
    const next = state.update({ changes: { from: 2, insert: "XY" } }).state;
    expect(getTrackedRange(next, id)).toEqual({ id, from: 1, to: 6 });
  });

  it("collapses (never inverts) when a deletion spans the whole range", () => {
    const { state, id } = withRange("hello world", 3, 7);
    const next = state.update({ changes: { from: 2, to: 9 } }).state;
    const r = getTrackedRange(next, id)!;
    expect(r.from).toBe(2);
    expect(r.to).toBeGreaterThanOrEqual(r.from);
    expect(r.to).toBe(2);
  });

  it("clearTrackedRange removes only the given id", () => {
    const idA = newTrackedRangeId();
    const idB = newTrackedRangeId();
    let state = makeState("hello");
    state = state.update({
      effects: [addTrackedRange.of({ id: idA, from: 0, to: 2 }), addTrackedRange.of({ id: idB, from: 3, to: 5 })],
    }).state;
    state = state.update({ effects: clearTrackedRange.of(idA) }).state;
    expect(getTrackedRange(state, idA)).toBeNull();
    expect(getTrackedRange(state, idB)).toEqual({ id: idB, from: 3, to: 5 });
  });

  it("maps ranges and applies effects in the same transaction consistently", () => {
    // A change and an addTrackedRange in one transaction: the new range's
    // positions are in NEW-document coordinates and must not be re-mapped.
    const id = newTrackedRangeId();
    const state = makeState("abc").update({
      changes: { from: 0, insert: "12" },
      effects: addTrackedRange.of({ id, from: 0, to: 2 }),
    }).state;
    expect(getTrackedRange(state, id)).toEqual({ id, from: 0, to: 2 });
  });
});
