import { describe, it, expect, vi } from "vitest";
import { EditorState, type Transaction } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { markdown, markdownLanguage, insertNewlineContinueMarkupCommand } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { calloutContinueOnEnter, calloutBreakOnShiftEnter } from "./calloutEnter";

// T-M2 / T-L8: the callout Enter/Shift+Enter commands are retired. The
// built-in markdown continuation (bound at Prec.high in WysiwygEditor) owns
// blockquote/callout continuation and empty-line exit; the old custom
// implementation was shadowed in every normal case and corrupted the doc in
// the residual ones (col-0 Enter -> "> > body"; selections spanning past the
// callout end got quote-prefixed). These tests pin the retirement AND prove
// the built-in actually covers the cases the custom command claimed to.

function stateFor(doc: string, anchor: number, head = anchor): EditorState {
  const state = EditorState.create({
    doc,
    selection: { anchor, head },
    extensions: [markdown({ base: markdownLanguage })],
  });
  ensureSyntaxTree(state, doc.length, 5000);
  return state;
}

function fakeView(state: EditorState): { view: EditorView; dispatch: ReturnType<typeof vi.fn> } {
  const dispatch = vi.fn();
  return { view: { state, dispatch } as unknown as EditorView, dispatch };
}

// Run the Prec.high builtin the editor actually binds; returns the resulting
// doc when it claims the key, or null when it declines.
function runBuiltinEnter(state: EditorState): string | null {
  let result: string | null = null;
  const claimed = insertNewlineContinueMarkupCommand({ nonTightLists: false })({
    state,
    dispatch: (tr: Transaction) => { result = tr.state.doc.toString(); },
  });
  return claimed ? result : null;
}

const CALLOUT = "> [!tip] Title\n> body";

describe("retired callout Enter commands always decline", () => {
  it.each([
    ["caret at end of a body line", CALLOUT.length],
    ["caret at column 0 of a body line (old corruption case)", CALLOUT.indexOf("> body")],
    ["caret mid-body", CALLOUT.indexOf("body") + 2],
  ])("calloutContinueOnEnter returns false and never dispatches: %s", (_label, pos) => {
    const { view, dispatch } = fakeView(stateFor(CALLOUT, pos));
    expect(calloutContinueOnEnter(view)).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("declines a selection spanning past the callout end (old corruption case)", () => {
    const doc = "> [!tip] Title\n> body\n\nafter";
    const from = doc.indexOf("body") + 2;
    const to = doc.indexOf("after") + 2;
    const { view, dispatch } = fakeView(stateFor(doc, from, to));
    expect(calloutContinueOnEnter(view)).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("calloutBreakOnShiftEnter returns false and never dispatches (old mid-callout split case)", () => {
    const { view, dispatch } = fakeView(stateFor(CALLOUT, CALLOUT.indexOf("body") + 2));
    expect(calloutBreakOnShiftEnter(view)).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe("the built-in markup continuation covers callouts (why deletion is safe)", () => {
  it("claims Enter at the end of a callout body line and continues the quote", () => {
    const doc = runBuiltinEnter(stateFor(CALLOUT, CALLOUT.length));
    expect(doc).toBe("> [!tip] Title\n> body\n> ");
  });

  it("Enter at column 0 of a body line never produces a nested '> >' quote", () => {
    // The built-in declines with the caret before the marker, so the key
    // falls through to the default Enter (plain "\n") - either way the old
    // custom command's "> > body" corruption cannot happen.
    const doc = runBuiltinEnter(stateFor(CALLOUT, CALLOUT.indexOf("> body")));
    if (doc !== null) expect(doc).not.toContain("> >");
    else expect(CALLOUT.slice(0, CALLOUT.indexOf("> body")) + "\n" + CALLOUT.slice(CALLOUT.indexOf("> body"))).not.toContain("> >");
  });

  it("claims Enter on an empty callout line and exits the quote", () => {
    const withEmpty = "> [!tip] Title\n> body\n> ";
    const doc = runBuiltinEnter(stateFor(withEmpty, withEmpty.length));
    expect(doc).not.toBeNull();
    // the trailing empty "> " marker is removed rather than continued
    expect(doc).not.toContain("\n> \n> ");
  });
});
