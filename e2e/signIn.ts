import type { Page } from "@playwright/test";

/**
 * Signs a browser page in as a local-dev Annex user without the identity
 * service. Accounts live on auth.cubityfir.st now, so the suites can no
 * longer register through Annex's own forms; this uses the api worker's
 * localhost-only POST /api/dev/quick-login (packages/api/src/routes/auth.ts),
 * which needs `DEV_QUICK_LOGIN=true` and `APP_ORIGIN=http://localhost:5173`
 * in packages/api/.dev.vars.
 *
 * The same email always maps to the same dev user, so a spec can sign the
 * same person back in. Use `e2e-…@example.com` addresses so global-teardown
 * cleans them up.
 */
export async function devSignIn(
  page: Page,
  user: { email: string; name?: string; admin?: boolean },
): Promise<{ token: string; userId: string }> {
  const res = await page.request.post("/api/dev/quick-login", { data: user });
  if (!res.ok()) throw new Error(`dev quick-login failed (${res.status()}): is DEV_QUICK_LOGIN=true set for the api worker?`);
  const { data } = (await res.json()) as { data: { token: string; userId: string } };
  // The SPA keeps its session JWT in localStorage["token"] (src/lib/auth.ts).
  await page.goto("/");
  await page.evaluate(token => window.localStorage.setItem("token", token), data.token);
  return data;
}
