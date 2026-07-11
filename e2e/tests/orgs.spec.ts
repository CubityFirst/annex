/**
 * E2E tests for the Organizations lifecycle: create an org, create a site inside
 * it, invite a member, accept (role trickles down to the org's sites), rename,
 * and delete the org (which detaches but KEEPS the site).
 *
 * Prerequisites:
 *   pnpm dev  (from the monorepo root)
 *   packages/auth/.dev.vars: DEV_QUICK_LOGIN=true   (+ APP_ORIGIN=http://localhost:5173)
 *
 * Accounts are created via the dev quick-login panel on /login (the project's
 * credential-free localhost dev shortcut) rather than the register form, so the
 * suite is independent of the Flagship "signup" flag. Both accounts are removed
 * in globalTeardown; the site is deleted by the test body / afterAll.
 */

import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";

// ── Unique-per-run values ────────────────────────────────────────────────────

const RUN_ID = Date.now();
const ORG_NAME = `Org Test ${RUN_ID}`;
const ORG_RENAMED = `Org Renamed ${RUN_ID}`;
const SITE_NAME = `Org Site ${RUN_ID}`;

function fakeIp(offset: number) {
  return `10.${Math.floor(RUN_ID / 1e10) % 256}.${Math.floor(RUN_ID / 1e7) % 256}.${(RUN_ID + offset) % 256}`;
}

// ── Shared state ──────────────────────────────────────────────────────────────

let ownerCtx: BrowserContext,  ownerPage: Page;
let memberCtx: BrowserContext, memberPage: Page;

let memberEmail = "";
let orgId = "";
let siteId = "";

// ── Helpers ───────────────────────────────────────────────────────────────────

async function setupContext(browser: Browser, ip: string): Promise<[BrowserContext, Page]> {
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => {
    Object.defineProperty(window, "turnstile", {
      value: {
        render(_: unknown, opts: { callback: (t: string) => void }) {
          setTimeout(() => opts.callback("e2e-bypass-token"), 50);
          return "mock-widget-id";
        },
        reset() {},
        remove() {},
      },
      writable: true,
      configurable: true,
    });
  });
  await ctx.route("**/api/**", async (route) => {
    await route.continue({ headers: { ...route.request().headers(), "CF-Connecting-IP": ip } });
  });
  return [ctx, await ctx.newPage()];
}

// Logs in via the DEV-only quick-login panel and returns the freshly-minted dev
// user's email (decoded from the returned JWT — quick-login creates a random
// dev-<hex>@localhost account each time).
async function devLogin(page: Page): Promise<string> {
  await page.goto("/login?logout=1");
  const respPromise = page.waitForResponse(
    r => r.url().includes("/api/dev/quick-login") && r.request().method() === "POST",
  );
  // First "Free" button is the Standard (non-admin) row.
  await page.getByRole("button", { name: "Free", exact: true }).first().click();
  const resp = await respPromise;
  const body = await resp.json() as { ok: boolean; data: { token: string } };
  expect(body.ok).toBe(true);
  await expect(page).not.toHaveURL(/\/login/, { timeout: 10000 });
  const payload = JSON.parse(Buffer.from(body.data.token.split(".")[1], "base64").toString()) as { email: string };
  return payload.email;
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  [ownerCtx,  ownerPage]  = await setupContext(browser, fakeIp(6));
  [memberCtx, memberPage] = await setupContext(browser, fakeIp(7));
});

// Best-effort cleanup of the surviving site via the API (more reliable than the
// settings-page UI flow). Account cleanup runs in globalTeardown.
test.afterAll(async () => {
  if (siteId) {
    try {
      const token = await ownerPage.evaluate(() => localStorage.getItem("token"));
      if (token) {
        await ownerPage.request.fetch(`http://localhost:5173/api/projects/${siteId}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` },
        });
      }
    } catch {}
  }
  for (const ctx of [ownerCtx, memberCtx]) {
    try { await ctx.close(); } catch { /* already closed on failure */ }
  }
});

// ── Sign in (dev) ───────────────────────────────────────────────────────────────

test("owner signs in", async () => {
  await devLogin(ownerPage);
});

test("member signs in", async () => {
  memberEmail = await devLogin(memberPage);
  expect(memberEmail).toContain("@");
});

// ── Owner: create the org ───────────────────────────────────────────────────────

test("owner creates an organization", async () => {
  await ownerPage.goto("/dashboard");
  await ownerPage.getByRole("button", { name: "New organization" }).click();
  await expect(ownerPage.getByRole("dialog")).toBeVisible({ timeout: 5000 });
  await ownerPage.getByLabel("Name").fill(ORG_NAME);
  await ownerPage.getByRole("button", { name: "Create organization" }).click();
  await expect(ownerPage).toHaveURL(/\/orgs\/[a-z0-9-]+/, { timeout: 10000 });
  orgId = ownerPage.url().match(/\/orgs\/([a-z0-9-]+)/)?.[1] ?? "";
  expect(orgId).not.toBe("");
  await expect(ownerPage.getByRole("heading", { name: ORG_NAME })).toBeVisible({ timeout: 5000 });
  await expect(ownerPage.getByText("No sites in this organization yet")).toBeVisible({ timeout: 5000 });
});

