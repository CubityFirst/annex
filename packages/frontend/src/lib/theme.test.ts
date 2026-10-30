import { describe, it, expect, beforeEach } from "vitest";
import {
  MANAGED_VARS,
  resolveThemeMode,
  pathUsesUserTheme,
  isLightTheme,
  derivePalette,
  readThemePrefsCookie,
  writeThemePrefsCookie,
  applyThemeToRoot,
} from "./theme";

function clearCookie() {
  document.cookie = "cd_theme=; path=/; max-age=0";
}

beforeEach(() => {
  clearCookie();
  const root = document.documentElement;
  root.classList.remove("dark");
  root.removeAttribute("style");
});

describe("resolveThemeMode", () => {
  it("passes through known modes and falls back otherwise", () => {
    expect(resolveThemeMode("light")).toBe("light");
    expect(resolveThemeMode("custom")).toBe("custom");
    expect(resolveThemeMode(null)).toBe("dark");
    expect(resolveThemeMode("nope")).toBe("dark");
    expect(resolveThemeMode(undefined, "light")).toBe("light");
  });
});

describe("pathUsesUserTheme", () => {
  it("excludes the landing and auth routes (always default look)", () => {
    expect(pathUsesUserTheme("/")).toBe(false);
    expect(pathUsesUserTheme("/login")).toBe(false);
    expect(pathUsesUserTheme("/register")).toBe(false);
  });

  it("applies the saved theme everywhere else", () => {
    for (const p of ["/dashboard", "/settings", "/projects/abc/docs/x", "/s/proj", "/u/123"]) {
      expect(pathUsesUserTheme(p)).toBe(true);
    }
  });
});

describe("isLightTheme", () => {
  it("is true for light, false for dark", () => {
    expect(isLightTheme({ mode: "light", customColor: null })).toBe(true);
    expect(isLightTheme({ mode: "dark", customColor: null })).toBe(false);
  });

  it("tracks the custom pick's polarity", () => {
    expect(isLightTheme({ mode: "custom", customColor: "#e8f5e9" })).toBe(true);
    expect(isLightTheme({ mode: "custom", customColor: "#2e7d6b" })).toBe(false);
  });

  it("treats custom-without-colour as dark (matches the fallback)", () => {
    expect(isLightTheme({ mode: "custom", customColor: null })).toBe(false);
  });
});

describe("derivePalette", () => {
  it("returns exactly the managed token set, all as oklch/colour strings", () => {
    const p = derivePalette("#2e7d6b");
    expect(Object.keys(p).sort()).toEqual([...MANAGED_VARS].sort());
    for (const v of Object.values(p)) {
      expect(typeof v).toBe("string");
      expect(v.length).toBeGreaterThan(0);
    }
  });

  it("is deterministic for the same input", () => {
    expect(derivePalette("#2e7d6b")).toEqual(derivePalette("#2e7d6b"));
  });

  it("produces different primaries for different hues", () => {
    expect(derivePalette("#2e7d6b")["--primary"]).not.toBe(derivePalette("#7d2e6b")["--primary"]);
  });

  it("uses a stock red for destructive, never tinted toward the base", () => {
    const STOCK_REDS = ["oklch(0.396 0.141 25.723)", "oklch(0.577 0.245 27.325)"];
    for (const hex of ["#2e7d6b", "#7d2e6b", "#ff0000", "#e8f5e9", "#1b1b2f"]) {
      expect(STOCK_REDS).toContain(derivePalette(hex)["--destructive"]);
    }
  });

  const bgL = (hex: string) => parseFloat(derivePalette(hex)["--background"].match(/oklch\(([\d.]+)/)![1]);

  it("builds a DARK theme from a dark pick (low-lightness background)", () => {
    expect(bgL("#1b1b2f")).toBeLessThan(0.3);
    expect(bgL("#2e7d6b")).toBeLessThan(0.3);
  });

  it("builds a LIGHT theme from a pale pick (high-lightness background)", () => {
    expect(bgL("#e8f5e9")).toBeGreaterThan(0.85);
    expect(bgL("#fde7c8")).toBeGreaterThan(0.85);
  });

  it("flips foreground to match the polarity for contrast", () => {
    expect(derivePalette("#1b1b2f")["--foreground"]).toBe("oklch(0.985 0 0)");
    expect(derivePalette("#e8f5e9")["--foreground"]).toBe("oklch(0.21 0.006 285.885)");
  });

  it("handles greyscale / unparseable input without throwing", () => {
    expect(() => derivePalette("#888888")).not.toThrow();
    expect(() => derivePalette("not-a-colour")).not.toThrow();
    expect(derivePalette("#888888")["--background"]).toMatch(/^oklch\(/);
  });
});

describe("cookie round-trip", () => {
  it("returns the default when no cookie is set", () => {
    expect(readThemePrefsCookie()).toEqual({ mode: "dark", customColor: null });
  });

  it("round-trips a custom colour", () => {
    writeThemePrefsCookie({ mode: "custom", customColor: "#2e7d6b" });
    expect(readThemePrefsCookie()).toEqual({ mode: "custom", customColor: "#2e7d6b" });
  });

  it("drops the colour for non-custom modes", () => {
    writeThemePrefsCookie({ mode: "light", customColor: "#2e7d6b" });
    expect(readThemePrefsCookie()).toEqual({ mode: "light", customColor: null });
  });

  it("falls back to default on a malformed colour", () => {
    document.cookie = "cd_theme=" + encodeURIComponent("m:custom|c:nope") + "; path=/";
    expect(readThemePrefsCookie()).toEqual({ mode: "custom", customColor: null });
  });
});

describe("applyThemeToRoot", () => {
  const root = document.documentElement;

  it("dark adds the .dark class and sets no managed inline vars", () => {
    applyThemeToRoot({ mode: "dark", customColor: null });
    expect(root.classList.contains("dark")).toBe(true);
    expect(root.style.getPropertyValue("--primary")).toBe("");
  });

  it("light removes the .dark class and sets no managed inline vars", () => {
    root.classList.add("dark");
    applyThemeToRoot({ mode: "light", customColor: null });
    expect(root.classList.contains("dark")).toBe(false);
    expect(root.style.getPropertyValue("--background")).toBe("");
  });

  it("custom sets every managed token inline; .dark tracks the pick's polarity", () => {
    // Dark pick → .dark on, so non-token `dark:*` utilities still apply.
    applyThemeToRoot({ mode: "custom", customColor: "#2e7d6b" });
    expect(root.classList.contains("dark")).toBe(true);
    for (const name of MANAGED_VARS) {
      expect(root.style.getPropertyValue(name)).not.toBe("");
    }
    // Pale pick → light palette → .dark off.
    applyThemeToRoot({ mode: "custom", customColor: "#e8f5e9" });
    expect(root.classList.contains("dark")).toBe(false);
    for (const name of MANAGED_VARS) {
      expect(root.style.getPropertyValue(name)).not.toBe("");
    }
  });

  it("clears custom inline vars when switching back to light", () => {
    applyThemeToRoot({ mode: "custom", customColor: "#2e7d6b" });
    applyThemeToRoot({ mode: "light", customColor: null });
    for (const name of MANAGED_VARS) {
      expect(root.style.getPropertyValue(name)).toBe("");
    }
  });

  it("custom without a colour falls back to dark", () => {
    applyThemeToRoot({ mode: "custom", customColor: null });
    expect(root.classList.contains("dark")).toBe(true);
    expect(root.style.getPropertyValue("--primary")).toBe("");
  });
});
