import { useSyncExternalStore } from "react";

// Widget React roots don't sit under the app's providers, so theme has to be
// read off <html> directly (lib/theme.ts's applyThemeToRoot toggles the .dark
// class there). useSyncExternalStore + a MutationObserver makes mounted
// widgets react to theme toggles instead of snapshotting once at render.

function subscribe(cb: () => void): () => void {
  const observer = new MutationObserver(cb);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
}

function getSnapshot(): "dark" | "light" {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

export function useDocumentTheme(): "dark" | "light" {
  return useSyncExternalStore(subscribe, getSnapshot, () => "dark");
}
