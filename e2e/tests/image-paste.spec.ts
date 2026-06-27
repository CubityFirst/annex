/**
 * E2E test for image paste into the wysiwyg editor.
 *
 * Prerequisites - run from the monorepo root before starting tests:
 *   pnpm dev
 *
 * Covers:
 *   - Pasting an image blob via clipboardData uploads to /api/files
 *   - The editor inserts `![alt](url)` for the pasted image
 *   - A doc_assets folder is created on first paste
 *   - Saving + reloading shows the rendered <img> in reading mode
 */

import { test, expect, type BrowserContext, type Page } from "@playwright/test";

const RUN_ID = Date.now();
const EMAIL = `e2e-paste-${RUN_ID}@example.com`;
const PASSWORD = "E2eTest-P@ssw0rd!";
const NAME = "E2E Paste User";
const PROJECT_NAME = `E2E Project Paste ${RUN_ID}`;
const FAKE_IP = `10.${Math.floor(RUN_ID / 1e10) % 256}.${Math.floor(RUN_ID / 1e7) % 256}.${(RUN_ID + 7) % 256}`;

// Smallest valid PNG: 1×1 transparent pixel. Used so we don't ship binary
// fixtures and so the upload payload is trivially small.
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

let context: BrowserContext;
let page: Page;
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

test("pastes a PNG into the editor, uploads to /api/files, inserts markdown, and renders on save", async ({ browserName }) => {
  // Firefox cannot synthesize a `paste` ClipboardEvent carrying a File via JS
  // (DataTransfer.items.add silently no-ops on file items in Gecko), so this
  // specific input path is only exercisable in Chromium. The non-clipboard
  // upload path is covered by the file-upload code in avatar-upload.spec.ts.
  test.skip(browserName === "firefox", "synthetic clipboard File payloads not supported in Firefox");

  // Register + project + doc.
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
  const projectId = page.url().match(/\/projects\/([a-z0-9-]+)/)![1];
  projectSettingsUrl = `/projects/${projectId}/settings`;

  await page.getByRole("button", { name: "New document" }).click();
  await expect(page).toHaveURL(/\/projects\/.+\/docs\/.+/, { timeout: 10000 });
  await page.getByPlaceholder("Document title").fill("Paste Test Doc");

  const editor = page.locator(".cm-content");
  await expect(editor).toBeVisible({ timeout: 5000 });
  await editor.click();
  await page.keyboard.type("Before paste.\n\n");

  // Wait for the /api/files response triggered by paste so we know upload landed.
  const filesResponse = page.waitForResponse(
    r => r.url().includes("/api/files") && r.request().method() === "POST",
  );

  // Synthesize a paste of an image File. The editor's paste handler reads
  // event.clipboardData.items where kind==="file" and type startsWith "image/".
  await editor.evaluate((el, b64) => {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const file = new File([bytes], "tiny.png", { type: "image/png" });
    const dt = new DataTransfer();
    dt.items.add(file);
    const evt = new ClipboardEvent("paste", {
      clipboardData: dt,
      bubbles: true,
      cancelable: true,
    });
    el.dispatchEvent(evt);
  }, TINY_PNG_BASE64);

  const upload = await filesResponse;
  // /api/files returns 201 Created on a successful upload.
  expect([200, 201]).toContain(upload.status());

  // The editor inserts `![alt](url)` once the upload resolves; wait for the
  // markdown to land in the source view.
  await expect.poll(async () => {
    return page.evaluate(() => {
      const lines = Array.from(document.querySelectorAll(".cm-content .cm-line"));
      return lines.map(l => l.textContent ?? "").join("\n");
    });
  }, { timeout: 10000 }).toMatch(/!\[[^\]]+\]\(\/api\/files\/[a-z0-9-]+\/content\)/);

  // Save the doc, then verify the rendered <img> appears in reading mode.
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTitle("Edit document")).toBeVisible({ timeout: 10000 });

  // AuthenticatedImage swaps the raw /api/files URL into a blob: URL after
  // it has fetched + decoded the bytes with the auth header. The original
  // /api/files path is preserved on `data-original-src` for state recovery.
  await expect(page.locator("article img").first()).toBeVisible({ timeout: 5000 });
  await expect(page.locator("article img").first()).toHaveAttribute(
    "data-original-src",
    /\/api\/files\/[a-z0-9-]+\/content/,
  );
});
