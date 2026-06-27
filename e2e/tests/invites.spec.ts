/**
 * E2E tests for project member inviting - by email and by invite link.
 *
 * Prerequisites:
 *   pnpm dev  (from the monorepo root)
 *   packages/auth/.dev.vars: TURNSTILE_SECRET=1x0000000000000000000000000000000AA
 *
 * Three accounts are created: owner, email-invitee, link-invitee.
 * The project and all three accounts are deleted in afterAll even on failure.
 */

import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";

// ── Unique-per-run values ────────────────────────────────────────────────────

const RUN_ID = Date.now();
const PROJECT_NAME = `Invite Test ${RUN_ID}`;

const OWNER        = { name: "Invite Owner",  email: `e2e-inv-owner-${RUN_ID}@example.com`, password: "OwnerP@ssw0rd!" };
const EMAIL_USER   = { name: "Email Invitee", email: `e2e-inv-email-${RUN_ID}@example.com`, password: "InviteeP@ssw0rd!" };
const LINK_USER    = { name: "Link Invitee",  email: `e2e-inv-link-${RUN_ID}@example.com`,  password: "LinkP@ssw0rd!" };

// Offsets +3/+4/+5 keep each account in its own rate-limit bucket,
// separate from app.spec (+0), 2fa.spec (+1), change-password.spec (+2).
function fakeIp(offset: number) {
  return `10.${Math.floor(RUN_ID / 1e10) % 256}.${Math.floor(RUN_ID / 1e7) % 256}.${(RUN_ID + offset) % 256}`;
}

// ── Shared state ──────────────────────────────────────────────────────────────

let ownerCtx: BrowserContext,   ownerPage: Page;
let inviteeCtx: BrowserContext, inviteePage: Page;
let linkCtx: BrowserContext,    linkPage: Page;

let projectId = "";
let inviteLinkToken = "";

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
  [ownerCtx,   ownerPage]   = await setupContext(browser, fakeIp(3));
  [inviteeCtx, inviteePage] = await setupContext(browser, fakeIp(4));
  [linkCtx,    linkPage]    = await setupContext(browser, fakeIp(5));
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
  for (const ctx of [ownerCtx, inviteeCtx, linkCtx]) {
    try { await ctx.close(); } catch { /* already closed by Playwright on test failure */ }
  }
});

// ── Registration ──────────────────────────────────────────────────────────────

test("registers the owner account", async () => {
  await register(ownerPage, OWNER);
});

test("registers the email-invitee account", async () => {
  await register(inviteePage, EMAIL_USER);
});

test("registers the link-invitee account", async () => {
  await register(linkPage, LINK_USER);
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

// ════════════════════════════════════════════════════════════════════════════
// Email invite
// ════════════════════════════════════════════════════════════════════════════

test("email invite - owner invites by email address", async () => {
  await ownerPage.goto(`/projects/${projectId}/settings`);
  await ownerPage.getByPlaceholder("user@example.com").fill(EMAIL_USER.email);
  await ownerPage.getByRole("button", { name: "Add" }).click();
  await expect(
    ownerPage.getByText(`Invite sent to ${EMAIL_USER.email}.`, { exact: true }),
  ).toBeVisible({ timeout: 8000 });
});

test("email invite - invited member shows as pending in the members list", async () => {
  await expect(ownerPage.getByText("Pending", { exact: true })).toBeVisible({ timeout: 5000 });
});

test("email invite - invitee sees the pending invite", async () => {
  await login(inviteePage, EMAIL_USER);
  await inviteePage.goto("/invites/pending");
  await expect(inviteePage.getByRole("heading", { name: "Pending Invites" })).toBeVisible({ timeout: 5000 });
  await expect(inviteePage.getByText(PROJECT_NAME)).toBeVisible({ timeout: 5000 });
});

test("email invite - invitee accepts and is redirected to the project", async () => {
  await inviteePage.getByRole("button", { name: "Accept" }).click();
  // Acceptance navigates straight to the project page.
  await expect(inviteePage).toHaveURL(/\/projects\//, { timeout: 8000 });
});

test("email invite - project appears in invitee's dashboard", async () => {
  await inviteePage.goto("/dashboard");
  // Use heading role to avoid matching the sidebar nav button with the same text.
  await expect(inviteePage.getByRole("heading", { name: PROJECT_NAME })).toBeVisible({ timeout: 5000 });
});

// ════════════════════════════════════════════════════════════════════════════
// Invite link
// ════════════════════════════════════════════════════════════════════════════

test("invite link - owner creates a link and token is captured", async () => {
  await ownerPage.goto(`/projects/${projectId}/settings`);

  // Register the response listener before triggering the request.
  const responsePromise = ownerPage.waitForResponse(
    r => r.url().includes("/invite-links") && r.request().method() === "POST",
  );

  // First "Create link" button opens the dialog; second (inside the dialog) submits.
  await ownerPage.getByRole("button", { name: "Create link" }).first().click();
  await expect(ownerPage.getByRole("dialog", { name: "Create invite link" })).toBeVisible({ timeout: 5000 });
  await ownerPage.getByRole("button", { name: "Create link" }).last().click();

  const res = await responsePromise;
  const body = await res.json() as { ok: boolean; data: { id: string } };
  expect(body.ok).toBe(true);
  inviteLinkToken = body.data.id;
  expect(inviteLinkToken).toBeTruthy();

  await expect(ownerPage.getByText("Invite link created.", { exact: true })).toBeVisible({ timeout: 5000 });
});

test("invite link - link appears in the list with copy and revoke buttons", async () => {
  await expect(ownerPage.getByRole("button", { name: "Copy" })).toBeVisible({ timeout: 5000 });
  await expect(ownerPage.getByRole("button", { name: "Revoke" })).toBeVisible({ timeout: 5000 });
});

test("invite link - link-invitee sees the invite page", async () => {
  await login(linkPage, LINK_USER);
  await linkPage.goto(`/invite/${inviteLinkToken}`);
  await expect(linkPage.getByText("You've been invited to join")).toBeVisible({ timeout: 5000 });
  await expect(linkPage.getByText(PROJECT_NAME)).toBeVisible({ timeout: 5000 });
});

test("invite link - link-invitee accepts and is redirected to the project", async () => {
  await linkPage.getByRole("button", { name: "Accept" }).click();
  await expect(linkPage).toHaveURL(/\/projects\//, { timeout: 10000 });
});

test("invite link - project appears in link-invitee's dashboard", async () => {
  await linkPage.goto("/dashboard");
  await expect(linkPage.getByRole("heading", { name: PROJECT_NAME })).toBeVisible({ timeout: 5000 });
});

// ── Revoke ────────────────────────────────────────────────────────────────────

test("invite link - owner revokes the link", async () => {
  await ownerPage.goto(`/projects/${projectId}/settings`);
  await ownerPage.getByRole("button", { name: "Revoke" }).click();
  await expect(ownerPage.getByText("Invite link revoked.", { exact: true })).toBeVisible({ timeout: 5000 });
  await expect(ownerPage.getByText("No invite links yet.")).toBeVisible({ timeout: 5000 });
});

test("invite link - revoked link shows an error when visited", async () => {
  await linkPage.goto(`/invite/${inviteLinkToken}`);
  await expect(linkPage.getByText("Invalid invite")).toBeVisible({ timeout: 5000 });
  await expect(linkPage.getByText("This invite link has been revoked.")).toBeVisible({ timeout: 5000 });
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

// Account cleanup for all three invitees runs in globalTeardown
// (e2e/global-teardown.ts). The 2FA-gated delete path is covered by 2fa.spec.ts.
