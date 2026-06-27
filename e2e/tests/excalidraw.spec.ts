/**
 * E2E test for Excalidraw drawing files.
 *
 * Prerequisites - run from the monorepo root before starting tests:
 *   pnpm dev
 *
 * Scenario (single owner):
 *   - Register, create a site.
 *   - Click "New drawing" → lands on the file page with the live Excalidraw
 *     editor mounted (owner = editor, so it's editable with a Save button).
 *   - Draw a rectangle on the canvas, Save, and confirm the saved-state feedback.
 *   - Reload, and assert via the API that the persisted .excalidraw scene now
 *     contains an element (i.e. the UI Save → PUT /files/:id/content round-trip
 *     overwrote the blob).
 *   - Back in the file listing, the drawing appears as a row.
 *
 * The Excalidraw scene renders to a <canvas>, which isn't DOM-assertable, so we
 * verify persistence through the API (the byte-level overwrite + ETag busting is
 * covered by packages/api integration.test.ts).
 */

import { test, expect, type BrowserContext, type Page } from "@playwright/test";

const RUN_ID = Date.now();
const EMAIL = `e2e-excalidraw-${RUN_ID}@example.com`;
const PASSWORD = "E2eTest-P@ssw0rd!";
const NAME = "E2E Excalidraw User";
const PROJECT_NAME = `E2E Excalidraw Site ${RUN_ID}`;
const FAKE_IP = `10.${Math.floor(RUN_ID / 1e10) % 256}.${Math.floor(RUN_ID / 1e7) % 256}.${(RUN_ID + 37) % 256}`;

let context: BrowserContext;
let page: Page;
let projectId = "";
let fileId = "";

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

async function createSite(p: Page, name: string): Promise<string> {
  await p.goto("/dashboard");
  await p.getByText("New site").click();
  await p.getByLabel("Name").fill(name);
  await p.getByRole("button", { name: "Create site" }).click();
  await expect(p).toHaveURL(/\/projects\/[a-z0-9-]+/, { timeout: 10000 });
  return p.url().match(/\/projects\/([a-z0-9-]+)/)![1];
}

// Read a file's stored scene back through the API (owner/member access).
async function readScene(p: Page, id: string): Promise<{ elements?: unknown[] }> {
  return p.evaluate(async (id) => {
    const token = localStorage.getItem("token");
    const res = await fetch(`/api/files/${id}/content`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`content fetch failed: ${res.status}`);
    return res.json();
  }, id);
}

async function deleteSite(p: Page, id: string) {
  try {
    await p.goto(`/projects/${id}/settings`, { timeout: 10000 });
    const btn = p.getByRole("button", { name: /delete site/i });
    if (await btn.isVisible({ timeout: 3000 })) {
      await btn.click();
      await p.getByRole("alertdialog").waitFor({ timeout: 5000 });
      await p.getByRole("button", { name: /yes.*delete/i }).click();
      await p.waitForURL(/\/(dashboard|projects(?!\/[a-z0-9]))/, { timeout: 15000 });
    }
  } catch { /* best-effort cleanup */ }
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext();
  await mockTurnstile(context);
  await injectFakeIp(context);
  page = await context.newPage();
});

test.afterAll(async () => {
  if (page && projectId) await deleteSite(page, projectId);
  try { await context.close(); } catch { /* best-effort */ }
});

test("registers and creates a site", async () => {
  await page.goto("/register");
  await page.getByLabel("Name").fill(NAME);
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await expect(page.getByRole("button", { name: "Create account" })).toBeEnabled({ timeout: 5000 });
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).not.toHaveURL(/\/register/, { timeout: 10000 });

  projectId = await createSite(page, PROJECT_NAME);
  expect(projectId).toBeTruthy();
});

test("'New drawing' creates a .excalidraw file and mounts the editor", async () => {
  await page.goto(`/projects/${projectId}`);
  await page.getByRole("button", { name: "New drawing" }).click();

  // Navigates to the file page for the new drawing.
  await expect(page).toHaveURL(/\/projects\/.+\/files\/.+/, { timeout: 15000 });
  fileId = page.url().match(/\/files\/([a-z0-9-]+)/)![1];
  expect(fileId).toBeTruthy();

  // The live Excalidraw editor mounts (lazy chunk loads), with an (initially
  // disabled) Save button from our toolbar.
  await expect(page.locator(".excalidraw").first()).toBeVisible({ timeout: 20000 });
  await expect(page.getByRole("button", { name: "Save" })).toBeVisible({ timeout: 10000 });

  // A fresh drawing starts with no elements.
  const scene = await readScene(page, fileId);
  expect(scene.elements ?? []).toHaveLength(0);
});

test("drawing a shape and saving persists it", async () => {
  // Select the rectangle tool (Excalidraw keyboard shortcut) and drag on the
  // canvas. Draw near the centre to avoid the left/top tool panels.
  const canvas = page.locator(".excalidraw canvas").first();
  await expect(canvas).toBeVisible({ timeout: 10000 });
  const box = (await canvas.boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  await page.keyboard.press("r");
  await page.mouse.move(cx - 60, cy - 40);
  await page.mouse.down();
  await page.mouse.move(cx + 60, cy + 40, { steps: 8 });
  await page.mouse.up();

  // The Save button enables once the scene is dirty; click it.
  const saveBtn = page.getByRole("button", { name: "Save" });
  await expect(saveBtn).toBeEnabled({ timeout: 10000 });
  await saveBtn.click();
  // Exact match: the button's success label is exactly "Saved" (the old toolbar
  // had an "Unsaved changes" span that a substring match would have matched).
  await expect(page.getByText("Saved", { exact: true })).toBeVisible({ timeout: 10000 });

  // Reload and confirm the persisted scene now has the element (UI Save → PUT
  // /files/:id/content → R2 overwrite round-trip).
  await page.reload();
  await expect(page.locator(".excalidraw").first()).toBeVisible({ timeout: 20000 });
  const scene = await readScene(page, fileId);
  expect((scene.elements ?? []).length).toBeGreaterThan(0);
});

test("the drawing appears in the file listing", async () => {
  await page.goto(`/projects/${projectId}`);
  await expect(page.getByText("Untitled.excalidraw").first()).toBeVisible({ timeout: 10000 });
});
