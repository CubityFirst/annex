/**
 * E2E tests for the `limited` role and per-doc share permission grants.
 *
 * Verifies the full permission boundary for a limited member:
 *   1. By default, a limited member sees no docs at all.
 *   2. Granted `view` on a doc, they can read it but the Edit affordance
 *      is absent.
 *   3. Promoted to `edit` on the same doc, the Edit affordance returns
 *      and they can save changes.
 *
 * Prerequisites:
 *   pnpm dev  (from the monorepo root)
 *   packages/auth/.dev.vars: TURNSTILE_SECRET=1x0000000000000000000000000000000AA
 *
 * Two accounts are created: owner, limited. Both accounts and the project
 * are cleaned up in afterAll / globalTeardown even on failure.
 */

import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";

// ── Unique-per-run values ────────────────────────────────────────────────────

const RUN_ID = Date.now();
const PROJECT_NAME = `Limited Perm Test ${RUN_ID}`;
const DOC_TITLE = "Limited Access Doc";
// A distinct phrase so we can assert the rendered body is what the owner wrote.
const DOC_CONTENT_PHRASE = "Limited share content sentinel.";

const OWNER   = { name: "Limited Perm Owner", email: `e2e-limited-owner-${RUN_ID}@example.com`, password: "OwnerP@ssw0rd!" };
const LIMITED = { name: "Limited Perm User",  email: `e2e-limited-user-${RUN_ID}@example.com`,  password: "LimitedP@ssw0rd!" };

// Offsets +6/+7 keep these accounts in their own rate-limit buckets, separate
// from app.spec (+0), 2fa.spec (+1), change-password.spec (+2), invites.spec (+3/+4/+5).
function fakeIp(offset: number) {
  return `10.${Math.floor(RUN_ID / 1e10) % 256}.${Math.floor(RUN_ID / 1e7) % 256}.${(RUN_ID + offset) % 256}`;
}

// ── Shared state ──────────────────────────────────────────────────────────────

let ownerCtx: BrowserContext,   ownerPage: Page;
let limitedCtx: BrowserContext, limitedPage: Page;

let projectId = "";
let docId = "";

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

async function register(page: Page, user: typeof OWNER) {
  await page.goto("/register");
  await page.getByLabel("Name").fill(user.name);
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await expect(page.getByRole("button", { name: "Create account" })).toBeEnabled({ timeout: 5000 });
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).not.toHaveURL(/\/register/, { timeout: 10000 });
}

async function login(page: Page, user: typeof OWNER) {
  // /login?logout=1 clears any existing token first so this is always reliable.
  await page.goto("/login?logout=1");
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await expect(page.getByRole("button", { name: "Sign in" })).toBeEnabled({ timeout: 5000 });
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 10000 });
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  [ownerCtx,   ownerPage]   = await setupContext(browser, fakeIp(6));
  [limitedCtx, limitedPage] = await setupContext(browser, fakeIp(7));
});

// Best-effort project cleanup (account cleanup runs in globalTeardown).
test.afterAll(async () => {
  if (projectId) {
    try {
      await ownerPage.goto(`/projects/${projectId}/settings`, { timeout: 10000 });
      const btn = ownerPage.getByRole("button", { name: /delete site/i });
      if (await btn.isVisible({ timeout: 3000 })) {
        await btn.click();
        await ownerPage.getByRole("alertdialog").waitFor({ timeout: 5000 });
        await ownerPage.getByRole("button", { name: /yes.*delete/i }).click();
        await ownerPage.waitForURL(/\/(dashboard|projects(?!\/[a-z0-9]))/, { timeout: 15000 });
      }
    } catch {}
  }
  for (const ctx of [ownerCtx, limitedCtx]) {
    try { await ctx.close(); } catch { /* already closed by Playwright on test failure */ }
  }
});

// ── Registration ──────────────────────────────────────────────────────────────

test("registers the owner account", async () => {
  await register(ownerPage, OWNER);
});

test("registers the limited-user account", async () => {
  await register(limitedPage, LIMITED);
});

// ── Owner: create project ─────────────────────────────────────────────────────

