const DOCS_LOGIN_URL = import.meta.env.DEV
  ? "http://localhost:5173/login"
  : "https://docs.cubityfir.st/login";

export function normalizeAdminNextPath(nextPath: string | null | undefined): string {
  if (!nextPath || !nextPath.startsWith("/")) {
    return "/";
  }
  // Protocol-relative forms ("//evil.com", "/\evil.com") are not an open
  // redirect (React Router throws on the cross-origin resolve) but that
  // throw would wedge the callback page after a successful exchange.
  if (nextPath.startsWith("//") || nextPath.startsWith("/\\")) {
    return "/";
  }

  return nextPath;
}

export function buildAdminCallbackUrl(nextPath: string, origin = window.location.origin): string {
  const url = new URL("/auth/callback", origin);
  const normalizedNextPath = normalizeAdminNextPath(nextPath);

  if (normalizedNextPath !== "/") {
    url.searchParams.set("next", normalizedNextPath);
  }

  return url.toString();
}

export function buildDocsAdminLoginUrl(
  nextPath: string,
  options?: { logout?: boolean; origin?: string },
): string {
  const url = new URL(DOCS_LOGIN_URL);
  url.searchParams.set("returnTo", buildAdminCallbackUrl(nextPath, options?.origin));

  if (options?.logout) {
    url.searchParams.set("logout", "1");
  }

  return url.toString();
}
