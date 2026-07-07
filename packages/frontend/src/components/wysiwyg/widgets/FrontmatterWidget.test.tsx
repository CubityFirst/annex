import { describe, it, expect, afterEach } from "vitest";
import { act } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { parseEntries, FrontmatterWidget } from "./FrontmatterWidget";
import { rendererCtxFacet } from "../context/RendererContext";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// CM's DOMObserver does `new ResizeObserver(...)`; the arrow-function mock in
// src/test/setup.ts is not constructible, so install a real class here.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;

describe("parseEntries", () => {
  it("simple scalar values", () => {
    expect(parseEntries("title: My Doc\nauthor: Ann")).toEqual([
      { key: "title", val: "My Doc" },
      { key: "author", val: "Ann" },
    ]);
  });

  it("strips single and double quotes", () => {
    expect(parseEntries("a: 'one'\nb: \"two\"")).toEqual([
      { key: "a", val: "one" },
      { key: "b", val: "two" },
    ]);
  });

  it("block-style lists collect indented - items", () => {
    expect(parseEntries("tags:\n  - alpha\n  - 'beta'\n  - beta2\ntitle: x")).toEqual([
      { key: "tags", val: "alpha, beta, beta2" },
      { key: "title", val: "x" },
    ]);
  });

  it("flow-style lists split on commas and strip quotes", () => {
    expect(parseEntries("tags: [a, 'b', \"c\"]")).toEqual([
      { key: "tags", val: "a, b, c" },
    ]);
  });

  it("a key with no value and no list keeps an empty val", () => {
    expect(parseEntries("draft:")).toEqual([{ key: "draft", val: "" }]);
  });

  it("duplicate keys produce one entry each (W-L5)", () => {
    expect(parseEntries("tag: a\ntag: b\ntag: c")).toEqual([
      { key: "tag", val: "a" },
      { key: "tag", val: "b" },
      { key: "tag", val: "c" },
    ]);
  });

  it("non key:value lines are skipped", () => {
    expect(parseEntries("# comment\n- stray\nkey: v")).toEqual([{ key: "key", val: "v" }]);
  });
});

describe("FrontmatterWidget rendering (W-L5 duplicate keys)", () => {
  let view: EditorView | undefined;

  afterEach(() => {
    view?.destroy();
    view = undefined;
  });

  it("duplicate YAML keys all render (index-based React keys)", async () => {
    view = new EditorView({
      state: EditorState.create({
        doc: "",
        extensions: [rendererCtxFacet.of({ isPublic: false, revealOnCursor: false })],
      }),
      parent: document.body,
    });

    const widget = new FrontmatterWidget("tag: a\ntag: b\ntag: c");
    let dom!: HTMLElement;
    await act(async () => {
      dom = widget.toDOM(view!);
    });

    const keys = [...dom.querySelectorAll("dt")].map((n) => n.textContent);
    const vals = [...dom.querySelectorAll("dd")].map((n) => n.textContent);
    expect(keys).toEqual(["tag", "tag", "tag"]);
    expect(vals).toEqual(["a", "b", "c"]);

    await act(async () => {
      widget.destroy(dom);
    });
  });
});
