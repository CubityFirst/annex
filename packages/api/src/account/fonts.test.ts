import { describe, it, expect } from "vitest";
import { isFontChoice, FONT_CHOICES } from "./fonts";

describe("isFontChoice", () => {
  it("accepts every value in FONT_CHOICES", () => {
    for (const v of FONT_CHOICES) {
      expect(isFontChoice(v)).toBe(true);
    }
  });

  it("rejects unknown strings", () => {
    expect(isFontChoice("comic-sans")).toBe(false);
    expect(isFontChoice("")).toBe(false);
    expect(isFontChoice("MONO")).toBe(false);
  });

  it("rejects non-strings", () => {
    expect(isFontChoice(null)).toBe(false);
    expect(isFontChoice(undefined)).toBe(false);
    expect(isFontChoice(42)).toBe(false);
    expect(isFontChoice({})).toBe(false);
  });
});
