// Resumes an interrupted "Sign in with Annex" flow across the signup path.
//
// When OAuthAuthorizePage bounces an unauthenticated visitor to /login, the
// ?next= param survives a straight sign-in but dies the moment the user
// detours through Sign up → check-email → the verification link (a fresh tab
// with no query context). Stashing the authorize URL in localStorage lets the
// first session mint - wherever it happens in the same browser profile - send
// the user back to complete the OAuth handshake.
//
// The stash is single-use (consume clears it) and expires after an hour: by
// then the connected service has almost certainly abandoned its pending
// request, and landing on the dashboard beats a surprise redirect days later.

const PENDING_OAUTH_KEY = "pendingOAuthNext";
const TTL_MS = 60 * 60 * 1000;

function getStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

// Only the authorize page's own URL is ever stashed; enforcing that on both
// write and read keeps a tampered value from redirecting anywhere else.
function isAuthorizePath(path: string): boolean {
  return path.startsWith("/oauth/authorize");
}

export function storePendingOAuthNext(path: string): void {
  if (!isAuthorizePath(path)) return;
  getStorage()?.setItem(PENDING_OAUTH_KEY, JSON.stringify({ next: path, expiresAt: Date.now() + TTL_MS }));
}

export function consumePendingOAuthNext(): string | null {
  const storage = getStorage();
  const raw = storage?.getItem(PENDING_OAUTH_KEY);
  if (!storage || !raw) return null;
  storage.removeItem(PENDING_OAUTH_KEY);
  try {
    const parsed = JSON.parse(raw) as { next?: unknown; expiresAt?: unknown };
    if (typeof parsed.next !== "string" || !isAuthorizePath(parsed.next)) return null;
    if (typeof parsed.expiresAt !== "number" || parsed.expiresAt < Date.now()) return null;
    return parsed.next;
  } catch {
    return null;
  }
}

export function clearPendingOAuthNext(): void {
  getStorage()?.removeItem(PENDING_OAUTH_KEY);
}
