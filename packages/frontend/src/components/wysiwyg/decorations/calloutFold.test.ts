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
