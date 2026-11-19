/**
 * Admin panel e2e smoke: sign in -> auto-loaded user search -> open a
 * details sheet -> audited action visible in the audit log -> sign out.
 *
 * Needs the FULL dev stack (`pnpm dev` at the repo root): docs frontend 5173,
 * api 8787, admin worker 8789, and the admin frontend on 5174. The whole file
 * self-skips when the admin frontend isn't reachable.
 *
 * Auth: the admin panel signs in through auth.cubityfir.st (its own OIDC
 * client). Locally the suite skips the identity service with the admin
 * worker's localhost-only POST /api/dev/quick-login, which needs
 * `DEV_QUICK_LOGIN=true` and `APP_ORIGIN=http://localhost:5174` in
 * packages/admin/.dev.vars. It mints an admin dev user and an admin session.
 */

import { test, expect, request as pwRequest, type Page } from "@playwright/test";

const ADMIN_ORIGIN = "http://localhost:5174";
const RUN_ID = Date.now();

async function adminFrontendUp(): Promise<boolean> {
  const ctx = await pwRequest.newContext();
  try {
    const res = await ctx.get(ADMIN_ORIGIN, { timeout: 3000 });
    return res.ok();
  } catch {
    return false;
  } finally {
    await ctx.dispose();
  }
}

// Mints an admin session and hands it to the admin SPA, which keeps it in
// sessionStorage["admin_token"] (src/lib/auth.ts).
async function signInToAdmin(page: Page, email: string): Promise<{ token: string; userId: string }> {
  const res = await page.request.post(`${ADMIN_ORIGIN}/api/dev/quick-login`, { data: { email, name: "E2E Admin" } });
  expect(res.ok(), "admin dev quick-login must be enabled locally (DEV_QUICK_LOGIN=true in packages/admin/.dev.vars)").toBeTruthy();
  const { data } = (await res.json()) as { data: { token: string; userId: string } };
  await page.goto(ADMIN_ORIGIN);
  await page.evaluate(token => window.sessionStorage.setItem("admin_token", token), data.token);
  await page.goto(ADMIN_ORIGIN);
  await expect(page.getByRole("heading", { name: "Users" })).toBeVisible({ timeout: 15_000 });
  return data;
}

test.describe("admin panel", () => {
  test.beforeEach(async () => {
    test.skip(!(await adminFrontendUp()), "admin frontend (5174) is not running - start the full dev stack");
  });

  test("sign in → auto-loaded search → details sheet → audited action in the log", async ({ page }) => {
    const email = `e2e-admin-${RUN_ID}-a@example.com`;
    const { userId } = await signInToAdmin(page, email);

    // AF-U1: the user list auto-loads without a search being submitted, and
    // the freshly minted dev admin is on page 1 (newest first). Address this
    // run's row by its email: parallel specs mint users too.
    const ownRow = page.locator("table tbody tr", { hasText: email });
    await expect(ownRow).toBeVisible();

    // Expand this user's row (the only expanded one) and open the details sheet.
    await ownRow.click();
    await page.getByRole("button", { name: "User details" }).click();
    await expect(page.getByText("Profile Badges").first()).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press("Escape");

    // An audited action shows up in the audit log.
    await page.getByRole("button", { name: "Resync display name" }).first().click();
    await expect(page.getByText(/Display name/).first()).toBeVisible({ timeout: 10_000 });
    await page.getByRole("link", { name: "Audit" }).click();
    await expect(page.getByRole("heading", { name: "Audit Log" })).toBeVisible();
    // This run's entry: this actor, this target, this action.
    const entry = page.locator("table tbody tr", { hasText: `user:${userId}` })
      .filter({ hasText: "User · Name · Resync" })
      .filter({ hasText: email });
    await expect(entry.first()).toBeVisible({ timeout: 10_000 });
  });

  test("sign out revokes the session server-side (AF-S3)", async ({ page }) => {
    await signInToAdmin(page, `e2e-admin-${RUN_ID}-b@example.com`);

    // The SPA keeps the admin token in sessionStorage, never localStorage (AF-S1).
    const adminToken = await page.evaluate(() => window.sessionStorage.getItem("admin_token"));
    expect(adminToken).toBeTruthy();
    expect(await page.evaluate(() => window.localStorage.getItem("admin_token"))).toBeNull();

    const [logoutResponse] = await Promise.all([
      page.waitForResponse(r => r.url().includes("/api/auth/logout")),
      page.getByRole("button", { name: "Sign out" }).click(),
    ]);
    expect(logoutResponse.ok()).toBeTruthy();

    // A copied token must be dead after sign-out, not valid until its TTL.
    const ctx = await pwRequest.newContext({ baseURL: ADMIN_ORIGIN });
    try {
      const res = await ctx.get("/api/verify", { headers: { Authorization: `Bearer ${adminToken}` } });
      expect(res.status()).toBe(401);
    } finally {
      await ctx.dispose();
    }
  });
});
