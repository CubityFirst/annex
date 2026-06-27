/**
 * E2E test for per-document settings.
 *
 * Prerequisites - run from the monorepo root before starting tests:
 *   pnpm dev
 *
 * Covers:
 *   - Toggling "Show page heading" hides/restores the rendered <h1>
 *   - Toggling "Show last updated" hides/restores the "Last updated · X min read" line
 *   - Frontmatter `hide_title: true` overrides the show_heading setting
 *   - The document settings dialog opens via the gear button in the toolbar
 */

import { test, expect, type BrowserContext, type Page } from "@playwright/test";

const RUN_ID = Date.now();
const EMAIL = `e2e-docset-${RUN_ID}@example.com`;
const PASSWORD = "E2eTest-P@ssw0rd!";
const NAME = "E2E DocSettings User";
const PROJECT_NAME = `E2E Project DocSettings ${RUN_ID}`;
const FAKE_IP = `10.${Math.floor(RUN_ID / 1e10) % 256}.${Math.floor(RUN_ID / 1e7) % 256}.${(RUN_ID + 12) % 256}`;

let context: BrowserContext;
let page: Page;
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

async function injectFakeIp(ctx: BrowserContext) {
  await ctx.route("**/api/**", async (route) => {
    await route.continue({ headers: { ...route.request().headers(), "CF-Connecting-IP": FAKE_IP } });
  });
}

async function putDoc(p: Page, id: string, title: string, content: string) {
  // Local wrangler dev intermittently drops requests through the
  // browser → vite → API worker → auth worker chain (per playwright.config.ts).
  // Retry once on 500 so transient infra hiccups don't cause spurious failures.
  const result = await p.evaluate(async ({ id, title, content }) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = localStorage.getItem("token");
      const res = await fetch(`/api/docs/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ title, content }),
      });
      if (res.status === 200) return 200;
      if (attempt === 0 && res.status >= 500) {
        await new Promise(r => setTimeout(r, 300));
        continue;
      }
      return res.status;
    }
    return 0;
  }, { id, title, content });
  if (result !== 200) throw new Error(`PUT /docs/${id} failed: ${result}`);
}

async function openDocSettings(p: Page) {
  await p.getByRole("button", { name: "Document settings" }).click();
  await expect(p.getByRole("dialog", { name: "Document Settings" })).toBeVisible({ timeout: 5000 });
}

async function closeDocSettings(p: Page) {
  await p.keyboard.press("Escape");
  await expect(p.getByRole("dialog", { name: "Document Settings" })).not.toBeVisible({ timeout: 5000 });
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext();
  await mockTurnstile(context);
  await injectFakeIp(context);
  page = await context.newPage();
});

test.afterAll(async () => {
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

test("sets up a project + doc", async () => {
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

  await putDoc(page, docId, "Settings Doc", "# Heading from body\n\nBody content here.");
  await page.goto(`/projects/${projectId}/docs/${docId}`);
  await expect(page.locator(".cm-content")).toBeVisible({ timeout: 10000 });
});

test("toggling 'Show page heading' off hides the rendered <h1>", async () => {
  await expect(page.locator("article").first().getByRole("heading", { name: "Settings Doc", level: 1 })).toBeVisible();

  await openDocSettings(page);
  await page.locator("#show-heading").click();
  // Wait for the toggle to settle (it dispatches a PATCH then re-renders).
  await expect(page.locator("#show-heading[data-state='unchecked']")).toBeVisible({ timeout: 5000 });
  await closeDocSettings(page);

  // The synthesised <h1 data-pdf-title> is what the toggle controls.
  await expect(page.locator("article [data-pdf-title]")).toHaveCount(0);

  // Re-open and toggle back on; the heading returns.
  await openDocSettings(page);
  await page.locator("#show-heading").click();
  await expect(page.locator("#show-heading[data-state='checked']")).toBeVisible({ timeout: 5000 });
  await closeDocSettings(page);
  await expect(page.locator("article [data-pdf-title]")).toBeVisible({ timeout: 5000 });
});

test("toggling 'Show last updated' off hides the metadata line", async () => {
  await expect(page.locator("article [data-pdf-last-updated]")).toBeVisible();

  await openDocSettings(page);
  await page.locator("#show-last-updated").click();
  await expect(page.locator("#show-last-updated[data-state='unchecked']")).toBeVisible({ timeout: 5000 });
  await closeDocSettings(page);

  await expect(page.locator("article [data-pdf-last-updated]")).toHaveCount(0);

  await openDocSettings(page);
  await page.locator("#show-last-updated").click();
  await expect(page.locator("#show-last-updated[data-state='checked']")).toBeVisible({ timeout: 5000 });
  await closeDocSettings(page);
  await expect(page.locator("article [data-pdf-last-updated]")).toBeVisible({ timeout: 5000 });
});

test("frontmatter hide_title: true overrides the show_heading setting", async () => {
  await putDoc(
    page,
    docId,
    "Settings Doc",
    "---\ntitle: From Frontmatter\nhide_title: true\n---\n\nBody only.",
  );
  await page.reload();
  await expect(page.locator(".cm-content")).toBeVisible({ timeout: 10000 });

  // hide_title: true wins over the show_heading switch.
  await expect(page.locator("article [data-pdf-title]")).toHaveCount(0);
});