// ── Owner: create a site inside the org ─────────────────────────────────────────

test("owner creates a site inside the org", async () => {
  await ownerPage.goto(`/orgs/${orgId}`);
  await ownerPage.getByRole("button", { name: "New site" }).click();
  await expect(ownerPage.getByRole("dialog")).toBeVisible({ timeout: 5000 });
  await ownerPage.getByLabel("Name").fill(SITE_NAME);
  // Retry: the local wrangler chain can drop the create-site POST under
  // full-suite load; the dialog stays open on failure, so re-clicking is safe.
  await expect(async () => {
    await ownerPage.getByRole("button", { name: "Create site" }).click();
    await expect(ownerPage).toHaveURL(/\/projects\/[a-z0-9-]+/, { timeout: 8000 });
  }).toPass({ timeout: 30000 });
  siteId = ownerPage.url().match(/\/projects\/([a-z0-9-]+)/)?.[1] ?? "";
  expect(siteId).not.toBe("");
});

test("the new site shows on the org page", async () => {
  await ownerPage.goto(`/orgs/${orgId}`);
  // Scope to the card heading — the site name also appears in the project sidebar.
  await expect(ownerPage.getByRole("heading", { name: SITE_NAME })).toBeVisible({ timeout: 5000 });
});

// ── Owner: invite a member to the org ───────────────────────────────────────────

test("owner invites a member to the org", async () => {
  await ownerPage.goto(`/orgs/${orgId}/settings`);
  await ownerPage.getByPlaceholder("teammate@example.com").fill(memberEmail);
  await ownerPage.getByRole("button", { name: "Invite" }).click();
  await expect(ownerPage.getByText(`Invite sent to ${memberEmail}.`, { exact: true })).toBeVisible({ timeout: 8000 });
  await expect(ownerPage.getByText("Pending", { exact: true })).toBeVisible({ timeout: 5000 });
});

test("member sees and accepts the org invite", async () => {
  await memberPage.goto("/invites/pending");
  await expect(memberPage.getByRole("heading", { name: "Pending Invites" })).toBeVisible({ timeout: 5000 });
  // The pending-invites fetch or the accept POST can get dropped by the local
  // wrangler chain under full-suite load - reload / re-click until it lands.
  await expect(async () => {
    if (!(await memberPage.getByText(ORG_NAME).isVisible().catch(() => false))) {
      await memberPage.reload();
    }
    await expect(memberPage.getByText(ORG_NAME)).toBeVisible({ timeout: 5000 });
    await memberPage.getByRole("button", { name: "Accept" }).click({ timeout: 3000 });
    await expect(memberPage).toHaveURL(new RegExp(`/orgs/${orgId}`), { timeout: 8000 });
  }).toPass({ timeout: 30000 });
});

test("role trickles down: member can see and open the org's site", async () => {
  await memberPage.goto(`/orgs/${orgId}`);
  await expect(memberPage.getByRole("heading", { name: SITE_NAME })).toBeVisible({ timeout: 5000 });
  await memberPage.goto(`/projects/${siteId}`);
  await expect(memberPage).toHaveURL(new RegExp(`/projects/${siteId}`), { timeout: 8000 });
  await expect(memberPage).not.toHaveURL(/\/(dashboard|login)/);
});

// ── Owner: rename the org ───────────────────────────────────────────────────────

test("owner renames the org", async () => {
  await ownerPage.goto(`/orgs/${orgId}/settings`);
  await ownerPage.getByLabel("Name").first().fill(ORG_RENAMED);
  await ownerPage.getByRole("button", { name: "Save" }).click();
  await expect(ownerPage.getByText("Organization renamed.", { exact: true })).toBeVisible({ timeout: 5000 });
});

// ── Owner: delete the org (site survives) ────────────────────────────────────────

test("owner deletes the org and the site survives", async () => {
  await ownerPage.goto(`/orgs/${orgId}/settings`);
  await ownerPage.getByRole("button", { name: "Delete organization" }).click();
  await expect(ownerPage.getByRole("alertdialog")).toBeVisible({ timeout: 5000 });
  await ownerPage.getByRole("button", { name: "Yes, delete" }).click();
  await expect(ownerPage).toHaveURL(/\/dashboard/, { timeout: 10000 });
  await expect(ownerPage.getByRole("heading", { name: SITE_NAME })).toBeVisible({ timeout: 5000 });
  orgId = "";
});

// The surviving site is removed in afterAll via the API (see above); account
// cleanup runs in globalTeardown.
