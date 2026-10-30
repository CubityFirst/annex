import { describe, it, expect } from "vitest";
import { remarkImageAttrs } from "./remark-image-attrs";

type Node = Record<string, unknown> & { children?: Node[] };

function run(tree: Node) {
  remarkImageAttrs()(tree as never);
}

function makePara(imageUrl: string, attrText?: string): Node {
  const children: Node[] = [{ type: "image", url: imageUrl, alt: "img" }];
  if (attrText !== undefined) {
    children.push({ type: "text", value: attrText });
  }
  return { type: "root", children: [{ type: "paragraph", children }] };
}

function imageStyle(tree: Node): string | undefined {
  return (tree.children![0].children![0] as Node).data?.hProperties?.style as string | undefined;
}

function imageDataSize(tree: Node): string | undefined {
  return (tree.children![0].children![0] as Node).data?.hProperties?.["data-size"] as string | undefined;
}

function paraChildren(tree: Node): Node[] {
  return (tree.children![0] as Node).children!;
}

describe("remarkImageAttrs", () => {
  it("applies width from {width=50%}", () => {
    const tree = makePara("img.png", "{width=50%}");
    run(tree);
    expect(imageStyle(tree)).toBe("width: 50%");
  });

  it("applies height from {height=200px}", () => {
    const tree = makePara("img.png", "{height=200px}");
    run(tree);
    expect(imageStyle(tree)).toBe("height: 200px");
  });

  it("applies both width and height together", () => {
    const tree = makePara("img.png", "{width=50% height=200px}");
    run(tree);
    expect(imageStyle(tree)).toBe("width: 50%; height: 200px");
  });

  it("accepts quoted attribute values", () => {
    const tree = makePara("img.png", '{width="50%" height="200px"}');
    run(tree);
    expect(imageStyle(tree)).toBe("width: 50%; height: 200px");
  });

  it("leaves the image alone when there is no following text node", () => {
    const tree = makePara("img.png");
    run(tree);
    expect(imageStyle(tree)).toBeUndefined();
  });

  it("leaves the image alone when the following text has no attr block", () => {
    const tree = makePara("img.png", " some caption");
    run(tree);
    expect(imageStyle(tree)).toBeUndefined();
  });

  it("strips the {…} block from the trailing text node", () => {
    const tree = makePara("img.png", "{width=80%}");
    run(tree);
    const para = tree.children![0] as Node;
    expect(para.children).toHaveLength(1);
  });

  it("keeps any remainder text after the {…} block", () => {
    const tree = makePara("img.png", "{width=80%} a caption");
    run(tree);
    const para = tree.children![0] as Node;
    expect(para.children).toHaveLength(2);
    expect(para.children![1].value).toBe(" a caption");
  });

  it("appends px to bare numeric values", () => {
    const tree = makePara("img.png", "{width=200 height=50}");
    run(tree);
    expect(imageStyle(tree)).toBe("width: 200px; height: 50px");
  });

  it("centers via align=center", () => {
    const tree = makePara("img.png", "{align=center}");
    run(tree);
    expect(imageStyle(tree)).toBe("display: block; margin-left: auto; margin-right: auto");
  });

  it("treats align=mid as a center alias", () => {
    const tree = makePara("img.png", "{align=mid}");
    run(tree);
    expect(imageStyle(tree)).toBe("display: block; margin-left: auto; margin-right: auto");
  });

  it("left-aligns via align=left", () => {
    const tree = makePara("img.png", "{align=left}");
    run(tree);
    expect(imageStyle(tree)).toBe("display: block; margin-left: 0; margin-right: auto");
  });

  it("right-aligns via align=right", () => {
    const tree = makePara("img.png", "{align=right}");
    run(tree);
    expect(imageStyle(tree)).toBe("display: block; margin-left: auto; margin-right: 0");
  });

  it("combines width with align", () => {
    const tree = makePara("img.png", "{width=50% align=center}");
    run(tree);
    expect(imageStyle(tree)).toBe("width: 50%; display: block; margin-left: auto; margin-right: auto");
  });

  it("ignores unknown align values", () => {
    const tree = makePara("img.png", "{align=bogus}");
    run(tree);
    expect(imageStyle(tree)).toBeUndefined();
  });

  it("surfaces size=full as data-size", () => {
    const tree = makePara("song.mp3", "{size=full}");
    run(tree);
    expect(imageDataSize(tree)).toBe("full");
  });

  it("surfaces size=small as data-size", () => {
    const tree = makePara("song.mp3", "{size=small}");
    run(tree);
    expect(imageDataSize(tree)).toBe("small");
  });

  it("accepts colon separator: size:small", () => {
    const tree = makePara("song.mp3", "{size:small}");
    run(tree);
    expect(imageDataSize(tree)).toBe("small");
  });

  it("strips the {size=…} block from the trailing text", () => {
    const tree = makePara("song.mp3", "{size=small}");
    run(tree);
    expect(paraChildren(tree)).toHaveLength(1);
  });

  it("ignores unknown size values", () => {
    const tree = makePara("song.mp3", "{size=jumbo}");
    run(tree);
    expect(imageDataSize(tree)).toBeUndefined();
  });

  it("combines size with width", () => {
    const tree = makePara("song.mp3", "{size=full width=50%}");
    run(tree);
    expect(imageStyle(tree)).toBe("width: 50%");
    expect(imageDataSize(tree)).toBe("full");
  });

  it("leaves the trailing block in place when no attribute is recognized", () => {
    const tree = makePara("img.png", "{.class #id}");
    run(tree);
    expect(imageStyle(tree)).toBeUndefined();
    const children = paraChildren(tree);
    expect(children).toHaveLength(2);
    expect(children[1].value).toBe("{.class #id}");
  });
});
