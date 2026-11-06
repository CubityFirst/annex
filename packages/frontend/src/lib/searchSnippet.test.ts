import { describe, it, expect } from "vitest";
import { cleanSearchSnippet } from "./searchSnippet";

describe("cleanSearchSnippet", () => {
  it("drops task markers and inline code ticks, keeping highlights", () => {
    expect(cleanSearchSnippet("…try the drawing editor - [ ] Press `Ctrl+K` and search for \"<mark>coffee</mark>\" - [ ] Roll some…"))
      .toBe("…try the drawing editor Press Ctrl+K and search for \"<mark>coffee</mark>\" Roll some…");
  });

  it("renders wikilinks as their labels, even when the match splits one or it is cut off", () => {
    expect(cleanSearchSnippet("see [[Welcome to the Annex demo]] or [[guide|the <mark>Coffee</mark> guide]]"))
      .toBe("see Welcome to the Annex demo or the <mark>Coffee</mark> guide");
    expect(cleanSearchSnippet("… brackets: [[<mark>Coffee</mark> brewing…"))
      .toBe("…brackets: <mark>Coffee</mark> brewing…");
  });

  it("removes the space after a leading ellipsis", () => {
    expect(cleanSearchSnippet("… brackets and <mark>coffee</mark>…")).toBe("…brackets and <mark>coffee</mark>…");
    expect(cleanSearchSnippet("...  <mark>coffee</mark> beans")).toBe("...<mark>coffee</mark> beans");
    expect(cleanSearchSnippet("plain … middle")).toBe("plain … middle");
  });

  it("strips links, headings, emphasis and callout markers", () => {
    expect(cleanSearchSnippet("## Brew ratios **Weigh** _everything_ [docs](https://x.y) > [!note] fresh <mark>coffee</mark>"))
      .toBe("Brew ratios Weigh everything docs fresh <mark>coffee</mark>");
  });

  it("leaves plain prose untouched", () => {
    expect(cleanSearchSnippet("the best <mark>coffee</mark> is fresh")).toBe("the best <mark>coffee</mark> is fresh");
  });
});
