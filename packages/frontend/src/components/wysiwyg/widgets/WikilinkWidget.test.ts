import { describe, it, expect } from "vitest";
import { parseWikilink } from "./WikilinkWidget";

describe("parseWikilink", () => {
  it("plain title", () => {
    expect(parseWikilink("Getting Started")).toEqual({
      title: "Getting Started",
      anchor: undefined,
      display: "Getting Started",
    });
  });

  it("title with #anchor", () => {
    expect(parseWikilink("Guide#setup")).toEqual({
      title: "Guide",
      anchor: "setup",
      display: "Guide#setup",
    });
  });

  it("title with |display alias", () => {
    expect(parseWikilink("Guide|the guide")).toEqual({
      title: "Guide",
      anchor: undefined,
      display: "the guide",
    });
  });

  it("a#b|c - title, anchor and alias together", () => {
    expect(parseWikilink("a#b|c")).toEqual({
      title: "a",
      anchor: "b",
      display: "c",
    });
  });

  it("empty string does not parse", () => {
    expect(parseWikilink("")).toBeNull();
  });

  it("whitespace-only pieces are trimmed", () => {
    expect(parseWikilink("  Guide  #  sec  |  Alias  ")).toEqual({
      title: "Guide",
      anchor: "sec",
      display: "Alias",
    });
  });

  it("a trailing | with an empty alias does not parse (renders raw)", () => {
    // The alias group requires >=1 char and nothing else can consume the `|`,
    // so the whole wikilink fails to parse - pinned current behavior.
    expect(parseWikilink("Guide#sec|")).toBeNull();
  });

  it("anchor-only input ([[#anchor]]) does not parse (documented D17 behavior)", () => {
    // The regex requires at least one title char before # - same-doc anchors
    // are a known decorations-side gap (research D17), pinned here.
    expect(parseWikilink("#anchor")).toBeNull();
  });
});
