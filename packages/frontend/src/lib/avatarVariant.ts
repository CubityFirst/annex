// The light/dark signal that every avatar in the app derives from.
//
// Derived from the effective theme, not stored: applyThemeToRoot (lib/theme.ts)
// is the single place that toggles the `dark` class on <html> - for all three
// modes, including custom-palette polarity - so that class IS the effective
// light/dark signal. Reading it (instead of ThemePrefs) keeps this store
// correct no matter how the theme got applied: the settings control, the
// cookie boot in main.tsx, or App.tsx resetting unthemed paths to the default.
//
// A MutationObserver on <html>'s class attribute notifies subscribers, so
// mounted avatars re-render (and re-request the matching variant) the moment
// the theme changes. The server falls back to the other variant when the
// requested one isn't uploaded, so single-variant users never break.

import { useSyncExternalStore } from "react";

export type AvatarVariant = "dark" | "light";

const listeners = new Set<() => void>();

let observerBound = false;
function ensureObserver(): void {
  if (observerBound || typeof document === "undefined") return;
  observerBound = true;
  new MutationObserver(() => {
    for (const l of listeners) l();
  }).observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
}

function read(): AvatarVariant {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

/** The variant matching the effective theme right now (non-reactive read). */
export function getAvatarVariant(): AvatarVariant {
  return read();
}

function subscribe(callback: () => void): () => void {
  ensureObserver();
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}

/** The avatar variant matching the effective theme - re-renders on theme change. */
export function useAvatarVariant(): AvatarVariant {
  return useSyncExternalStore(subscribe, read, () => "dark" as const);
}
