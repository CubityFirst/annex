import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { Wikilink } from "./wikilinkExtension";

interface NodeSpan { from: number; to: number; text: string }

function parse(doc: string): EditorState {
  const state = EditorState.create({
    doc,
    extensions: [markdown({ base: markdownLanguage, extensions: [Wikilink] })],
  });
  ensureSyntaxTree(state, doc.length, 5000);
  return state;
}

function nodesNamed(doc: string, name: string): NodeSpan[] {
  const state = parse(doc);
  const out: NodeSpan[] = [];
  syntaxTree(state).iterate({
    enter: (n) => {
      if (n.name === name) out.push({ from: n.from, to: n.to, text: state.doc.sliceString(n.from, n.to) });
    },
  });
  return out;
}

const wikilinks = (doc: string) => nodesNamed(doc, "Wikilink");

describe("Wikilink grammar extension", () => {
  it("parses [[x]] as one Wikilink with two 2-char marks", () => {
    const doc = "see [[Target Doc]] here";
    const links = wikilinks(doc);
    expect(links).toEqual([{ from: 4, to: 18, text: "[[Target Doc]]" }]);
    const marks = nodesNamed(doc, "WikilinkMark");
    expect(marks).toEqual([
      { from: 4, to: 6, text: "[[" },
      { from: 16, to: 18, text: "]]" },
    ]);
  });

  it("parses the empty [[]]", () => {
    expect(wikilinks("[[]]")).toEqual([{ from: 0, to: 4, text: "[[]]" }]);
  });

  it("[[[x]]] spans the INNER [[x]] (innermost wins, T-L1)", () => {
    expect(wikilinks("[[[x]]]")).toEqual([{ from: 1, to: 6, text: "[[x]]" }]);
  });

  it("does not match unclosed [[x", () => {
    expect(wikilinks("[[x")).toEqual([]);
    expect(wikilinks("[[x] y")).toEqual([]);
  });

  it("does not match across lines", () => {
    expect(wikilinks("[[a\nb]]")).toEqual([]);
  });

  it("an escaped \\] does not count toward the closer (T-L1)", () => {
    // [[a\]]b]] - the \] is content; the real closer is the final ]]
    const doc = "[[a\\]]b]]";
    expect(wikilinks(doc)).toEqual([{ from: 0, to: 9, text: "[[a\\]]b]]" }]);
  });

  it("stays unclosed when the only ]] contains an escaped bracket", () => {
    expect(wikilinks("[[a\\]]")).toEqual([]);
  });

  it("an escaped opener is not a wikilink", () => {
    // \[ is consumed by the standard Escape parser, leaving a single [
    expect(wikilinks("\\[[x]]")).toEqual([]);
  });

  it("a backslash at end of line does not swallow the newline", () => {
    expect(wikilinks("[[a\\\nb]]")).toEqual([]);
  });

  it("is shielded inside code spans", () => {
    const doc = "`[[x]]`";
    expect(wikilinks(doc)).toEqual([]);
    expect(nodesNamed(doc, "InlineCode")).toHaveLength(1);
  });

  it("nests inside emphasis", () => {
    const doc = "*em [[x]] tail*";
    expect(wikilinks(doc)).toEqual([{ from: 4, to: 9, text: "[[x]]" }]);
    expect(nodesNamed(doc, "Emphasis")).toHaveLength(1);
  });

  it("wins over the standard Link parser", () => {
    const doc = "[[not a link]](url)";
    expect(wikilinks(doc)).toHaveLength(1);
    expect(nodesNamed(doc, "Link")).toEqual([]);
  });
});
