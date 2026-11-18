// The admin panel signs in through auth.cubityfir.st as its own OIDC client:
// /api/auth/login (admin worker) -> identity service -> /api/auth/callback ->
// /auth/complete#code=... (AuthCallbackPage) -> POST /api/auth/exchange.

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