test("owner creates a project", async () => {
  if (ownerPage.url().includes("/login")) await login(ownerPage, OWNER);
  await ownerPage.goto("/dashboard");
  await ownerPage.getByText("New site").click();
  await ownerPage.getByLabel("Name").fill(PROJECT_NAME);
  await ownerPage.getByRole("button", { name: "Create site" }).click();
  await expect(ownerPage).toHaveURL(/\/projects\/[a-z0-9-]+/, { timeout: 10000 });
  const m = ownerPage.url().match(/\/projects\/([a-z0-9-]+)/);
  projectId = m?.[1] ?? "";
  expect(projectId).not.toBe("");
});

// ── Owner: invite as limited ─────────────────────────────────────────────────

test("owner invites the second account with the Limited role", async () => {
  await ownerPage.goto(`/projects/${projectId}/settings`);

  await ownerPage.getByPlaceholder("user@example.com").fill(LIMITED.email);

  // Default invite role is "Editor" - switch to "Limited". Scope the combobox
  // to the invite form so we don't pick up the invite-link role select.
  const inviteForm = ownerPage.locator("form").filter({
    has: ownerPage.getByPlaceholder("user@example.com"),
  });
  await inviteForm.getByRole("combobox").click();
  await ownerPage.getByRole("option", { name: "Limited", exact: true }).click();

  await ownerPage.getByRole("button", { name: "Add" }).click();
  await expect(
    ownerPage.getByText(`Invite sent to ${LIMITED.email}.`, { exact: true }),
  ).toBeVisible({ timeout: 8000 });
});

// ── Limited user: accept ──────────────────────────────────────────────────────

