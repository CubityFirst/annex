/**
 * E2E tests for changing a user's email address from the settings page.
 *
 * Covers the flag-off (immediate apply) path only: the `email-verification`
 * Flagship flag defaults off and local wrangler dev serves the real dashboard
 * flag state. The confirm-first (flag-on) path is covered by the auth
 * worker's unit tests.
 *
 * Prerequisites - run from the monorepo root before starting tests:
 *   pnpm dev
 *
 * packages/auth/.dev.vars must contain:
 *   TURNSTILE_SECRET=1x0000000000000000000000000000000AA
 *
 * A fresh account is registered at the start; globalTeardown wipes
 * e2e-%@example.com users (both addresses used here match that pattern).
 */

import { test, expect, type BrowserContext, type Page } from "@playwright/test";

// ── Unique-per-run values ────────────────────────────────────────────────────

const RUN_ID = Date.now();
const EMAIL = `e2e-em-${RUN_ID}@example.com`;
const NEW_EMAIL = `e2e-em-${RUN_ID}-new@example.com`;
const PASSWORD = "ChangeEmailP@ssw0rd!";
const NAME = "Email Change Test User";
// Offset +4 from the other specs so parallel runs don't share a rate-limit bucket.
const FAKE_IP = `10.${Math.floor(RUN_ID / 1e10) % 256}.${Math.floor(RUN_ID / 1e7) % 256}.${(RUN_ID + 4) % 256}`;

// ── Shared context ────────────────────────────────────────────────────────────

let context: BrowserContext;
let page: Page;

async function mockTurnstile(ctx: BrowserContext) {
  await ctx.addInitScript(() => {
    // Real Turnstile re-runs the challenge on reset() and fires the render
    // callback with a fresh token; the mock must replay the callback too.
    let verify: ((t: string) => void) | null = null;
    Object.defineProperty(window, "turnstile", {
      value: {
        render(_container: unknown, options: { callback: (t: string) => void }) {
          verify = options.callback;
          setTimeout(() => verify?.("e2e-bypass-token"), 50);
          return "mock-widget-id";
        },
        reset() {
          setTimeout(() => verify?.("e2e-bypass-token"), 50);
        },
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

async function logout(p: Page) {
  await p.goto("/login?logout=1");
  await expect(p).toHaveURL(/\/login/, { timeout: 5000 });
}

async function openChangeEmailDialog(p: Page) {
  await p.goto("/settings");
  await p.getByRole("button", { name: "Change email address" }).click();
  await expect(p.getByRole("dialog", { name: "Change email address" })).toBeVisible({ timeout: 5000 });
}

const newEmailField = (p: Page) => p.getByLabel("New email address", { exact: true });
const currentPasswordField = (p: Page) => p.getByLabel("Current password", { exact: true });
const submitButton = (p: Page) => p.getByRole("button", { name: "Change email", exact: true });

// ── Lifecycle ─────────────────────────────────────────────────────────────────

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext();
  await mockTurnstile(context);
  await injectFakeIp(context);
  page = await context.newPage();
});

// Account cleanup runs in globalTeardown.
test.afterAll(async () => {
  await context.close();
});

// ── Setup ─────────────────────────────────────────────────────────────────────

test("registers a fresh account", async () => {
  await page.goto("/register");
  await page.getByLabel("Name").fill(NAME);
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  // Retry the whole submit: the local wrangler chain can drop the register
  // POST under full-suite load.
  await expect(async () => {
    await expect(page.getByRole("button", { name: "Create account" })).toBeEnabled({ timeout: 5000 });
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page).not.toHaveURL(/\/register/, { timeout: 8000 });
  }).toPass({ timeout: 30000 });
});

test("logs in after registration", async () => {
  if (page.url().includes("/login")) {
    await page.getByLabel("Email").fill(EMAIL);
    await page.getByLabel("Password").fill(PASSWORD);
    await expect(page.getByRole("button", { name: "Sign in" })).toBeEnabled({ timeout: 5000 });
    await page.getByRole("button", { name: "Sign in" }).click();
  }
  await expect(page).not.toHaveURL(/\/login/, { timeout: 10000 });
});

// ── Change-email dialog ───────────────────────────────────────────────────────

test("change email button opens the dialog", async () => {
  await openChangeEmailDialog(page);
  await expect(newEmailField(page)).toBeVisible();
  await expect(currentPasswordField(page)).toBeVisible();
});

test("submit is disabled while fields are empty", async () => {
  // Dialog is still open from the previous test.
  await expect(submitButton(page)).toBeDisabled();
});

test("shows toast when current password is wrong", async () => {
  await newEmailField(page).fill(NEW_EMAIL);
  await currentPasswordField(page).fill("wrong-password");

  await expect(submitButton(page)).toBeEnabled({ timeout: 3000 });
  await submitButton(page).click();

  await expect(page.getByText("Current password is incorrect", { exact: true })).toBeVisible({ timeout: 8000 });
  // Dialog stays open after a failed attempt.
  await expect(page.getByRole("dialog", { name: "Change email address" })).toBeVisible();
});

test("successfully changes the email address", async () => {
  // Retry on transient drops through the local wrangler chain: a failed PATCH
  // leaves the dialog open with the fields intact. Success closes the dialog.
  await expect(async () => {
    await newEmailField(page).fill(NEW_EMAIL);
    await currentPasswordField(page).fill(PASSWORD);
    await expect(submitButton(page)).toBeEnabled({ timeout: 3000 });
    await submitButton(page).click();
    await expect(page.getByRole("dialog", { name: "Change email address" })).not.toBeVisible({ timeout: 8000 });
  }).toPass({ timeout: 30000 });
  await expect(page.getByText("Email address updated", { exact: true })).toBeVisible({ timeout: 5000 });
  // The settings page now shows the new address in the (disabled) email field.
  await expect(page.locator("#email")).toHaveValue(NEW_EMAIL);
});

// ── Verify the new email works for login ──────────────────────────────────────

test("old email no longer logs in", async () => {
  await logout(page);
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await expect(page.getByRole("button", { name: "Sign in" })).toBeEnabled({ timeout: 5000 });
  await page.getByRole("button", { name: "Sign in" }).click();
  // Should stay on login (auth rejected).
  await expect(page).toHaveURL(/\/login/, { timeout: 8000 });
});

test("new email logs in successfully", async () => {
  // Retry the whole attempt: the local wrangler chain can drop the login POST
  // under full-suite load, which surfaces an error and re-arms the form.
  await expect(async () => {
    await page.getByLabel("Email").fill(NEW_EMAIL);
    await page.getByLabel("Password").fill(PASSWORD);
    await expect(page.getByRole("button", { name: "Sign in" })).toBeEnabled({ timeout: 5000 });
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).not.toHaveURL(/\/login/, { timeout: 8000 });
  }).toPass({ timeout: 30000 });
});
