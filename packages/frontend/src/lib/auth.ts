import { isDemoMode, exitDemoMode, DEMO_TOKEN } from "./demo";

const TOKEN_STORAGE_KEY = "token";

function getStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function getToken(): string | null {
  // Demo mode hands out a fake token without touching localStorage, so a real
  // session (if one exists) survives a demo visit untouched.
  if (isDemoMode()) return DEMO_TOKEN;
  return getStorage()?.getItem(TOKEN_STORAGE_KEY) ?? null;
}

export function setToken(token: string): void {
  // A real login always supersedes the demo sandbox.
  exitDemoMode();
  getStorage()?.setItem(TOKEN_STORAGE_KEY, token);
}

export function clearToken(): void {
  // "Logging out" of the demo just exits demo mode - the user's real token
  // (if any) stays put.
  if (isDemoMode()) {
    exitDemoMode();
    return;
  }
  getStorage()?.removeItem(TOKEN_STORAGE_KEY);
}
