import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { calloutFoldField, toggleCalloutFold, isCalloutCollapsed } from "./calloutFold";

function stateWith(doc: string): EditorState {
  return EditorState.create({ doc, extensions: [calloutFoldField] });
}

describe("isCalloutCollapsed - marker defaults", () => {
  it("non-foldable callouts are never collapsed", () => {
    const s = stateWith("> [!tip] Hi");
    expect(isCalloutCollapsed(s, 0, "")).toBe(false);
  });

  it("`+` defaults to expanded", () => {
    const s = stateWith("> [!tip]+ Hi");
    expect(isCalloutCollapsed(s, 0, "+")).toBe(false);
  });

  it("`-` defaults to collapsed", () => {
    const s = stateWith("> [!warning]- Hi");
    expect(isCalloutCollapsed(s, 0, "-")).toBe(true);
  });
});

describe("toggleCalloutFold - explicit user choice overrides the marker", () => {
  it("collapsing a `+` callout", () => {
    let s = stateWith("> [!tip]+ Hi");
    s = s.update({ effects: toggleCalloutFold.of({ from: 0, collapsed: true }) }).state;
    expect(isCalloutCollapsed(s, 0, "+")).toBe(true);
  });

  it("expanding a `-` callout", () => {
    let s = stateWith("> [!warning]- Hi");
    s = s.update({ effects: toggleCalloutFold.of({ from: 0, collapsed: false }) }).state;
    expect(isCalloutCollapsed(s, 0, "-")).toBe(false);
  });

  it("only the toggled callout is affected", () => {
    let s = stateWith("> [!tip]+ A\n\n> [!tip]+ B");
    const second = s.doc.line(3).from;
    s = s.update({ effects: toggleCalloutFold.of({ from: second, collapsed: true }) }).state;
    expect(isCalloutCollapsed(s, 0, "+")).toBe(false);
    expect(isCalloutCollapsed(s, second, "+")).toBe(true);
  });
});

describe("calloutFoldField - position remap through doc changes", () => {
  it("a user toggle survives an edit above the callout", () => {
    let s = stateWith("intro\n\n> [!tip]+ Hi");
    const header = s.doc.line(3).from;
    s = s.update({ effects: toggleCalloutFold.of({ from: header, collapsed: true }) }).state;

    // Insert text at the very top - the header shifts right.
    const tr = s.update({ changes: { from: 0, insert: "PREPENDED\n" } });
    s = tr.state;
    const newHeader = tr.changes.mapPos(header, 1);

    expect(newHeader).not.toBe(header);
    expect(isCalloutCollapsed(s, newHeader, "+")).toBe(true);
  });
});

describe("calloutFoldField - pruning (D16)", () => {
  it("deleting a callout drops its fold entry instead of leaving it squatting", () => {
    let s = stateWith("> [!tip]+ A\n\ntail");
    s = s.update({ effects: toggleCalloutFold.of({ from: 0, collapsed: true }) }).state;
    expect(s.field(calloutFoldField).size).toBe(1);

    // Delete the whole callout line - the map must not keep a stale entry
    // keyed at whatever position 0 maps to.
    s = s.update({ changes: { from: 0, to: s.doc.line(2).from, insert: "" } }).state;
    expect(s.field(calloutFoldField).size).toBe(0);
  });

  it("an edit that tears the header apart prunes the entry", () => {
    let s = stateWith("> [!tip]+ Hi\nrest");
    s = s.update({ effects: toggleCalloutFold.of({ from: 0, collapsed: true }) }).state;

    // Replace "[!tip]+" so the line is no longer a callout header.
    s = s.update({ changes: { from: 2, to: 9, insert: "plain" } }).state;
    expect(s.field(calloutFoldField).size).toBe(0);
  });

  it("entries for surviving callouts are kept through unrelated edits", () => {
    let s = stateWith("intro\n\n> [!tip]+ Hi");
    const header = s.doc.line(3).from;
    s = s.update({ effects: toggleCalloutFold.of({ from: header, collapsed: true }) }).state;
    s = s.update({ changes: { from: 0, insert: "x" } }).state;
    expect(s.field(calloutFoldField).size).toBe(1);
  });

  it("two entries mapped onto one position collapse to a single entry", () => {
    let s = stateWith("> [!tip]+ A\n\n> [!note]+ B");
    const second = s.doc.line(3).from;
    s = s.update({
      effects: [
        toggleCalloutFold.of({ from: 0, collapsed: true }),
        toggleCalloutFold.of({ from: second, collapsed: false }),
      ],
    }).state;
    expect(s.field(calloutFoldField).size).toBe(2);

    // Delete everything before the second callout so both keys land on 0.
    s = s.update({ changes: { from: 0, to: second, insert: "" } }).state;
    const map = s.field(calloutFoldField);
    expect(map.size).toBe(1);
    expect(map.has(0)).toBe(true);
  });
});
