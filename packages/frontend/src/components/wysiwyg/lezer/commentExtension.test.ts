import { describe, it, expect } from "vitest";
import { EditorState, type Extension } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { Comment } from "./commentExtension";
import { buildDecorations } from "../decorations/walker";
import { rendererCtxFacet } from "../context/RendererContext";

interface NodeSpan { from: number; to: number; text: string }

function parse(doc: string, readingMode = false): EditorState {
  const extensions: Extension[] = [markdown({ base: markdownLanguage, extensions: [Comment] })];
  if (readingMode) {
    extensions.push(rendererCtxFacet.of({ isPublic: false, revealOnCursor: false }));
  }
  const state = EditorState.create({ doc, extensions });
  ensureSyntaxTree(state, doc.length, 5000);
  return state;
}

function comments(doc: string): NodeSpan[] {
  const state = parse(doc);
  const out: NodeSpan[] = [];
  syntaxTree(state).iterate({
    enter: (n) => {
      if (n.name === "MdComment") out.push({ from: n.from, to: n.to, text: state.doc.sliceString(n.from, n.to) });
    },
  });
  return out;
}

describe("MdComment grammar extension", () => {
  it("parses %%hidden%% as one MdComment", () => {
    expect(comments("a %%hidden%% b")).toEqual([{ from: 2, to: 12, text: "%%hidden%%" }]);
  });

  it("a bare %%% does not match", () => {
    expect(comments("%%%")).toEqual([]);
  });

  it("%%%% is an empty comment", () => {
    expect(comments("%%%%")).toEqual([{ from: 0, to: 4, text: "%%%%" }]);
  });

  it("the FIRST %% opens - %%% x %% is a comment with content '% x' (symmetric delimiter)", () => {
    expect(comments("%%% x %%")).toEqual([{ from: 0, to: 8, text: "%%% x %%" }]);
  });

  it("does not match unclosed %%x", () => {
    expect(comments("%%x")).toEqual([]);
  });

  it("does not match across lines", () => {
    expect(comments("%%a\nb%%")).toEqual([]);
  });

  it("an escaped \\% does not count toward the closer (T-L1)", () => {
    const doc = "%%a\\%% still%%";
    expect(comments(doc)).toEqual([{ from: 0, to: 14, text: "%%a\\%% still%%" }]);
  });

  it("is shielded inside code spans", () => {
    expect(comments("`%%x%%`")).toEqual([]);
  });

  // T-L3 pin-test: two doubled percents in prose form ONE comment that
  // swallows everything between them. This is correct per Obsidian's comment
  // semantics but surprising ("50%% off ... 20%%" vanishes in reading mode) -
  // pin the exact behaviour so a change to it is a conscious decision.
  describe("prose-percent hiding semantics (pinned)", () => {
    const doc = "Get 50%% off everything, or 20%% off one item";
    const from = doc.indexOf("%%");
    const to = doc.indexOf("%%", from + 2) + 2;

    it("parses the span between the doubled percents as a comment", () => {
      expect(comments(doc)).toEqual([{ from, to, text: doc.slice(from, to) }]);
    });

    it("reading mode hides exactly that span with a replace decoration", () => {
      const state = parse(doc, true);
      const decos = buildDecorations(state);
      const ranges: { from: number; to: number }[] = [];
      decos.between(0, doc.length, (f, t) => { ranges.push({ from: f, to: t }); });
      expect(ranges).toContainEqual({ from, to });
    });
  });
});
