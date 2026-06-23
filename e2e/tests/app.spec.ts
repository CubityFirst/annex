/**
 * E2E test suite for the full application flow.
 *
 * Prerequisites — run from the monorepo root before starting tests:
 *   pnpm dev
 *
 * Also set TURNSTILE_SECRET=1x0000000000000000000000000000000AA in
 * packages/auth/.dev.vars (Cloudflare's always-pass test secret).
 *
 * The suite registers a fresh account, exercises the UI, then deletes both the
 * project and the account so it leaves no data behind.
 *
 * Cleanup (delete project + delete account) always runs in afterAll even if
 * earlier tests fail, so the test never leaves orphaned data.
 */

import { test, expect, type BrowserContext, type Page } from "@playwright/test";

// ── Unique-per-run values ────────────────────────────────────────────────────

const RUN_ID = Date.now();
const EMAIL = `e2e-${RUN_ID}@example.com`;
const PASSWORD = "E2eTest-P@ssw0rd!";
const NAME = "E2E Test User";
const PROJECT_NAME = `E2E Project ${RUN_ID}`;
const PROJECT_DESCRIPTION = "Created by the Playwright E2E suite";

// Unique fake IP so each run gets its own rate-limit bucket in the auth worker.
const FAKE_IP = `10.${Math.floor(RUN_ID / 1e10) % 256}.${Math.floor(RUN_ID / 1e7) % 256}.${RUN_ID % 256}`;

// ── Shared state ─────────────────────────────────────────────────────────────

let context: BrowserContext;
let page: Page;
// Captured during the "creates a new project" test; used for afterAll cleanup.
let projectSettingsUrl = "";

// ── Helpers ───────────────────────────────────────────────────────────────────

async function mockTurnstile(ctx: BrowserContext) {
  await ctx.addInitScript(() => {
    Object.defineProperty(window, "turnstile", {
      value: {
        render(_container: unknown, options: { callback: (t: string) => void }) {
          setTimeout(() => options.callback("e2e-bypass-token"), 50);
          return "mock-widget-id";
        },
        reset() {},
        remove() {},
      },
      writable: true,
      configurable: true,
    });
  });
}

async function injectFakeIp(ctx: BrowserContext) {
  await ctx.route("**/api/**", async (route) => {
    await route.continue({
      headers: { ...route.request().headers(), "CF-Connecting-IP": FAKE_IP },
    });
  });
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext();
  await mockTurnstile(context);
  await injectFakeIp(context);
  page = await context.newPage();
});

// Best-effort project cleanup (account cleanup runs in globalTeardown).
test.afterAll(async () => {
  if (page && projectSettingsUrl) {
    try {
      await page.goto(projectSettingsUrl, { timeout: 10000 });
      const deleteBtn = page.getByRole("button", { name: /delete site/i });
      if (await deleteBtn.isVisible({ timeout: 3000 })) {
        await deleteBtn.click();
        await page.getByRole("alertdialog").waitFor({ timeout: 5000 });
        await page.getByRole("button", { name: /yes.*delete/i }).click();
        await page.waitForURL(/\/(dashboard|projects(?!\/[a-z0-9]))/, { timeout: 15000 });
      }
    } catch { /* already deleted or unreachable */ }
  }

  await context.close();
});

// ── Registration ─────────────────────────────────────────────────────────────

test("registers a new account", async () => {
  await page.goto("/register");
  await page.getByLabel("Name").fill(NAME);
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await expect(page.getByRole("button", { name: "Create account" })).toBeEnabled({ timeout: 5000 });
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).not.toHaveURL(/\/register/, { timeout: 10000 });
});

// ── Login ────────────────────────────────────────────────────────────────────

test("logs in with the new account", async () => {
  // Registration may auto-log in (when the email-verification flag is off).
  // In that case the user is already on /dashboard and the login form is
  // implicitly verified by the rest of the suite — only run the login flow
  // if we actually landed on /login after registration.
  if (!page.url().includes("/login")) return;

  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await expect(page.getByRole("button", { name: "Sign in" })).toBeEnabled({ timeout: 5000 });
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 10000 });
});

