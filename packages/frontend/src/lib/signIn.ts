// Sign in / out through auth.cubityfir.st (Annex is an OIDC client).
//
// Sign-in is a top-level navigation to /api/auth/login, which redirects to the
// identity service; it comes back via /api/auth/callback to /auth/complete
// (AuthCompletePage), which redeems a single-use code for Annex's session JWT.

import { clearToken, getToken } from "./auth";
import { isDemoMode } from "./demo";

// Public origin of the identity service, for links to its account pages and
// the /oauth/authorize redirect shim. Overridable for local dev.
export const IDENTITY_ORIGIN: string =
  (import.meta.env.VITE_IDENTITY_ORIGIN as string | undefined)?.replace(/\/+$/, "") || "https://auth.cubityfir.st";

export const IDENTITY_ACCOUNT_URL = `${IDENTITY_ORIGIN}/account`;
export const IDENTITY_SECURITY_URL = `${IDENTITY_ORIGIN}/account/security`;

// Same-origin app paths only: "/x", never "//host", "/\host" or a scheme.
export function safeReturnTo(raw: string | null | undefined): string | null {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return null;
  return raw;
}

export function signInUrl(returnTo?: string | null, opts: { prompt?: "login" } = {}): string {
  const params = new URLSearchParams();
  const safe = safeReturnTo(returnTo);
  if (safe) params.set("return_to", safe);
  if (opts.prompt) params.set("prompt", opts.prompt);
  const qs = params.toString();
  return `/api/auth/login${qs ? `?${qs}` : ""}`;
}

export function startSignIn(returnTo?: string | null, opts: { prompt?: "login" } = {}): void {
  window.location.assign(signInUrl(returnTo, opts));
}

// Revokes the Annex session, then sends the browser to the identity service's
// end-session endpoint (which signs the user out there too and comes back to
// the landing page). Best-effort: the local token is cleared regardless.
export async function signOut(): Promise<void> {
  // Leaving the demo sandbox is local only (clearToken exits demo mode).
  if (isDemoMode()) {
    clearToken();
    window.location.assign("/");
    return;
  }
  const token = getToken();
  let target = "/";
  if (token) {
    try {
      const res = await fetch("/api/auth/logout", { method: "POST", headers: { Authorization: `Bearer ${token}` } });
      const json = (await res.json()) as { ok?: boolean; data?: { logoutUrl?: string } };
      if (json.ok && json.data?.logoutUrl) target = json.data.logoutUrl;
    } catch {
      // Offline or the API is down: still clear the local session.
    }
  }
  clearToken();
  window.location.assign(target);
}

// Human copy for the error codes /api/auth/callback can hand back.
export function signInErrorMessage(code: string | null): string {
  const contact = "Please email docs@cubityfir.st for further details.";
  switch (code) {
    case "access_denied":
      return "Sign-in was cancelled.";
    case "login_expired":
    case "invalid_code":
      return "That sign-in took too long or was already used. Please try again.";
    case "account_disabled":
      return `Your Annex account has been disabled. ${contact}`;
    case "account_deleted":
      return "This account has been deleted.";
    case "identity_unavailable":
      return "The sign-in service is unavailable right now. Please try again in a moment.";
    default:
      return "Sign-in didn't complete. Please try again.";
  }
}
