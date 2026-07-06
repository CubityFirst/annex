const TOKEN_STORAGE_KEY = "admin_token";
export const ADMIN_AUTH_INVALIDATED_EVENT = "admin-auth-invalidated";

// sessionStorage, deliberately: the admin JWT is the highest-privilege
// credential in the product, so it should die with the tab instead of
// sitting on disk for its full TTL where any XSS (or a shared machine)
// could lift a still-valid copy. Re-auth is one silent handoff redirect.
function getStorage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

// One-time cleanup: earlier builds persisted the token in localStorage for
// its full 7-day TTL. Remove any leftover copy so it can't be exfiltrated.
try {
  window.localStorage.removeItem(TOKEN_STORAGE_KEY);
} catch {
  /* storage unavailable (private mode / disabled) - nothing to clean */
}

export function getToken(): string | null {
  return getStorage()?.getItem(TOKEN_STORAGE_KEY) ?? null;
}

export function setToken(token: string): void {
  getStorage()?.setItem(TOKEN_STORAGE_KEY, token);
}

export function clearToken(): void {
  getStorage()?.removeItem(TOKEN_STORAGE_KEY);
}

export function invalidateAdminSession(): void {
  clearToken();
  window.dispatchEvent(new CustomEvent(ADMIN_AUTH_INVALIDATED_EVENT));
}
