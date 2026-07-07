import { describe, it, expect } from "vitest";
import { EditorState, type TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import {
  applyMarkerCm,
  applyLinePrefixCm,
  applyBlockquoteCm,
  applyHrCm,
  applyCodeFenceCm,
  insertTableCm,
  insertCalloutCm,
  applyHeadingCm,
  computeActiveFormats,
} from "./formatting";

// The formatting commands only touch `view.state` and `view.dispatch`, so a
// real DOM-backed EditorView isn't needed - a fake that applies dispatched
// specs to a held state (same trick as calloutEnter.test.ts) reproduces the
// exact transaction semantics.

interface Result {
  doc: string;
  anchor: number;
  head: number;
  selected: string;
}

function run(doc: string, anchor: number, head: number, cmd: (view: EditorView) => void): Result {
  let state = EditorState.create({
    doc,
    selection: { anchor, head },
    extensions: [markdown({ base: markdownLanguage })],
  });
  ensureSyntaxTree(state, doc.length, 5000);
  const view = {
    get state() { return state; },
    dispatch(spec: TransactionSpec) { state = state.update(spec).state; },
  } as unknown as EditorView;
  cmd(view);
  const sel = state.selection.main;
  return {
    doc: state.doc.toString(),
    anchor: sel.anchor,
    head: sel.head,
    selected: state.sliceDoc(sel.from, sel.to),
  };
}

function stateFor(doc: string, pos: number): EditorState {
  const state = EditorState.create({
    doc,
    selection: { anchor: pos },
    extensions: [markdown({ base: markdownLanguage })],
  });
  ensureSyntaxTree(state, doc.length, 5000);
  return state;
}

// ── applyMarkerCm ────────────────────────────────────────────────────────────

describe("applyMarkerCm - selection toggle matrix", () => {
  it("wraps a plain selection", () => {
    const r = run("hello world", 0, 5, (v) => applyMarkerCm(v, "**"));
    expect(r.doc).toBe("**hello** world");
    expect(r.selected).toBe("hello");
  });

  it("unwraps when the selection includes the markers", () => {
    const r = run("**hello** world", 0, 9, (v) => applyMarkerCm(v, "**"));
    expect(r.doc).toBe("hello world");
    expect(r.selected).toBe("hello");
  });

  it("unwraps when the markers sit just outside the selection", () => {
    const r = run("**hello** world", 2, 7, (v) => applyMarkerCm(v, "**"));
    expect(r.doc).toBe("hello world");
    expect(r.selected).toBe("hello");
  });

  it("does not mistake ** for * when toggling italic around a bold word", () => {
    // Selecting `hello` inside `**hello**` and toggling `*` must not strip
    // half of the bold markers.
    const r = run("**hello**", 2, 7, (v) => applyMarkerCm(v, "*"));
    expect(r.doc).toBe("***hello***");
  });

  it("toggles strikethrough", () => {
    const wrap = run("gone", 0, 4, (v) => applyMarkerCm(v, "~~"));
    expect(wrap.doc).toBe("~~gone~~");
    const unwrap = run("~~gone~~", 0, 8, (v) => applyMarkerCm(v, "~~"));
    expect(unwrap.doc).toBe("gone");
  });
});

describe("applyMarkerCm - C3 collapsed cursor inside formatting unformats", () => {
  it("removes surrounding ** markers when the caret sits inside bold text", () => {
    const doc = "some **bold** text";
    const r = run(doc, doc.indexOf("old"), doc.indexOf("old"), (v) => applyMarkerCm(v, "**"));
    expect(r.doc).toBe("some bold text");
    expect(r.anchor).toBe(r.head); // still collapsed
  });

  it("removes surrounding * markers when the caret sits inside italic text", () => {
    const doc = "an *ital* word";
    const r = run(doc, doc.indexOf("tal"), doc.indexOf("tal"), (v) => applyMarkerCm(v, "*"));
    expect(r.doc).toBe("an ital word");
  });

  it("removes surrounding __ markers (underline) but not via the bold toggle", () => {
    const doc = "an __under__ word";
    const underline = run(doc, doc.indexOf("nder"), doc.indexOf("nder"), (v) => applyMarkerCm(v, "__"));
    expect(underline.doc).toBe("an under word");
    // Bold (`**`) does not match a `__`-delimited span - it starts a new pair.
    const bold = run(doc, doc.indexOf("nder"), doc.indexOf("nder"), (v) => applyMarkerCm(v, "**"));
    expect(bold.doc).toContain("__");
    expect(bold.doc).toContain("****");
  });

  it("removes surrounding ~~ markers when the caret sits inside strikethrough", () => {
    const doc = "a ~~gone~~ b";
    const r = run(doc, doc.indexOf("one"), doc.indexOf("one"), (v) => applyMarkerCm(v, "~~"));
    expect(r.doc).toBe("a gone b");
  });

  it("a caret between an empty marker pair removes the pair", () => {
    const r = run("****", 2, 2, (v) => applyMarkerCm(v, "**"));
    expect(r.doc).toBe("");
    expect(r.anchor).toBe(0);
  });

  it("a caret in plain text starts a pair with the cursor between", () => {
    const r = run("ab", 1, 1, (v) => applyMarkerCm(v, "**"));
    expect(r.doc).toBe("a****b");
    expect(r.anchor).toBe(3);
  });
});

describe("applyMarkerCm - C4/T-M9 flanking validity", () => {
  it("trims edge whitespace out of the wrapped range", () => {
    const r = run("hello world", 0, 6, (v) => applyMarkerCm(v, "**"));
    expect(r.doc).toBe("**hello** world");
  });

  it("trims leading whitespace too", () => {
    const r = run("hello world", 5, 11, (v) => applyMarkerCm(v, "**"));
    expect(r.doc).toBe("hello **world**");
  });

  it("expands an intraword underscore selection to word boundaries", () => {
    // `he__ll__o` is not flanking-valid; the wrap must cover the whole word.
    const r = run("hello", 1, 4, (v) => applyMarkerCm(v, "__"));
    expect(r.doc).toBe("__hello__");
  });

  it("wraps each line separately for multi-line selections", () => {
    const r = run("one\ntwo", 0, 7, (v) => applyMarkerCm(v, "**"));
    expect(r.doc).toBe("**one**\n**two**");
  });

  it("unwraps each line when every line-slice is already wrapped", () => {
    const r = run("**one**\n**two**", 0, 15, (v) => applyMarkerCm(v, "**"));
    expect(r.doc).toBe("one\ntwo");
  });

  it("skips blank lines in multi-line selections", () => {
    const r = run("one\n\ntwo", 0, 8, (v) => applyMarkerCm(v, "**"));
    expect(r.doc).toBe("**one**\n\n**two**");
  });
});

// ── applyLinePrefixCm ────────────────────────────────────────────────────────

describe("applyLinePrefixCm", () => {
  it("converts plain lines to bullets and toggles them off", () => {
    const on = run("a\nb", 0, 3, (v) => applyLinePrefixCm(v, "bullet"));
    expect(on.doc).toBe("- a\n- b");
    const off = run("- a\n- b", 0, 7, (v) => applyLinePrefixCm(v, "bullet"));
    expect(off.doc).toBe("a\nb");
  });

  it("converts to tasks", () => {
    const r = run("a", 0, 1, (v) => applyLinePrefixCm(v, "task"));
    expect(r.doc).toBe("- [ ] a");
  });

  it("replaces an existing list kind instead of stacking prefixes", () => {
    const r = run("- a\n- b", 0, 7, (v) => applyLinePrefixCm(v, "numbered"));
    expect(r.doc).toBe("1. a\n2. b");
  });

  it("U4: numbering continues an ordered list immediately above", () => {
    const doc = "1. a\n2. b\nc";
    const pos = doc.indexOf("c");
    const r = run(doc, pos, pos, (v) => applyLinePrefixCm(v, "numbered"));
    expect(r.doc).toBe("1. a\n2. b\n3. c");
  });

  it("U4: numbering restarts when there is no list above", () => {
    const r = run("c", 0, 0, (v) => applyLinePrefixCm(v, "numbered"));
    expect(r.doc).toBe("1. c");
  });

  it("U4: numbering restarts when the list above has a different indent", () => {
    const doc = "  1. a\nb";
    const pos = doc.indexOf("b");
    const r = run(doc, pos, pos, (v) => applyLinePrefixCm(v, "numbered"));
    expect(r.doc).toBe("  1. a\n1. b");
  });

  it("U4: continuation applies when converting a bullet after a numbered item", () => {
    const doc = "1. a\n- b";
    const pos = doc.indexOf("- b");
    const r = run(doc, pos, pos, (v) => applyLinePrefixCm(v, "numbered"));
    expect(r.doc).toBe("1. a\n2. b");
  });
});

// ── applyHeadingCm ───────────────────────────────────────────────────────────

describe("applyHeadingCm", () => {
  it("applies a heading level to the current line", () => {
    const r = run("hello", 0, 0, (v) => applyHeadingCm(v, 2));
    expect(r.doc).toBe("## hello");
    expect(r.anchor).toBeGreaterThanOrEqual(3); // caret kept out of the prefix
  });

  it("changes an existing level", () => {
    const r = run("## hello", 4, 4, (v) => applyHeadingCm(v, 3));
    expect(r.doc).toBe("### hello");
  });

  it("removes the heading at level 0", () => {
    const r = run("## hello", 4, 4, (v) => applyHeadingCm(v, 0));
    expect(r.doc).toBe("hello");
  });

  it("U5: applies to every selected line, skipping blank ones", () => {
    const r = run("one\n\ntwo", 0, 8, (v) => applyHeadingCm(v, 2));
    expect(r.doc).toBe("## one\n\n## two");
  });

  it("no-ops when every selected line is already at the level", () => {
    const r = run("## a\n## b", 0, 9, (v) => applyHeadingCm(v, 2));
    expect(r.doc).toBe("## a\n## b");
  });
});

// ── applyBlockquoteCm ────────────────────────────────────────────────────────

describe("applyBlockquoteCm", () => {
  it("adds and removes the quote prefix across the selection", () => {
    const on = run("a\nb", 0, 3, (v) => applyBlockquoteCm(v));
    expect(on.doc).toBe("> a\n> b");
    const off = run("> a\n> b", 0, 7, (v) => applyBlockquoteCm(v));
    expect(off.doc).toBe("a\nb");
  });
});

// ── block inserts (T-L11: no stray blank line above) ─────────────────────────

describe("applyHrCm", () => {
  it("reuses an empty current line without a stray blank above", () => {
    const r = run("", 0, 0, (v) => applyHrCm(v));
    expect(r.doc).toBe("---\n");
  });

  it("separates from existing content with one blank line", () => {
    const r = run("text", 4, 4, (v) => applyHrCm(v));
    expect(r.doc).toBe("text\n\n---\n");
  });
});

describe("insertCalloutCm", () => {
  it("inserts on an empty line without a stray blank above", () => {
    const r = run("", 0, 0, (v) => insertCalloutCm(v, "tip"));
    expect(r.doc).toBe("> [!tip]\n> ");
    expect(r.anchor).toBe(r.doc.length);
  });
});

describe("insertTableCm", () => {
  it("T-L11: selects the first header placeholder so typing replaces it", () => {
    const r = run("", 0, 0, (v) => insertTableCm(v, 2, 3));
    expect(r.doc).toBe(
      "| Col 1 | Col 2 | Col 3 |\n| --- | --- | --- |\n|     |     |     |\n|     |     |     |\n",
    );
    expect(r.selected).toBe("Col 1");
  });

  it("keeps the placeholder selection when inserted after content", () => {
    const r = run("text", 4, 4, (v) => insertTableCm(v, 1, 1));
    expect(r.doc).toBe("text\n\n| Col 1 |\n| --- |\n|     |\n");
    expect(r.selected).toBe("Col 1");
  });
});

// ── applyCodeFenceCm ─────────────────────────────────────────────────────────

describe("applyCodeFenceCm", () => {
  it("inserts a fence pair with the caret on the blank body line", () => {
    const r = run("", 0, 0, (v) => applyCodeFenceCm(v));
    expect(r.doc).toBe("```\n\n```\n");
    expect(r.anchor).toBe(4);
  });

  it("separates from existing content with one blank line", () => {
    const r = run("text", 4, 4, (v) => applyCodeFenceCm(v));
    expect(r.doc).toBe("text\n\n```\n\n```\n");
  });

  it("T-M5: toggles an existing fence OFF instead of nesting a new pair", () => {
    const doc = "```\ncode\n```";
    const pos = doc.indexOf("ode");
    const r = run(doc, pos, pos, (v) => applyCodeFenceCm(v));
    expect(r.doc).toBe("code\n");
  });

  it("T-M5: keeps the body and drops the info string", () => {
    const doc = "```js\nconst x = 1;\n```";
    const pos = doc.indexOf("x =");
    const r = run(doc, pos, pos, (v) => applyCodeFenceCm(v));
    expect(r.doc).toBe("const x = 1;\n");
  });

  it("T-M5: an unclosed fence only removes the opening line", () => {
    const doc = "```\ncode";
    const pos = doc.indexOf("ode");
    const r = run(doc, pos, pos, (v) => applyCodeFenceCm(v));
    expect(r.doc).toBe("code");
  });

  it("T-M5: surrounding content survives the toggle", () => {
    const doc = "before\n\n```\ncode\n```\n\nafter";
    const pos = doc.indexOf("ode");
    const r = run(doc, pos, pos, (v) => applyCodeFenceCm(v));
    expect(r.doc).toBe("before\n\ncode\n\nafter");
  });
});

// ── computeActiveFormats ─────────────────────────────────────────────────────

describe("computeActiveFormats", () => {
  it("reports bold with the caret inside **bold**", () => {
    const doc = "a **bold** b";
    const f = computeActiveFormats(stateFor(doc, doc.indexOf("old")));
    expect(f.bold).toBe(true);
    expect(f.underline).toBe(false);
  });

  it("T-L11: does NOT report bold with the caret just after the closing marker", () => {
    const doc = "**b** x";
    const f = computeActiveFormats(stateFor(doc, 5));
    expect(f.bold).toBe(false);
  });

  it("distinguishes __underline__ from **bold**", () => {
    const doc = "a __u__ b";
    const f = computeActiveFormats(stateFor(doc, 5));
    expect(f.underline).toBe(true);
    expect(f.bold).toBe(false);
  });

  it("reports italic and strikethrough", () => {
    const italic = computeActiveFormats(stateFor("a *i* b", 4));
    expect(italic.italic).toBe(true);
    const strike = computeActiveFormats(stateFor("a ~~s~~ b", 5));
    expect(strike.strike).toBe(true);
  });

  it("reports the heading level", () => {
    const f = computeActiveFormats(stateFor("### head", 6));
    expect(f.headingLevel).toBe(3);
  });

  it("reports blockquote and code fence contexts", () => {
    const q = computeActiveFormats(stateFor("> quoted", 4));
    expect(q.blockquote).toBe(true);
    const doc = "```\ncode\n```";
    const c = computeActiveFormats(stateFor(doc, doc.indexOf("ode")));
    expect(c.codeFence).toBe(true);
  });
});
