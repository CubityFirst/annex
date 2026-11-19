// The admin panel signs in through auth.cubityfir.st as its own OIDC client:
// /api/auth/login (admin worker) -> identity service -> /api/auth/callback ->
// /auth/complete#status=ok (AuthCallbackPage) -> POST /api/auth/exchange
// (redeems the HttpOnly handoff cookie the callback set).

export function normalizeAdminNextPath(nextPath: string | null | undefined): string {
  if (!nextPath || !nextPath.startsWith("/")) {
    return "/";
  }
  // Protocol-relative forms ("//evil.com", "/\evil.com") would be refused by
  // the worker anyway; normalizing here keeps the complete page from wedging.
  if (nextPath.startsWith("//") || nextPath.startsWith("/\\")) {
    return "/";
  }

  return nextPath;
}

export function adminSignInUrl(nextPath: string, opts: { prompt?: "login" } = {}): string {
  const params = new URLSearchParams();
  const next = normalizeAdminNextPath(nextPath);
  if (next !== "/") params.set("return_to", next);
  if (opts.prompt) params.set("prompt", opts.prompt);
  const qs = params.toString();
  return `/api/auth/login${qs ? `?${qs}` : ""}`;
}

// Where to land after a completed sign-in. The completion page records it;
// App reads it once the session is verified (the page itself is unmounted by
// App's verification screen, so it can't navigate there itself).
const POST_SIGN_IN_KEY = "admin_post_sign_in";

export function rememberPostSignIn(nextPath: string): void {
  try {
    window.sessionStorage.setItem(POST_SIGN_IN_KEY, normalizeAdminNextPath(nextPath));
  } catch {
    /* storage unavailable - fall back to "/" */
  }
}

export function postSignInPath(): string {
  try {
    return normalizeAdminNextPath(window.sessionStorage.getItem(POST_SIGN_IN_KEY));
  } catch {
    return "/";
  }
}

export function signInErrorMessage(code: string | null): string {
  switch (code) {
    case "not_admin":
      return "This account does not have admin access. Admin access is granted on auth.cubityfir.st.";
    case "access_denied":
      return "Sign-in was cancelled.";
    case "account_disabled":
      return "This account is blocked from Annex.";
    case "login_expired":
    case "invalid_code":
      return "That sign-in took too long or was already used. Please try again.";
    case "identity_unavailable":
      return "The sign-in service is unavailable right now. Please try again in a moment.";
    default:
      return "Admin sign-in didn't complete. Please try again.";
  }
}