test("limited user accepts the invite", async () => {
  await login(limitedPage, LIMITED);
  await limitedPage.goto("/invites/pending");
  await expect(limitedPage.getByRole("heading", { name: "Pending Invites" })).toBeVisible({ timeout: 5000 });
  await expect(limitedPage.getByText(PROJECT_NAME)).toBeVisible({ timeout: 5000 });
  await limitedPage.getByRole("button", { name: "Accept" }).click();
  await expect(limitedPage).toHaveURL(/\/projects\//, { timeout: 8000 });
});

// ── Owner: create the doc ─────────────────────────────────────────────────────

test("owner creates a doc with content", async () => {
  await ownerPage.goto(`/projects/${projectId}`);
  await ownerPage.getByRole("button", { name: "New document" }).click();
  await expect(ownerPage).toHaveURL(/\/projects\/.+\/docs\/.+/, { timeout: 10000 });

  const m = ownerPage.url().match(/\/docs\/([a-z0-9-]+)/);
  docId = m?.[1] ?? "";
  expect(docId).not.toBe("");

  await ownerPage.getByPlaceholder("Document title").fill(DOC_TITLE);

  const editor = ownerPage.locator(".cm-content");
  await expect(editor).toBeVisible({ timeout: 5000 });
  await editor.click();
  await ownerPage.keyboard.type(DOC_CONTENT_PHRASE);

  await ownerPage.getByRole("button", { name: "Save" }).click();
  // Reading-mode pencil reappears once the save round-trip completes.
  await expect(ownerPage.getByTitle("Edit document")).toBeVisible({ timeout: 10000 });
});

// ── Default state: no access ──────────────────────────────────────────────────

test("by default the limited user does NOT see the doc in the file list", async () => {
  await limitedPage.goto(`/projects/${projectId}`);
  // Wait for the FileManager request to settle. The project page renders
  // some chrome immediately, so we can't rely on a "loaded" sentinel - the
  // assertion timeout is the wait.
  await expect(limitedPage.getByText(DOC_TITLE)).not.toBeVisible({ timeout: 5000 });
});

// ── Owner grants view access ─────────────────────────────────────────────────

test("owner grants the limited user VIEW access on the doc", async () => {
  await ownerPage.goto(`/projects/${projectId}/docs/${docId}`);
  await ownerPage.getByTitle("Manage limited viewer access").click();

  const dialog = ownerPage.getByRole("dialog", { name: "Document Access" });
  await expect(dialog).toBeVisible({ timeout: 5000 });

  // Sanity: no shares yet - the empty-state copy is visible.
  await expect(dialog.getByText("No users have been granted discrete access yet.")).toBeVisible();

  // Default permission for an addable limited member is already "View" - just
  // click the per-row "Grant access" button.
  await dialog.getByTitle("Grant access").click();

  // After grant, the user moves into the "Members with access" section. The
  // "Revoke access" button only renders for existing shares, so its presence
  // is the unambiguous post-grant signal (the user's name is visible in both
  // sections).
  await expect(dialog.getByTitle("Revoke access")).toBeVisible({ timeout: 5000 });

  await ownerPage.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible({ timeout: 3000 });
});

// ── With view share: read-only access ────────────────────────────────────────

test("with VIEW share - limited user sees the doc and the body content", async () => {
  await limitedPage.goto(`/projects/${projectId}`);
  await expect(limitedPage.getByText(DOC_TITLE)).toBeVisible({ timeout: 5000 });

  await limitedPage.getByText(DOC_TITLE).click();
  await expect(limitedPage).toHaveURL(/\/docs\/[a-z0-9-]+/, { timeout: 5000 });
  // Reading mode still mounts CodeMirror with inline widgets, so the body
  // text appears in both the rendered <p> and the cm-line div. Either match
  // is sufficient evidence that the user can read the doc.
  await expect(limitedPage.getByText(DOC_CONTENT_PHRASE).first()).toBeVisible({ timeout: 5000 });
});

test("with VIEW share - limited user does NOT see the Edit affordance", async () => {
  // Edit pencil is gated on `isEditor`, which is false for myPermission==="view".
  await expect(limitedPage.getByTitle("Edit document")).not.toBeVisible();
});

// ── Owner uplifts to edit ────────────────────────────────────────────────────

test("owner uplifts the share from VIEW to EDIT", async () => {
  await ownerPage.goto(`/projects/${projectId}/docs/${docId}`);
  await ownerPage.getByTitle("Manage limited viewer access").click();

  const dialog = ownerPage.getByRole("dialog", { name: "Document Access" });
  await expect(dialog).toBeVisible({ timeout: 5000 });

  // Single existing share row - its permission combobox is the only
  // combobox in the dialog at this point.
  await dialog.getByRole("combobox").click();
  await ownerPage.getByRole("option", { name: "Edit", exact: true }).click();

  // Wait for the value to settle on the new permission.
  await expect(dialog.getByRole("combobox")).toContainText("Edit", { timeout: 5000 });

  await ownerPage.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible({ timeout: 3000 });
});

// ── With edit share: editing works ───────────────────────────────────────────

test("with EDIT share - limited user CAN see the Edit affordance and save changes", async () => {
  await limitedPage.goto(`/projects/${projectId}/docs/${docId}`);

  const editBtn = limitedPage.getByTitle("Edit document");
  await expect(editBtn).toBeVisible({ timeout: 5000 });
  await editBtn.click();

  const editor = limitedPage.locator(".cm-content");
  await expect(editor).toBeVisible({ timeout: 5000 });
  await editor.click();
  // Move to end of doc so we append rather than overwrite.
  await limitedPage.keyboard.press("Control+End");
  await limitedPage.keyboard.type(" - edited by limited user");

  await limitedPage.getByRole("button", { name: "Save" }).click();
  // Successful save returns the page to reading mode (pencil visible again).
  await expect(limitedPage.getByTitle("Edit document")).toBeVisible({ timeout: 10000 });
  // Same dual-render situation as the view-share read assertion.
  await expect(limitedPage.getByText("edited by limited user").first()).toBeVisible({ timeout: 5000 });
});

// ── Cleanup ───────────────────────────────────────────────────────────────────

test("owner deletes the project", async () => {
  await ownerPage.goto(`/projects/${projectId}/settings`);
  await ownerPage.getByRole("button", { name: /delete site/i }).click();
  await expect(ownerPage.getByRole("alertdialog")).toBeVisible({ timeout: 5000 });
  await ownerPage.getByRole("button", { name: /yes.*delete/i }).click();
  await expect(ownerPage).not.toHaveURL(/\/projects\//, { timeout: 15000 });
  projectId = "";
});

// Account cleanup for both accounts runs in globalTeardown
// (e2e/global-teardown.ts).
