import { describe, it, expect } from "vitest";
import { remarkCallouts } from "./remark-callouts";

type Node = Record<string, unknown> & { children?: Node[] };

function makeBlockquote(text: string): Node {
  return {
    type: "root",
    children: [
      {
        type: "blockquote",
        children: [
          {
            type: "paragraph",
            children: [{ type: "text", value: text }],
          },
        ],
      },
    ],
  };
}

function run(tree: Node) {
  remarkCallouts()(tree as never);
}

function hProps(tree: Node): Record<string, string> | undefined {
  return (tree.children![0] as Node).data?.hProperties as Record<string, string> | undefined;
}

describe("remarkCallouts", () => {
  // canonical types
  it("recognises [!note]", () => {
    const tree = makeBlockquote("[!note]");
    run(tree);
    expect(hProps(tree)?.["data-callout"]).toBe("note");
  });

  it("is case-insensitive for the type", () => {
    const tree = makeBlockquote("[!NOTE]");
    run(tree);
    expect(hProps(tree)?.["data-callout"]).toBe("note");
  });

  // aliases
  it("resolves alias 'hint' to 'tip'", () => {
    const tree = makeBlockquote("[!hint]");
    run(tree);
    expect(hProps(tree)?.["data-callout"]).toBe("tip");
  });

  // unknown type
  it("ignores unknown callout types", () => {
    // Alphabetic, so it matches the callout line syntax and reaches the type lookup.
    const tree = makeBlockquote("[!madeup]");
    run(tree);
    expect((tree.children![0] as Node).data).toBeUndefined();
  });

  // title
  it("sets data-callout-title when a custom title is present", () => {
    const tree = makeBlockquote("[!note] My Title");
    run(tree);
    expect(hProps(tree)?.["data-callout-title"]).toBe("My Title");
  });

  it("does not set data-callout-title when no title", () => {
    const tree = makeBlockquote("[!note]");
    run(tree);
    expect(hProps(tree)?.["data-callout-title"]).toBeUndefined();
  });

  // fold
  it("sets data-callout-fold to '-' for collapsed foldable", () => {
    const tree = makeBlockquote("[!warning]-");
    run(tree);
    expect(hProps(tree)?.["data-callout-fold"]).toBe("-");
  });

  it("sets data-callout-fold to '+' for expanded foldable", () => {
    const tree = makeBlockquote("[!info]+");
    run(tree);
    expect(hProps(tree)?.["data-callout-fold"]).toBe("+");
  });

  it("does not set data-callout-fold when not foldable", () => {
    const tree = makeBlockquote("[!note]");
    run(tree);
    expect(hProps(tree)?.["data-callout-fold"]).toBeUndefined();
  });

  it("combines fold and custom title", () => {
    const tree = makeBlockquote("[!warning]- Heads up");
    run(tree);
    const props = hProps(tree)!;
    expect(props["data-callout"]).toBe("warning");
    expect(props["data-callout-fold"]).toBe("-");
    expect(props["data-callout-title"]).toBe("Heads up");
  });

  // body stripping
  it("removes the [!type] line from the paragraph, leaving body text", () => {
    const tree = makeBlockquote("[!note]\nSome body text");
    run(tree);
    const bq = tree.children![0] as Node;
    const firstPara = bq.children![0] as Node;
    expect((firstPara.children![0] as Node).value).toBe("Some body text");
  });

  it("removes the empty paragraph entirely when callout has no body", () => {
    const tree = makeBlockquote("[!note]");
    run(tree);
    const bq = tree.children![0] as Node;
    expect(bq.children).toHaveLength(0);
  });

  // non-callout
  it("does not affect ordinary blockquotes", () => {
    const tree = makeBlockquote("Just a normal quote");
    run(tree);
    expect((tree.children![0] as Node).data).toBeUndefined();
  });
});
