import { describe, it, expect } from "vitest";
import { parseFrontmatter, setFrontmatterKey } from "./frontmatter";

describe("parseFrontmatter", () => {
  it("returns empty object when no frontmatter", () => {
    expect(parseFrontmatter("# Hello")).toEqual({});
  });

  it("returns empty object for empty string", () => {
    expect(parseFrontmatter("")).toEqual({});
  });

  it("parses sidebar_position", () => {
    expect(parseFrontmatter("---\nsidebar_position: 3\n---\n")).toEqual({ sidebar_position: 3 });
  });

  it("ignores non-numeric sidebar_position", () => {
    expect(parseFrontmatter("---\nsidebar_position: abc\n---\n")).toEqual({});
  });

  it("parses unquoted title", () => {
    expect(parseFrontmatter("---\ntitle: My Doc\n---\n")).toEqual({ title: "My Doc" });
  });

  it("parses single-quoted title, stripping quotes", () => {
    expect(parseFrontmatter("---\ntitle: 'My Doc'\n---\n")).toEqual({ title: "My Doc" });
  });

  it("parses double-quoted title, stripping quotes", () => {
    expect(parseFrontmatter("---\ntitle: \"My Doc\"\n---\n")).toEqual({ title: "My Doc" });
  });

  it("parses hide_title true", () => {
    expect(parseFrontmatter("---\nhide_title: true\n---\n")).toEqual({ hide_title: true });
  });

  it("parses hide_title false", () => {
    expect(parseFrontmatter("---\nhide_title: false\n---\n")).toEqual({ hide_title: false });
  });

  it("parses inline array tags", () => {
    expect(parseFrontmatter("---\ntags: [foo, bar]\n---\n")).toEqual({ tags: ["foo", "bar"] });
  });

  it("strips # prefix from inline tags", () => {
    expect(parseFrontmatter("---\ntags: [#foo, #bar]\n---\n")).toEqual({ tags: ["foo", "bar"] });
  });

  it("strips quotes from inline tags", () => {
    expect(parseFrontmatter("---\ntags: ['alpha', \"beta\"]\n---\n")).toEqual({ tags: ["alpha", "beta"] });
  });

  it("parses block list tags", () => {
    const md = "---\ntags:\n  - foo\n  - bar\n---\n";
    expect(parseFrontmatter(md)).toEqual({ tags: ["foo", "bar"] });
  });

  it("strips # prefix from block list tags", () => {
    const md = "---\ntags:\n  - '#foo'\n  - '#bar'\n---\n";
    expect(parseFrontmatter(md)).toEqual({ tags: ["foo", "bar"] });
  });

  it("parses single inline tag as a one-element array", () => {
    expect(parseFrontmatter("---\ntags: foo\n---\n")).toEqual({ tags: ["foo"] });
  });

  it("handles CRLF line endings", () => {
    expect(parseFrontmatter("---\r\nsidebar_position: 2\r\n---\r\n")).toEqual({ sidebar_position: 2 });
  });

  it("ignores body content after closing ---", () => {
    const result = parseFrontmatter("---\ntitle: Hello\n---\nSome content here");
    expect(result).toEqual({ title: "Hello" });
  });

  it("parses multiple fields together", () => {
    const md = "---\ntitle: My Doc\nsidebar_position: 1\nhide_title: true\ntags: [a, b]\ndescription: A summary.\nimage: /api/files/abc/content\n---\n";
    expect(parseFrontmatter(md)).toEqual({
      title: "My Doc",
      sidebar_position: 1,
      hide_title: true,
      tags: ["a", "b"],
      description: "A summary.",
      image: "/api/files/abc/content",
    });
  });

  it("parses unquoted description", () => {
    expect(parseFrontmatter("---\ndescription: A short summary.\n---\n")).toEqual({ description: "A short summary." });
  });

  it("parses double-quoted description, stripping quotes", () => {
    expect(parseFrontmatter("---\ndescription: \"With: a colon\"\n---\n")).toEqual({ description: "With: a colon" });
  });

  it("ignores empty description", () => {
    expect(parseFrontmatter("---\ndescription:\n---\n")).toEqual({});
  });

  it("parses image with file path", () => {
    expect(parseFrontmatter("---\nimage: /api/files/abc123/content\n---\n")).toEqual({ image: "/api/files/abc123/content" });
  });

  it("parses image with quoted absolute URL", () => {
    expect(parseFrontmatter("---\nimage: \"https://example.com/cover.png\"\n---\n")).toEqual({ image: "https://example.com/cover.png" });
  });

  it("ignores empty image", () => {
    expect(parseFrontmatter("---\nimage:\n---\n")).toEqual({});
  });

  it("ignores unknown keys", () => {
    expect(parseFrontmatter("---\nsome_random_key: value\n---\n")).toEqual({});
  });

  it("parses cover with file path", () => {
    expect(parseFrontmatter("---\ncover: /api/files/abc123/content\n---\n")).toEqual({ cover: "/api/files/abc123/content" });
  });

  it("parses cover with quoted absolute URL", () => {
    expect(parseFrontmatter("---\ncover: \"https://example.com/banner.png\"\n---\n")).toEqual({ cover: "https://example.com/banner.png" });
  });

  it("ignores empty cover", () => {
    expect(parseFrontmatter("---\ncover:\n---\n")).toEqual({});
  });

  it("parses cover and image independently", () => {
    expect(parseFrontmatter("---\ncover: /api/files/a/content\nimage: /api/files/b/content\n---\n"))
      .toEqual({ cover: "/api/files/a/content", image: "/api/files/b/content" });
  });
});

describe("setFrontmatterKey", () => {
  it("creates a frontmatter block when none exists", () => {
    expect(setFrontmatterKey("# Hello", "cover", "/api/files/x/content"))
      .toBe("---\ncover: /api/files/x/content\n---\n\n# Hello");
  });

  it("adds a key to an existing block", () => {
    expect(setFrontmatterKey("---\ntitle: Doc\n---\n\nBody", "cover", "/x"))
      .toBe("---\ntitle: Doc\ncover: /x\n---\n\nBody");
  });

  it("replaces an existing key in place-ish without duplicating it", () => {
    const out = setFrontmatterKey("---\ncover: /old\ntitle: Doc\n---\nBody", "cover", "/new");
    expect(parseFrontmatter(out)).toEqual({ cover: "/new", title: "Doc" });
    expect(out.match(/cover:/g)?.length).toBe(1);
  });

  it("removes a key when value is null, keeping other keys", () => {
    expect(setFrontmatterKey("---\ntitle: Doc\ncover: /old\n---\nBody", "cover", null))
      .toBe("---\ntitle: Doc\n---\nBody");
  });

  it("drops the whole block when removing the last key", () => {
    expect(setFrontmatterKey("---\ncover: /old\n---\n\nBody", "cover", null)).toBe("Body");
  });

  it("is a no-op when removing a key from content with no frontmatter", () => {
    expect(setFrontmatterKey("# Hello", "cover", null)).toBe("# Hello");
  });

  it("round-trips through parseFrontmatter after a set", () => {
    const out = setFrontmatterKey("---\ntitle: Doc\ntags: [a, b]\n---\nBody", "cover", "/api/files/z/content");
    expect(parseFrontmatter(out)).toEqual({ title: "Doc", tags: ["a", "b"], cover: "/api/files/z/content" });
  });
});
