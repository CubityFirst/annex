import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { getAvatarVariant, useAvatarVariant } from "./avatarVariant";
import { applyThemeToRoot } from "./theme";

beforeEach(() => {
  const root = document.documentElement;
  root.classList.remove("dark");
  root.removeAttribute("style");
});

describe("getAvatarVariant", () => {
  it("maps the html dark class to the variant", () => {
    expect(getAvatarVariant()).toBe("light");
    document.documentElement.classList.add("dark");
    expect(getAvatarVariant()).toBe("dark");
  });
});

describe("useAvatarVariant", () => {
  it("re-renders subscribers when the theme class changes", async () => {
    document.documentElement.classList.add("dark");
    const { result } = renderHook(() => useAvatarVariant());
    expect(result.current).toBe("dark");

    applyThemeToRoot({ mode: "light", customColor: null });
    await waitFor(() => expect(result.current).toBe("light"));

    applyThemeToRoot({ mode: "dark", customColor: null });
    await waitFor(() => expect(result.current).toBe("dark"));
  });
});
