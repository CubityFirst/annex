import { describe, it, expect } from "vitest";
import { EditorState, EditorSelection } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { decorationField } from "./index";
import { rendererCtxFacet } from "../context/RendererContext";

const DOC = "# Heading\n\nsome **bold** text\n\n- [x] task";

function mkState(revealOnCursor: boolean): EditorState {
  const state = EditorState.create({
    doc: DOC,
    selection: EditorSelection.cursor(0),
    extensions: [
      markdown({ base: markdownLanguage }),
      rendererCtxFacet.of({ isPublic: false, revealOnCursor }),
      decorationField,
    ],
  });
  ensureSyntaxTree(state, DOC.length, 5000);
  return state;
}

describe("decorationField - selection-only transactions (D2)", () => {
  it("reading mode (reveal off): selection-only tx does NOT rebuild (same set identity)", () => {
    const state = mkState(false);
    const before = state.field(decorationField);
    expect(before.size).toBeGreaterThan(0);
    const tr = state.update({ selection: EditorSelection.cursor(5) });
    expect(tr.state.field(decorationField)).toBe(before);
  });

  it("editing mode (reveal on): selection-only tx DOES rebuild", () => {
    const state = mkState(true);
    const before = state.field(decorationField);
    expect(before.size).toBeGreaterThan(0);
    const tr = state.update({ selection: EditorSelection.cursor(5) });
    expect(tr.state.field(decorationField)).not.toBe(before);
  });

  it("reading mode: a doc change still rebuilds", () => {
    const state = mkState(false);
    const before = state.field(decorationField);
    const tr = state.update({ changes: { from: DOC.length, insert: "\n\nmore" } });
    expect(tr.state.field(decorationField)).not.toBe(before);
  });
});
