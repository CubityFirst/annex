/**
 * E2E test for project ZIP export.
 *
 * Prerequisites - run from the monorepo root before starting tests:
 *   pnpm dev
 *
 * Covers:
 *   - Owner can export the entire project as a .zip from site settings
 *   - The returned zip is a valid PK-prefixed archive
 *   - Body contains the markdown filename(s) of created docs
 *   - Folder structure is preserved in entry paths
 */

import { test, expect, type BrowserContext, type Page } from "@playwright/test";

const RUN_ID = Date.now();
const EMAIL = `e2e-exp-${RUN_ID}@example.com`;
const PASSWORD = "E2eTest-P@ssw0rd!";
const NAME = "E2E Export User";
const PROJECT_NAME = `E2E Project Export ${RUN_ID}`;
const FAKE_IP = `10.${Math.floor(RUN_ID / 1e10) % 256}.${Math.floor(RUN_ID / 1e7) % 256}.${(RUN_ID + 11) % 256}`;

let context: BrowserContext;
let page: Page;
let projectId = "";
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

test("sets up a project with two docs (root + folder)", async () => {
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

  // Root-level doc.
  await page.getByRole("button", { name: "New document" }).click();
  await expect(page).toHaveURL(/\/projects\/.+\/docs\/.+/, { timeout: 10000 });
  const rootDocId = page.url().match(/\/docs\/([a-z0-9-]+)/)![1];
  await page.evaluate(async ({ id }) => {
    const token = localStorage.getItem("token");
    await fetch(`/api/docs/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ title: "Root Doc", content: "# Root\n\nRoot body." }),
    });
  }, { id: rootDocId });

  // Folder + doc inside.
  await page.goto(`/projects/${projectId}`);
  await page.getByRole("button", { name: "New folder" }).click();
  const folderInput = page.getByPlaceholder("Folder name");
  await expect(folderInput).toBeVisible({ timeout: 5000 });
  await folderInput.fill("Notes");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByText("Notes")).toBeVisible({ timeout: 5000 });

  await page.getByText("Notes").click();
  await page.getByRole("button", { name: "New document" }).click();
  await expect(page).toHaveURL(/\/projects\/.+\/docs\/.+/, { timeout: 10000 });
  const folderDocId = page.url().match(/\/docs\/([a-z0-9-]+)/)![1];
  await page.evaluate(async ({ id }) => {
    const token = localStorage.getItem("token");
    await fetch(`/api/docs/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ title: "Inner Doc", content: "Inner body." }),
    });
  }, { id: folderDocId });
});

test("the Export site button downloads a valid zip containing both docs", async () => {
  await page.goto(projectSettingsUrl);
  await expect(page.getByRole("button", { name: /export site/i })).toBeVisible({ timeout: 5000 });

  // The export endpoint streams a zip; we fetch it directly from the page
  // context (so cookies/bearer token are attached) and verify the bytes.
  const result = await page.evaluate(async ({ projectId }) => {
    const token = localStorage.getItem("token");
    const res = await fetch(`/api/projects/${projectId}/export`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return { status: res.status, ok: false };
    const buf = await res.arrayBuffer();
    return { status: res.status, ok: true, bytes: Array.from(new Uint8Array(buf)) };
  }, { projectId });

  expect(result.status).toBe(200);
  expect(result.ok).toBe(true);

  const bytes = new Uint8Array(result.bytes!);
  // Zip files always start with the local file header signature "PK\x03\x04".
  expect(bytes[0]).toBe(0x50);
  expect(bytes[1]).toBe(0x4B);
  expect(bytes[2]).toBe(0x03);
  expect(bytes[3]).toBe(0x04);

  // Filenames are stored literally in local file headers. Grep the byte
  // stream as ASCII for the two doc names + the folder prefix.
  const asString = Buffer.from(bytes).toString("binary");
  expect(asString).toContain("Root Doc.md");
  expect(asString).toContain("Inner Doc.md");
  // The Inner Doc is inside a "Notes" folder, so its entry path is prefixed.
  expect(asString).toContain("Notes/Inner Doc.md");
});