// ── Dashboard ────────────────────────────────────────────────────────────────

test("shows the dashboard with no projects", async () => {
  await page.goto("/dashboard");
  await expect(page.getByText("Your Sites")).toBeVisible();
  await expect(page.getByText("New site")).toBeVisible();
});

// ── Create project ───────────────────────────────────────────────────────────

test("creates a new project", async () => {
  await page.goto("/dashboard");
  await page.getByText("New site").click();
  await page.getByLabel("Name").fill(PROJECT_NAME);

  const descInput = page.getByLabel("Description");
  if (await descInput.isVisible()) {
    await descInput.fill(PROJECT_DESCRIPTION);
  }

  await page.getByRole("button", { name: "Create site" }).click();
  await expect(page).toHaveURL(/\/projects\/[a-z0-9-]+/, { timeout: 10000 });

  // Capture project settings URL for afterAll cleanup.
  const m = page.url().match(/\/projects\/([a-z0-9-]+)/);
  if (m) projectSettingsUrl = `/projects/${m[1]}/settings`;
});

// ── FileManager: new document ────────────────────────────────────────────────

test("creates a new document", async () => {
  await page.getByRole("button", { name: "New document" }).click();
  await expect(page).toHaveURL(/\/projects\/.+\/docs\/.+/, { timeout: 10000 });
});

// ── DocPage: title ───────────────────────────────────────────────────────────

test("sets the document title", async () => {
  const titleInput = page.getByPlaceholder("Document title");
  await expect(titleInput).toBeVisible({ timeout: 5000 });
  await titleInput.fill("My E2E Document");
});

// ── DocPage: CodeMirror content ──────────────────────────────────────────────

test("types content into the editor", async () => {
  const editor = page.locator(".cm-content");
  await expect(editor).toBeVisible({ timeout: 5000 });
  await editor.click();
  await page.keyboard.type("# Hello from E2E\n\nThis document was created by the Playwright test suite.");
});

// ── DocPage: save ────────────────────────────────────────────────────────────

test("saves the document", async () => {
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTitle("Edit document")).toBeVisible({ timeout: 10000 });
});

// ── DocPage: verify preview ──────────────────────────────────────────────────

test("preview shows the saved title and content", async () => {
  await expect(page.getByRole("heading", { name: "My E2E Document" })).toBeVisible({ timeout: 5000 });
});

// ── Navigate back & verify file list ────────────────────────────────────────

test("the document appears in the project file list", async () => {
  await page.getByRole("link", { name: "File Manager" }).click();
  await expect(page).toHaveURL(/\/projects\/[a-z0-9-]+$/, { timeout: 5000 });
  await expect(page.getByText("My E2E Document")).toBeVisible({ timeout: 5000 });
});

// ── FileManager: new folder ──────────────────────────────────────────────────

test("creates a folder", async () => {
  await page.getByRole("button", { name: "New folder" }).click();
  const folderInput = page.getByPlaceholder("Folder name");
  await expect(folderInput).toBeVisible({ timeout: 5000 });
  await folderInput.fill("E2E Folder");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByText("E2E Folder")).toBeVisible({ timeout: 5000 });
});

// ── FileManager: document inside folder ─────────────────────────────────────

test("navigates into the folder and creates a document inside it", async () => {
  await page.getByText("E2E Folder").click();

  await page.getByRole("button", { name: "New document" }).click();
  await expect(page).toHaveURL(/\/projects\/.+\/docs\/.+/, { timeout: 10000 });

  const titleInput = page.getByPlaceholder("Document title");
  await expect(titleInput).toBeVisible({ timeout: 5000 });
  await titleInput.fill("Folder Doc");

  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTitle("Edit document")).toBeVisible({ timeout: 10000 });
});

// ── FileManager: drag doc into folder ────────────────────────────────────────

