import { describe, it, expect } from "vitest";
import { isThemeMode, isHexColor, THEME_MODES } from "./theme";

describe("isThemeMode", () => {
  it("accepts every value in THEME_MODES", () => {
    for (const v of THEME_MODES) expect(isThemeMode(v)).toBe(true);
  });

  it("rejects unknown / wrong-case strings", () => {
    expect(isThemeMode("solarized")).toBe(false);
    expect(isThemeMode("")).toBe(false);
    expect(isThemeMode("DARK")).toBe(false);
  });

  it("rejects non-strings", () => {
    expect(isThemeMode(null)).toBe(false);
    expect(isThemeMode(undefined)).toBe(false);
    expect(isThemeMode(1)).toBe(false);
    expect(isThemeMode({})).toBe(false);
  });
});

describe("isHexColor", () => {
  it("accepts #rrggbb in either case", () => {
    expect(isHexColor("#2e7d6b")).toBe(true);
    expect(isHexColor("#ABCDEF")).toBe(true);
  });

  it("rejects short form, missing hash, bad digits", () => {
    expect(isHexColor("#abc")).toBe(false);
    expect(isHexColor("2e7d6b")).toBe(false);
    expect(isHexColor("#2e7d6g")).toBe(false);
    expect(isHexColor("#2e7d6b ")).toBe(false);
  });

  it("rejects non-strings", () => {
    expect(isHexColor(null)).toBe(false);
    expect(isHexColor(undefined)).toBe(false);
    expect(isHexColor(0xffffff)).toBe(false);
  });
});
