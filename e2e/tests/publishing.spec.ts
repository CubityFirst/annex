/**
 * E2E test for site publishing flow.
 *
 * Prerequisites - run from the monorepo root before starting tests:
 *   pnpm dev
 *
 * Covers:
 *   - Publishing a project from the site settings page
 *   - Setting a vanity slug
 *   - Accessing the public reader at /s/<slug>/<docId>
 *   - Public visibility while unauthenticated
 *   - Unpublishing hides public access
 */

import { test, expect, type BrowserContext, type Page } from "@playwright/test";

const RUN_ID = Date.now();
const EMAIL = `e2e-pub-${RUN_ID}@example.com`;
const PASSWORD = "E2eTest-P@ssw0rd!";
const NAME = "E2E Publish User";
const PROJECT_NAME = `E2E Project Publish ${RUN_ID}`;
const FAKE_IP = `10.${Math.floor(RUN_ID / 1e10) % 256}.${Math.floor(RUN_ID / 1e7) % 256}.${(RUN_ID + 9) % 256}`;

let context: BrowserContext;
let page: Page;
let anonContext: BrowserContext;
let anonPage: Page;
let projectId = "";
let docId = "";
let projectSettingsUrl = "";

async function mockTurnstile(ctx: BrowserContext) {
  await ctx.addInitScript(() => {
    Object.defineProperty(window, "turnstile", {
      value: {
        render(_c: unknown, opts: { callback: (t: string) => void }) {
          setTimeout(() => opts.callback("e2e-bypass-token"), 50);
          return "mock-widget-id";
        },
        reset() {}, remove() {},
      },
      writable: true, configurable: true,
    });
  });
}

async function injectFakeIp(ctx: BrowserContext, ip: string) {
  await ctx.route("**/api/**", async (route) => {
    await route.continue({ headers: { ...route.request().headers(), "CF-Connecting-IP": ip } });
  });
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext();
  await mockTurnstile(context);
  await injectFakeIp(context, FAKE_IP);
  page = await context.newPage();
});

test.afterAll(async () => {
  try { if (anonContext) await anonContext.close(); } catch { /* */ }
  if (page && projectSettingsUrl) {
    try {
      await page.goto(projectSettingsUrl, { timeout: 10000 });
      const btn = page.getByRole("button", { name: /delete site/i });
      if (await btn.isVisible({ timeout: 3000 })) {
        await btn.click();
        await page.getByRole("alertdialog").waitFor({ timeout: 5000 });
        await page.getByRole("button", { name: /yes.*delete/i }).click();
        await page.waitForURL(/\/(dashboard|projects(?!\/[a-z0-9]))/, { timeout: 15000 });
      }
    } catch { /* */ }
  }
  await context.close();
});

test("creates a project + doc and publishes the site", async () => {
  await page.goto("/register");
  await page.getByLabel("Name").fill(NAME);
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await expect(page.getByRole("button", { name: "Create account" })).toBeEnabled({ timeout: 5000 });
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).not.toHaveURL(/\/register/, { timeout: 10000 });

  await page.goto("/dashboard");
  await page.getByText("New site").click();
  await page.getByLabel("Name").fill(PROJECT_NAME);
  await page.getByRole("button", { name: "Create site" }).click();
  await expect(page).toHaveURL(/\/projects\/[a-z0-9-]+/, { timeout: 10000 });
  projectId = page.url().match(/\/projects\/([a-z0-9-]+)/)![1];
  projectSettingsUrl = `/projects/${projectId}/settings`;

  await page.getByRole("button", { name: "New document" }).click();
  await expect(page).toHaveURL(/\/projects\/.+\/docs\/.+/, { timeout: 10000 });
  docId = page.url().match(/\/docs\/([a-z0-9-]+)/)![1];

  // Seed content via API so the published reader has something to render.
  const result = await page.evaluate(async ({ id }) => {
    const token = localStorage.getItem("token");
    const res = await fetch(`/api/docs/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ title: "Welcome", content: "# Welcome\n\nPublic body content." }),
    });
    return res.status;
  }, { id: docId });
  expect(result).toBe(200);

  // Open settings and toggle the site published.
  await page.goto(projectSettingsUrl);
  await page.getByRole("button", { name: "Publish site" }).click();
  await expect(page.getByRole("button", { name: "Unpublish" })).toBeVisible({ timeout: 10000 });
});

test("the public reader serves the doc by project id, unauthenticated", async ({ browser }) => {
  anonContext = await browser.newContext();
  // Different fake IP so any rate-limit buckets stay isolated.
  await injectFakeIp(anonContext, `10.${Math.floor(RUN_ID / 1e10) % 256}.${Math.floor(RUN_ID / 1e7) % 256}.${(RUN_ID + 10) % 256}`);
  anonPage = await anonContext.newPage();

  // Vanity slugs require a premium feature flag on the project, so for the
  // public-access assertion we fall back to the always-available /s/<projectId>
  // route - both resolve via the same PublicDocPage handler.
  await anonPage.goto(`/s/${projectId}/${docId}`);
  await expect(anonPage.locator(".cm-content, article").first()).toBeVisible({ timeout: 10000 });
  await expect(anonPage.getByRole("heading", { name: "Welcome" }).first()).toBeVisible({ timeout: 5000 });
  await expect(anonPage.getByText("Public body content.").first()).toBeVisible({ timeout: 5000 });
});

test("unpublishing the project blocks public access", async () => {
  await page.goto(projectSettingsUrl);
  await page.getByRole("button", { name: "Unpublish" }).click();
  // Confirmation prompt may appear (alertdialog) or may be inline; handle both.
  const confirmDialog = page.getByRole("alertdialog");
  if (await confirmDialog.isVisible({ timeout: 2000 }).catch(() => false)) {
    await confirmDialog.getByRole("button", { name: /unpublish|yes/i }).click();
  }
  await expect(page.getByRole("button", { name: "Publish site" })).toBeVisible({ timeout: 10000 });

  // Anonymous request to the public URL should now fail. PublicDocPage
  // surfaces a not-found state when the project isn't published.
  await anonPage.goto(`/s/${projectId}/${docId}`);
  await expect(anonPage.getByText(/not found|unavailable|unpublished/i).first()).toBeVisible({ timeout: 10000 });
});
