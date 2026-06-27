// The light/dark signal that every avatar in the app derives from.
//
// This is the SINGLE seam for a future app-wide theme rework: nothing else
// (the API resolver, UserAvatar, the settings toggle) decides "light vs dark"
// - they all read this. When a real theme system lands, its only job is to
// become this store's input (e.g. have `read()` consult the theme provider
// when present, else fall back to this localStorage key). Keep the public
// type a plain "dark" | "light" so that swap stays trivial.
//
// Persisted per-browser in localStorage (no DB) and synced across tabs via the
// `storage` event. Default and SSR snapshot are "dark" (the app is dark-only).

import { useSyncExternalStore } from "react";

export type AvatarVariant = "dark" | "light";

const STORAGE_KEY = "cubedocs:avatar-variant";

const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

let storageBound = false;
function ensureStorageListener(): void {
  if (storageBound || typeof window === "undefined") return;
  storageBound = true;
  window.addEventListener("storage", (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) notify();
  });
}

function read(): AvatarVariant {
  if (typeof localStorage === "undefined") return "dark";
  try {
    return localStorage.getItem(STORAGE_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export function getAvatarVariant(): AvatarVariant {
  return read();
}

export function setAvatarVariant(variant: AvatarVariant): void {
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.setItem(STORAGE_KEY, variant);
    } catch {
      // quota exceeded or storage disabled - still notify in-memory subscribers
    }
  }
  notify();
}

function subscribe(callback: () => void): () => void {
  ensureStorageListener();
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}

/** [currentVariant, setVariant] - re-renders all consumers on change. */
export function useAvatarVariant(): [AvatarVariant, (v: AvatarVariant) => void] {
  const variant = useSyncExternalStore(subscribe, read, () => "dark" as const);
  return [variant, setAvatarVariant];
}