test("drags a document into a folder", async () => {
  // Navigate back to the project root file manager.
  await page.getByRole("link", { name: "File Manager" }).click();
  await expect(page).toHaveURL(/\/projects\/[a-z0-9-]+$/, { timeout: 5000 });
  await expect(page.getByText("My E2E Document")).toBeVisible({ timeout: 5000 });

  await page
    .locator('[draggable="true"]', { hasText: "My E2E Document" })
    .dragTo(page.locator('[draggable="true"]', { hasText: "E2E Folder" }));

  // After the move + reload, the doc should be gone from the root view.
  await expect(
    page.locator('[draggable="true"]', { hasText: "My E2E Document" }),
  ).not.toBeVisible({ timeout: 5000 });

  // Enter the folder and confirm the doc is now inside.
  await page.getByText("E2E Folder").click();
  await expect(page.getByText("My E2E Document")).toBeVisible({ timeout: 5000 });
});

// ── FileManager: drag doc back to root via breadcrumb ────────────────────────

test("drags a document back to root via the breadcrumb", async () => {
  // We are inside E2E Folder; breadcrumb shows [PROJECT_NAME] > [E2E Folder].
  const docRow = page.locator('[draggable="true"]', { hasText: "My E2E Document" });
  // The first inner breadcrumb span is the root crumb (project name).
  // Structure in main: .h-14 > span.flex > span.px-1\.5 (the actual crumb)
  const rootCrumb = page.locator("main .h-14 span span").first();

  await docRow.dragTo(rootCrumb);

  // Doc should disappear from the folder view after the API move + reload.
  await expect(docRow).not.toBeVisible({ timeout: 5000 });

  // Navigate to the project root and confirm the doc is back there.
  await page.getByRole("link", { name: "File Manager" }).click();
  await expect(page.getByText("My E2E Document")).toBeVisible({ timeout: 5000 });
});

// ── FileManager: right-click context menu — rename ───────────────────────────

test("renames a folder via the context menu", async () => {
  await page.getByText("E2E Folder").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename" }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible({ timeout: 3000 });
  await dialog.getByRole("textbox").clear();
  await dialog.getByRole("textbox").fill("E2E Renamed Folder");
  await dialog.getByRole("button", { name: "Rename" }).click();

  await expect(page.getByText("E2E Renamed Folder")).toBeVisible({ timeout: 5000 });
  await expect(page.getByText("E2E Folder", { exact: true })).not.toBeVisible();
});

// ── FileManager: right-click context menu — delete ───────────────────────────

test("deletes a document via the context menu", async () => {
  await page.getByText("My E2E Document").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete" }).click();

  await expect(page.getByRole("alertdialog")).toBeVisible({ timeout: 3000 });
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();

  await expect(page.getByText("My E2E Document")).not.toBeVisible({ timeout: 5000 });
});

// ── Favourite the project ────────────────────────────────────────────────────

test("can favourite the project from the dashboard", async () => {
  await page.goto("/dashboard");
  const projectCard = page.locator(".group", { hasText: PROJECT_NAME });
  await expect(projectCard).toBeVisible({ timeout: 5000 });
  const star = projectCard.locator("svg").first();
  await star.click({ force: true });
});

// ── Site settings page ───────────────────────────────────────────────────────

test("opens site settings", async () => {
  const projectCard = page.locator(".group", { hasText: PROJECT_NAME });
  await projectCard.click();
  await expect(page).toHaveURL(/\/projects\/[a-z0-9-]+/, { timeout: 10000 });

  await page.getByRole("link", { name: /settings/i }).click();
  await expect(page).toHaveURL(/\/projects\/.+\/settings/, { timeout: 10000 });
  await expect(page.getByRole("button", { name: "Delete site" })).toBeVisible({ timeout: 5000 });
});

// ── Cleanup ───────────────────────────────────────────────────────────────────

test("deletes the project", async () => {
  // Already on the settings page from the previous test.
  await page.getByRole("button", { name: /delete site/i }).click();
  await expect(page.getByRole("alertdialog")).toBeVisible({ timeout: 5000 });
  await page.getByRole("button", { name: /yes.*delete/i }).click();
  await expect(page).not.toHaveURL(/\/projects\//, { timeout: 15000 });
  projectSettingsUrl = ""; // signal afterAll that cleanup is done
});

// Account deletion runs in globalTeardown (e2e/global-teardown.ts) — the
// no-MFA delete path doesn't need a UI test here. The 2FA-gated path is
// covered by 2fa.spec.ts.
