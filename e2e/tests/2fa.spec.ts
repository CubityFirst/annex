/**
 * E2E tests for two-factor authentication.
 *
 * Covers:
 *   - TOTP: enable, login with code, disable
 *   - WebAuthn: register a virtual passkey, login with it, remove it
 *
 * Prerequisites - run from the monorepo root:
 *   pnpm dev
 *
 * packages/auth/.dev.vars must contain:
 *   TURNSTILE_SECRET=1x0000000000000000000000000000000AA
 *   WEBAUTHN_RP_ID=localhost
 *   WEBAUTHN_ORIGIN=http://localhost:5173
 *
 * A fresh account is registered at the start and deleted in afterAll, so no
 * data is left behind even if tests fail mid-way.
 */

import { test, expect, type BrowserContext, type Page } from "@playwright/test";

// ── Unique-per-run values ────────────────────────────────────────────────────

const RUN_ID = Date.now();
const EMAIL = `e2e-2fa-${RUN_ID}@example.com`;
const PASSWORD = "2FA-Test-P@ssw0rd!";
const NAME = "2FA Test User";
// Offset +1 from app.spec so parallel runs don't share a rate-limit bucket.
const FAKE_IP = `10.${Math.floor(RUN_ID / 1e10) % 256}.${Math.floor(RUN_ID / 1e7) % 256}.${(RUN_ID + 1) % 256}`;

// ── TOTP secret shared across tests in this file ─────────────────────────────

// Captured during "enables authenticator app" and reused in subsequent tests.
let totpSecret = "";

// ── TOTP helper ───────────────────────────────────────────────────────────────

/**
 * Computes the current TOTP code for a base32-encoded secret.
 * Mirrors the HOTP implementation in packages/auth/src/totp.ts.
 * The auth server accepts ±1 time step, so clock drift of up to 30 s is fine.
 */
async function computeTOTP(secret: string): Promise<string> {
  const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = secret.toUpperCase().replace(/[^A-Z2-7]/g, "");
  const bytes: number[] = [];
  let bits = 0, value = 0;
  for (const char of clean) {
    const idx = BASE32.indexOf(char);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 255);
    }
  }
  const secretBytes = new Uint8Array(bytes);
  const counter = Math.floor(Date.now() / 1000 / 30);
  const key = await crypto.subtle.importKey(
    "raw", secretBytes.buffer,
    { name: "HMAC", hash: "SHA-1" },
    false, ["sign"],
  );
  const counterBuf = new ArrayBuffer(8);
  new DataView(counterBuf).setBigUint64(0, BigInt(counter), false);
  const hmac = new Uint8Array(await crypto.subtle.sign("HMAC", key, counterBuf));
  const offset = hmac[19] & 0x0f;
  const code = (
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff)
  ) % 1_000_000;
  return code.toString().padStart(6, "0");
}

/**
 * Fills a shadcn/ui InputOTP widget.
 * input-otp renders a native <input data-input-otp> positioned absolutely over
 * the visual slot divs. We click that native input directly to focus it, then
 * keyboard.type flows each digit into successive slots automatically.
 */
async function fillOTP(page: Page, code: string) {
  const otpInput = page.locator('[data-input-otp]').first();
  await otpInput.click();
  await page.keyboard.type(code);
}

// ── Shared context ────────────────────────────────────────────────────────────

let context: BrowserContext;
let page: Page;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cdpSession: any = null;

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

async function logout(p: Page) {
  // ?logout=1 tells LoginPage to call clearToken() before checking for an
  // existing session, so the user lands on the login form rather than being
  // redirected straight to the dashboard.
  await p.goto("/login?logout=1");
  await expect(p).toHaveURL(/\/login/, { timeout: 5000 });
}

async function loginWithPassword(p: Page) {
  await p.goto("/login");
  await p.getByLabel("Email").fill(EMAIL);
  await p.getByLabel("Password").fill(PASSWORD);
  await expect(p.getByRole("button", { name: "Sign in" })).toBeEnabled({ timeout: 5000 });
  await p.getByRole("button", { name: "Sign in" }).click();
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext();
  await mockTurnstile(context);
  await injectFakeIp(context);
  page = await context.newPage();
});

