import { describe, it, expect } from "vitest";
import { userColor, userColorLight } from "./userColor";

describe("userColor", () => {

  it("is deterministic for the same input", () => {
    expect(userColor("user-123")).toBe(userColor("user-123"));
  });

  it("produces different values for different IDs", () => {
    expect(userColor("user-1")).not.toBe(userColor("user-2"));
  });

  it("always produces a hue in 0–359 range", () => {
    const ids = ["a", "b", "user-abc-123", "00000000-0000-0000-0000-000000000000", "x".repeat(100)];
    for (const id of ids) {
      const match = userColor(id).match(/^hsl\((\d+) 70% 50%\)$/);
      expect(match, `no match for id "${id}"`).not.toBeNull();
      const hue = Number(match![1]);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
    }
  });

  it("handles empty string without throwing", () => {
    expect(() => userColor("")).not.toThrow();
    expect(userColor("")).toMatch(/^hsl\(\d+ 70% 50%\)$/);
  });
});

describe("userColorLight", () => {
  it("returns an HSL string with 80% lightness", () => {
    expect(userColorLight("abc")).toMatch(/^hsl\(\d+ 70% 80%\)$/);
  });

  it("is deterministic for the same input", () => {
    expect(userColorLight("user-123")).toBe(userColorLight("user-123"));
  });

  it("uses the same hue as userColor for the same ID", () => {
    const id = "test-user-id";
    const darkHue = userColor(id).match(/hsl\((\d+)/)![1];
    const lightHue = userColorLight(id).match(/hsl\((\d+)/)![1];
    expect(lightHue).toBe(darkHue);
  });
});
