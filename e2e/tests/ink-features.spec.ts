/**
 * E2E test for Annex Ink features (bio, ring style, presence colour, crit sparkles).
 *
 * Prerequisites - run from the monorepo root before starting tests:
 *   pnpm dev
 *
 * Also set TURNSTILE_SECRET=1x0000000000000000000000000000000AA in
 * packages/auth/.dev.vars (Cloudflare's always-pass test secret).
 *
 * Strategy: the Ink section of /settings only renders when the user's plan
 * resolves to "ink". Two ways to get there in dev:
 *   1. Stripe checkout (requires external service, not viable in tests)
 *   2. Grant the plan directly in the auth DB via `granted_plan = 'ink'` on
 *      user_billing - same wrangler-shell-out trick collab.spec.ts uses for
 *      the REALTIME feature bit
 *
 * After granting, the user must re-fetch their session for the resolved plan
 * to flip from "free" to "ink" (loadCurrentSession reads user_billing). We
 * just reload the page so the next /api/me/full call picks up the new state.
 */

import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { execSync } from "node:child_process";
import { resolve } from "node:path";

const RUN_ID = Date.now();
const EMAIL = `e2e-ink-${RUN_ID}@example.com`;
const PASSWORD = "E2eTest-P@ssw0rd!";
const NAME = "E2E Ink User";
const FAKE_IP = `10.${Math.floor(RUN_ID / 1e10) % 256}.${Math.floor(RUN_ID / 1e7) % 256}.${(RUN_ID + 13) % 256}`;

let context: BrowserContext;
let page: Page;
let userId = "";

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

function grantInk(uid: string) {
  const authDir = resolve(__dirname, "../../packages/auth");
  const sql = `INSERT INTO user_billing (user_id, granted_plan, granted_plan_started_at) VALUES ('${uid}', 'ink', ${Date.now()}) ON CONFLICT(user_id) DO UPDATE SET granted_plan = 'ink', granted_plan_started_at = ${Date.now()};`;
  execSync(
    `npx wrangler d1 execute cubedocs-auth --local --persist-to ../../.wrangler/state --command "${sql}"`,
    { cwd: authDir, stdio: "pipe" },
  );
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext();
  await mockTurnstile(context);
  await injectFakeIp(context);
  page = await context.newPage();
});

test.afterAll(async () => {
  await context.close();
});

test("registers a fresh account and grants Annex Ink via the auth DB", async () => {
  await page.goto("/register");
  await page.getByLabel("Name").fill(NAME);
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await expect(page.getByRole("button", { name: "Create account" })).toBeEnabled({ timeout: 5000 });
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).not.toHaveURL(/\/register/, { timeout: 10000 });

  // Grab the user id so we can write a granted_plan row keyed to it.
  userId = await page.evaluate(async () => {
    for (let i = 0; i < 5; i++) {
      const token = localStorage.getItem("token");
      if (token) {
        const r = await fetch("/api/me", { headers: { Authorization: `Bearer ${token}` } });
        const j = await r.json() as { ok: boolean; data?: { userId: string } };
        if (j.ok && j.data) return j.data.userId;
      }
      await new Promise(res => setTimeout(res, 200));
    }
    throw new Error("could not load /api/me after 5 retries");
  });
  expect(userId).not.toBe("");

  grantInk(userId);
});

test("billing section shows the Ink supporter card after granting", async () => {
  await page.goto("/settings");
  // Wait for the page to render and for the Ink card to appear (granted plan
  // gets the "(gifted)" badge in the heading).
  await expect(page.getByText(/Annex Ink/).first()).toBeVisible({ timeout: 10000 });
  await expect(page.getByText("(gifted)")).toBeVisible({ timeout: 5000 });
});

test("Customise appearance reveals ring style, presence colour, crit sparkles, and bio", async () => {
  await page.getByRole("button", { name: /customise appearance/i }).click();
  await expect(page.getByRole("heading", { name: "Ring style" })).toBeVisible({ timeout: 5000 });
  await expect(page.getByRole("heading", { name: "Presence colour" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Dice crit sparkles" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Bio" })).toBeVisible();
});

test("selecting a non-default ring style persists to /api/me/ink-prefs", async () => {
  // Capture the PATCH so we can assert on the request body.
  const responsePromise = page.waitForResponse(r =>
    r.url().includes("/api/me/ink-prefs") && r.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "Aurora" }).click();

  const res = await responsePromise;
  expect(res.status()).toBe(200);
  const body = JSON.parse(res.request().postData() ?? "{}");
  expect(body).toEqual({ style: "aurora" });

  // The selected style should remain visually active (aria-pressed=true).
  await expect(page.getByRole("button", { name: "Aurora" })).toHaveAttribute("aria-pressed", "true");
});

test("toggling crit sparkles off sends critSparkles: false", async () => {
  const switchEl = page.getByRole("switch", { name: /crit sparkles/i });
  await expect(switchEl).toHaveAttribute("data-state", "checked");

  const responsePromise = page.waitForResponse(r =>
    r.url().includes("/api/me/ink-prefs") && r.request().method() === "PATCH",
  );
  await switchEl.click();
  const res = await responsePromise;
  expect(res.status()).toBe(200);
  const body = JSON.parse(res.request().postData() ?? "{}");
  expect(body).toEqual({ critSparkles: false });
  await expect(switchEl).toHaveAttribute("data-state", "unchecked");
});

test("saving a bio persists to /api/me/bio and round-trips", async () => {
  const textarea = page.locator("textarea").filter({ hasNotText: "" }).first();
  await page.locator("textarea").first().fill("Hello from the **Ink** tier!");

  const responsePromise = page.waitForResponse(r =>
    r.url().includes("/api/me/bio") && r.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "Save bio" }).click();
  const res = await responsePromise;
  expect(res.status()).toBe(200);

  // Toast confirmation.
  await expect(page.getByText("Bio updated")).toBeVisible({ timeout: 5000 });

  // After save, the form returns to its no-change state (save button hidden).
  await expect(page.getByRole("button", { name: "Save bio" })).not.toBeVisible({ timeout: 3000 });

  // Reload and confirm the value persisted on the server.
  await page.reload();
  const inkBilling = page.locator("#billing");
  await expect(inkBilling).toBeVisible({ timeout: 10000 });
  await page.getByRole("button", { name: /customise appearance/i }).click();
  await expect(page.locator("textarea").first()).toHaveValue("Hello from the **Ink** tier!", { timeout: 5000 });
});
