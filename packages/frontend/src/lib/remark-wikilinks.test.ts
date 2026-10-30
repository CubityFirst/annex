import { describe, it, expect } from "vitest";
import { remarkWikilinks, wikilinkUrlTransform } from "./remark-wikilinks";

// ── wikilinkUrlTransform ───────────────────────────────────────────────────

describe("wikilinkUrlTransform", () => {
  it("passes doc:// URLs through unchanged", () => {
    expect(wikilinkUrlTransform("doc://My%20Page")).toBe("doc://My%20Page");
  });

  it("passes https URLs through unchanged", () => {
    expect(wikilinkUrlTransform("https://example.com")).toBe("https://example.com");
  });

  it("sanitizes javascript: URLs to empty string", () => {
    expect(wikilinkUrlTransform("javascript:alert(1)")).toBe("");
  });
});

// ── remarkWikilinks ────────────────────────────────────────────────────────

type Node = Record<string, unknown> & { children?: Node[] };

function makeTree(text: string): Node {
  return {
    type: "root",
    children: [
      {
        type: "paragraph",
        children: [{ type: "text", value: text }],
      },
    ],
  };
}

function run(tree: Node) {
  remarkWikilinks()(tree as never);
}

describe("remarkWikilinks plugin", () => {
  it("converts [[Title]] to a link node with doc:// URL", () => {
    const tree = makeTree("[[My Page]]");
    run(tree);
    const para = tree.children![0];
    expect(para.children).toHaveLength(1);
    const link = para.children![0] as Node;
    expect(link.type).toBe("link");
    expect(link.url).toBe("doc://My%20Page");
    expect((link.children as Node[])[0].value).toBe("My Page");
  });

  it("uses display text from [[Title|Display]]", () => {
    const tree = makeTree("[[My Page|Click here]]");
    run(tree);
    const link = tree.children![0].children![0] as Node;
    expect(link.url).toBe("doc://My%20Page");
    expect((link.children as Node[])[0].value).toBe("Click here");
  });

  it("includes anchor in URL for [[Title#section]]", () => {
    const tree = makeTree("[[My Page#intro]]");
    run(tree);
    expect(tree.children![0].children![0].url).toBe("doc://My%20Page#intro");
  });

  it("combines anchor and display text [[Title#section|Show]]", () => {
    const tree = makeTree("[[Ref#anchor|Show]]");
    run(tree);
    const link = tree.children![0].children![0] as Node;
    expect(link.url).toBe("doc://Ref#anchor");
    expect((link.children as Node[])[0].value).toBe("Show");
  });

  it("leaves plain text with no wikilinks unchanged", () => {
    const tree = makeTree("Just some text");
    run(tree);
    const node = tree.children![0].children![0] as Node;
    expect(node.type).toBe("text");
    expect(node.value).toBe("Just some text");
  });

  it("splits text around an inline wikilink into three nodes", () => {
    const tree = makeTree("Before [[Page]] after");
    run(tree);
    const children = tree.children![0].children!;
    expect(children).toHaveLength(3);
    expect(children[0]).toMatchObject({ type: "text", value: "Before " });
    expect(children[1]).toMatchObject({ type: "link", url: "doc://Page" });
    expect(children[2]).toMatchObject({ type: "text", value: " after" });
  });

  it("converts multiple wikilinks in one text node", () => {
    const tree = makeTree("[[A]] and [[B]]");
    run(tree);
    const children = tree.children![0].children!;
    expect(children.filter(c => c.type === "link")).toHaveLength(2);
  });

  it("normalises a relative .md link to a doc:// URL", () => {
    const tree: Node = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [
            {
              type: "link",
              url: "./Some%20Page.md",
              children: [{ type: "text", value: "Link" }],
            },
          ],
        },
      ],
    };
    run(tree);
    expect(tree.children![0].children![0].url).toBe("doc://Some%20Page");
  });

  it("normalises a relative link with anchor", () => {
    const tree: Node = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [{ type: "link", url: "guide.md#setup", children: [] }],
        },
      ],
    };
    run(tree);
    expect(tree.children![0].children![0].url).toBe("doc://guide#setup");
  });

  it("leaves absolute https links unchanged", () => {
    const tree: Node = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [{ type: "link", url: "https://example.com", children: [] }],
        },
      ],
    };
    run(tree);
    expect(tree.children![0].children![0].url).toBe("https://example.com");
  });
});
