import { describe, it, expect } from "vitest";
import { sanitizeFtsQuery } from "./fts";

describe("sanitizeFtsQuery", () => {
  it("wraps each word in double quotes and prefix-stars the last", () => {
    expect(sanitizeFtsQuery("hello world")).toBe('"hello" "world"*');
  });

  it("returns empty-string literal for an empty query", () => {
    expect(sanitizeFtsQuery("")).toBe('""');
  });

  it("returns empty-string literal for whitespace-only query", () => {
    expect(sanitizeFtsQuery("   ")).toBe('""');
  });

  it("strips a user-supplied wildcard * (the prefix star is our own)", () => {
    expect(sanitizeFtsQuery("hello*")).toBe('"hello"*');
  });

  it("splits on * between words", () => {
    expect(sanitizeFtsQuery("hello*world")).toBe('"hello" "world"*');
  });

  it("strips double quotes and re-quotes each word", () => {
    expect(sanitizeFtsQuery('"hello"')).toBe('"hello"*');
  });

  it("splits on single quotes, turning 'it's' into two tokens", () => {
    // The quote is replaced with a space, splitting into "it" and "s".
    expect(sanitizeFtsQuery("it's")).toBe('"it" "s"*');
  });

  it("strips parentheses", () => {
    expect(sanitizeFtsQuery("(hello world)")).toBe('"hello" "world"*');
  });

  it("strips caret ^", () => {
    expect(sanitizeFtsQuery("hello^world")).toBe('"hello" "world"*');
  });

  it("strips colon :", () => {
    expect(sanitizeFtsQuery("field:value")).toBe('"field" "value"*');
  });

  it("strips tilde ~", () => {
    expect(sanitizeFtsQuery("hello~2")).toBe('"hello" "2"*');
  });

  it("strips hyphen -", () => {
    expect(sanitizeFtsQuery("hello-world")).toBe('"hello" "world"*');
  });

  it("handles extra whitespace between words", () => {
    expect(sanitizeFtsQuery("  foo   bar  ")).toBe('"foo" "bar"*');
  });

  it("handles a single word", () => {
    expect(sanitizeFtsQuery("docs")).toBe('"docs"*');
  });
});