// Account cleanup runs in globalTeardown. The "deletes the account - 2FA
// confirmation required" test exercises the UI delete flow itself.
test.afterAll(async () => {
  if (cdpSession) {
    await cdpSession.detach().catch(() => {});
    cdpSession = null;
  }
  await context.close();
});

// ── Setup ─────────────────────────────────────────────────────────────────────

test("registers a fresh account for 2FA testing", async () => {
  await page.goto("/register");
  await page.getByLabel("Name").fill(NAME);
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await expect(page.getByRole("button", { name: "Create account" })).toBeEnabled({ timeout: 5000 });
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).not.toHaveURL(/\/register/, { timeout: 10000 });
});

test("logs in after registration", async () => {
  // Registration may redirect to /login rather than auto-logging in.
  if (page.url().includes("/login")) {
    await loginWithPassword(page);
  }
  await expect(page).not.toHaveURL(/\/login/, { timeout: 10000 });
});

// ════════════════════════════════════════════════════════════════════════════
// TOTP
// ════════════════════════════════════════════════════════════════════════════

test("TOTP - enables authenticator app", async () => {
  await page.goto("/settings");
  await page.getByRole("button", { name: "Set up authenticator app" }).click();

  // The UI shows a QR code and the manual-entry secret in a <code> element.
  const secretEl = page.locator("code").first();
  await expect(secretEl).toBeVisible({ timeout: 5000 });
  totpSecret = (await secretEl.textContent())?.trim() ?? "";
  expect(totpSecret.length).toBeGreaterThan(10);

  const code = await computeTOTP(totpSecret);
  await fillOTP(page, code);
  await page.getByRole("button", { name: "Enable 2FA" }).click();

  // Setup exits and the disable button appears.
  await expect(page.getByRole("button", { name: "Disable authenticator app" })).toBeVisible({ timeout: 10000 });
});

test("TOTP - login prompts for the authenticator code", async () => {
  await logout(page);
  await loginWithPassword(page);
  // Server returns totp_required → login page switches to the TOTP step.
  await expect(page.getByText("Two-factor authentication")).toBeVisible({ timeout: 8000 });
  await expect(page.getByText(/authenticator code/i)).toBeVisible({ timeout: 3000 });
});

test("TOTP - entering a valid code completes login", async () => {
  // Still on the TOTP challenge screen from the previous test.
  const code = await computeTOTP(totpSecret);
  await fillOTP(page, code);
  // Turnstile mock fires automatically; "Verify" submits the form.
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 10000 });
});

test("TOTP - disables authenticator app (requires TOTP confirmation)", async () => {
  await page.goto("/settings");
  await page.getByRole("button", { name: "Disable authenticator app" }).click();

  // use2FA dialog opens in TOTP mode (only TOTP is active on this account).
  await expect(page.getByRole("dialog", { name: "Confirm identity" })).toBeVisible({ timeout: 5000 });

  const code = await computeTOTP(totpSecret);
  await fillOTP(page, code);
  await page.getByRole("button", { name: "Confirm" }).click();

  // "Set up authenticator app" reappears after disabling.
  await expect(page.getByRole("button", { name: "Set up authenticator app" })).toBeVisible({ timeout: 10000 });
  totpSecret = ""; // no longer valid
});

test("TOTP - login no longer requires a code after disabling", async () => {
  await logout(page);
  await loginWithPassword(page);
  // Should go straight to the dashboard without a TOTP prompt.
  await expect(page).not.toHaveURL(/\/login/, { timeout: 10000 });
  await expect(page.getByText(/two.factor authentication/i)).not.toBeVisible();
});

// ════════════════════════════════════════════════════════════════════════════
// WebAuthn (Playwright virtual authenticator)
// ════════════════════════════════════════════════════════════════════════════

