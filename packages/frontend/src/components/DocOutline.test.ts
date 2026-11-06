import { describe, expect, it } from "vitest";
import { outlineHeadings } from "./DocOutline";

const h = (level: number, text: string) => ({ level, text, id: text.toLowerCase().replace(/\s+/g, "-") });

describe("outlineHeadings", () => {
  it("drops a leading H1 that repeats the doc title", () => {
    const list = [h(1, "Editor tour"), h(2, "Formatting"), h(2, "Callouts")];
    expect(outlineHeadings(list, "Editor tour").map(x => x.text)).toEqual(["Formatting", "Callouts"]);
  });

  it("matches the title ignoring case and extra whitespace", () => {
    expect(outlineHeadings([h(1, "  Editor   Tour "), h(2, "A")], "editor tour").map(x => x.text)).toEqual(["A"]);
  });

  it("keeps a leading H1 that differs from the title", () => {
    const list = [h(1, "Alpha Section"), h(2, "Beta Section")];
    expect(outlineHeadings(list, "Scroll Test Doc")).toEqual(list);
  });

  it("only skips the leading H1, keeping later H1s", () => {
    const list = [h(1, "Guide"), h(2, "Intro"), h(1, "Guide"), h(2, "More")];
    expect(outlineHeadings(list, "Guide").map(x => x.text)).toEqual(["Intro", "Guide", "More"]);
  });

  it("keeps everything when the doc starts with an H2 or has no title", () => {
    const list = [h(2, "Guide"), h(2, "Intro")];
    expect(outlineHeadings(list, "Guide")).toEqual(list);
    expect(outlineHeadings([h(1, "Guide")], undefined)).toEqual([h(1, "Guide")]);
    expect(outlineHeadings([], "Guide")).toEqual([]);
  });
});
