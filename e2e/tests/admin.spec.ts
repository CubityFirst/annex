/**
 * Admin panel e2e smoke: login handoff -> auto-loaded user search -> open a
 * details sheet -> audited mutation visible in the audit log.
 *
 * Needs the FULL dev stack (`pnpm dev` at the repo root): docs frontend 5173,
 * api 8787, auth 8788, admin worker 8789, and the admin frontend on 5174.
 * The whole file self-skips when the admin frontend isn't reachable, so the
 * standard suite (which only assumes 5173/8787/8788) is unaffected.
 *
 * Auth: mints a dev admin via the auth worker's quick-login (DEV_QUICK_LOGIN),
 * then drives the real handoff flow - POST /api/admin/handoff/start on the
 * docs origin, follow redirectTo to the admin /auth/callback, and let the SPA
 * exchange the single-use code. This exercises the handoff audit rows
 * (admin.handoff.start/exchange) end-to-end.
 */

import { test, expect, request as pwRequest, type Page } from "@playwright/test";

const ADMIN_ORIGIN = "http://localhost:5174";
const DOCS_ORIGIN = "http://localhost:5173";

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

// Mint a fresh dev admin account and return its bearer token.
async function mintDevAdminToken(): Promise<string> {
  const ctx = await pwRequest.newContext({ baseURL: DOCS_ORIGIN });
  try {
    const res = await ctx.post("/api/dev/quick-login", {
      data: { variant: "admin-free" },
    });
    expect(res.ok(), "dev quick-login must be enabled locally (DEV_QUICK_LOGIN=true)").toBeTruthy();
    const json = (await res.json()) as { data?: { token?: string }; token?: string };
    const token = json.data?.token ?? json.token;
    expect(token, "quick-login response should carry a token").toBeTruthy();
    return token!;
  } finally {
    await ctx.dispose();
  }
}

// Drive the real handoff: start it as the signed-in docs user, then let the
// admin SPA consume the code at /auth/callback.
async function signInToAdmin(page: Page, token: string): Promise<void> {
  const ctx = await pwRequest.newContext({ baseURL: DOCS_ORIGIN });
  let redirectTo: string;
  try {
    const res = await ctx.post("/api/admin/handoff/start", {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      data: { returnTo: `${ADMIN_ORIGIN}/auth/callback` },
    });
    expect(res.ok(), "handoff start should succeed for an admin session").toBeTruthy();
    const json = (await res.json()) as { data: { redirectTo: string } };
    redirectTo = json.data.redirectTo;
  } finally {
    await ctx.dispose();
  }

  await page.goto(redirectTo);
  // The SPA exchanges the code, stores the (sessionStorage) token, and lands
  // on the Users dashboard.
  await expect(page.getByRole("heading", { name: "Users" })).toBeVisible({ timeout: 15_000 });
}

test.describe("admin panel", () => {
  test.beforeEach(async () => {
    test.skip(!(await adminFrontendUp()), "admin frontend (5174) is not running - start the full dev stack");
  });

  test("handoff login → auto-loaded search → details sheet → audited actions in the log", async ({ page }) => {
    const token = await mintDevAdminToken();
    await signInToAdmin(page, token);

    // AF-U1: the user list auto-loads without a search being submitted, and
    // the freshly minted dev admin is newest-first on page 1.
    const firstRow = page.locator("table tbody tr").first();
    await expect(firstRow).toBeVisible();
    await expect(page.getByText(/dev-[0-9a-f]+@localhost/).first()).toBeVisible();

    // Expand the newest user's row and open the details sheet.
    await firstRow.click();
    await page.getByRole("button", { name: "User details" }).click();
    await expect(page.getByText("Moderation History")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Profile Badges")).toBeVisible();
    await page.keyboard.press("Escape");

    // The handoff itself must be audited (AB-M2): the exchange that signed
    // us in is the newest entry in the audit log.
    await page.getByRole("link", { name: "Audit" }).click();
    await expect(page.getByRole("heading", { name: "Audit Log" })).toBeVisible();
    await expect(page.getByText("Admin · Handoff · Exchange").first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Admin · Handoff · Start").first()).toBeVisible();
  });

  test("sign out revokes the session server-side (AF-S3)", async ({ page }) => {
    const token = await mintDevAdminToken();
    await signInToAdmin(page, token);

    // Capture the admin token the SPA is actually using (sessionStorage now,
    // not localStorage - AF-S1).
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
      const res = await ctx.get("/api/verify", {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      expect(res.status()).toBe(401);
    } finally {
      await ctx.dispose();
    }
  });
});