test("WebAuthn - registers a virtual passkey", async ({ browserName }) => {
  test.skip(browserName !== "chromium", "CDP (WebAuthn virtual authenticator) is only available in Chromium");
  // Chrome DevTools Protocol is the current way to add a virtual authenticator
  // (Playwright's high-level addVirtualAuthenticator wrapper is not available in
  // this version).  The RP ID and origin must match packages/auth/.dev.vars:
  //   WEBAUTHN_RP_ID=localhost  /  WEBAUTHN_ORIGIN=http://localhost:5173
  cdpSession = await context.newCDPSession(page);
  await cdpSession.send("WebAuthn.enable", { enableUI: false });
  await cdpSession.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
    },
  });

  await page.goto("/settings");
  await page.getByRole("button", { name: "Add security key" }).click();
  await expect(page.getByLabel(/key name/i)).toBeVisible({ timeout: 3000 });
  await page.getByLabel(/key name/i).fill("Playwright Virtual Key");

  // "Register key" triggers startRegistration() in the browser; the virtual
  // authenticator responds automatically.
  await page.getByRole("button", { name: "Register key" }).click();

  // The credential should appear in the key list.
  await expect(page.getByText("Playwright Virtual Key")).toBeVisible({ timeout: 10000 });
});

test("WebAuthn - login triggers the passkey ceremony", async ({ browserName }) => {
  test.skip(browserName !== "chromium", "CDP (WebAuthn virtual authenticator) is only available in Chromium");
  await logout(page);
  await loginWithPassword(page);

  // The server returns webauthn_required and the login page immediately starts
  // the WebAuthn ceremony (startAuthentication).  The virtual authenticator
  // handles it silently, so we land on the dashboard without manual input.
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15000 });
});

test("WebAuthn - removes the passkey (requires WebAuthn confirmation)", async ({ browserName }) => {
  test.skip(browserName !== "chromium", "CDP (WebAuthn virtual authenticator) is only available in Chromium");
  await page.goto("/settings");

  const keyRow = page.locator("li", { hasText: "Playwright Virtual Key" });
  await expect(keyRow).toBeVisible({ timeout: 5000 });

  // The delete button (Trash2 icon) is the only button inside the key row.
  await keyRow.getByRole("button").click();

  // use2FA fires a WebAuthn ceremony to confirm the deletion; the virtual
  // authenticator handles it automatically.
  await expect(page.getByText("Playwright Virtual Key")).not.toBeVisible({ timeout: 10000 });
});

test("WebAuthn - login no longer requires a key after removal", async ({ browserName }) => {
  test.skip(browserName !== "chromium", "CDP (WebAuthn virtual authenticator) is only available in Chromium");
  await logout(page);
  await loginWithPassword(page);
  await expect(page).not.toHaveURL(/\/login/, { timeout: 10000 });
});

// ── Cleanup: delete account (2FA-protected) ───────────────────────────────────

// Re-enable TOTP so the account deletion itself tests the 2FA confirmation gate.
test("re-enables TOTP before account deletion", async () => {
  await page.goto("/settings");
  await page.getByRole("button", { name: "Set up authenticator app" }).click();

  const secretEl = page.locator("code").first();
  await expect(secretEl).toBeVisible({ timeout: 5000 });
  totpSecret = (await secretEl.textContent())?.trim() ?? "";

  const code = await computeTOTP(totpSecret);
  await fillOTP(page, code);
  await page.getByRole("button", { name: "Enable 2FA" }).click();
  await expect(page.getByRole("button", { name: "Disable authenticator app" })).toBeVisible({ timeout: 10000 });
});

test("deletes the account - 2FA confirmation required", async () => {
  // "Delete account" → confirmation dialog → "Yes, delete my account"
  // → runWithTwoFA fires because TOTP is active → "Confirm identity" dialog
  await page.getByRole("button", { name: /delete account/i }).click();
  await expect(page.getByRole("alertdialog")).toBeVisible({ timeout: 5000 });
  await page.getByRole("button", { name: /yes.*delete.*account/i }).click();

  // use2FA opens the TOTP confirmation dialog.
  await expect(page.getByRole("dialog", { name: "Confirm identity" })).toBeVisible({ timeout: 5000 });

  const code = await computeTOTP(totpSecret);
  await fillOTP(page, code);
  await page.getByRole("button", { name: "Confirm" }).click();

  // After successful deletion the app navigates to /login.
  await expect(page).toHaveURL(/\/(login|register)/, { timeout: 15000 });
});
