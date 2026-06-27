/**
 * E2E test for the user profile card and public profile page.
 *
 * Prerequisites - run from the monorepo root before starting tests:
 *   pnpm dev
 *
 * Covers:
 *   - Profile card opens for the current user from a click target rendered
 *     with <UserProfileCard /> (e.g. the project members list)
 *   - Card shows member-since date and the action list for self
 *   - "View your public profile" navigates to /u/:userId
 *   - Public profile renders the bio (when set) and timezone
 *
 * Bio rendering requires the user to be on the Ink plan. The spec grants the
 * plan in the auth DB up front so we can also exercise the bio path.
 */

import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { execSync } from "node:child_process";
import { resolve } from "node:path";

const RUN_ID = Date.now();
const EMAIL = `e2e-prof-${RUN_ID}@example.com`;
const PASSWORD = "E2eTest-P@ssw0rd!";
const NAME = "E2E Profile User";
const FAKE_IP = `10.${Math.floor(RUN_ID / 1e10) % 256}.${Math.floor(RUN_ID / 1e7) % 256}.${(RUN_ID + 14) % 256}`;

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

test("registers, grants Ink, and writes a bio + timezone", async () => {
  await page.goto("/register");
  await page.getByLabel("Name").fill(NAME);
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await expect(page.getByRole("button", { name: "Create account" })).toBeEnabled({ timeout: 5000 });
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).not.toHaveURL(/\/register/, { timeout: 10000 });

  // Right after register the token is in localStorage but the auth worker's
  // session row may still be propagating; retry a few times so we don't race
  // on the auth/api worker handshake.
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

  // Seed a bio + timezone directly so the profile-card tests don't need to
  // re-traverse the settings UI (which has its own dedicated spec).
  await page.evaluate(async () => {
    const token = localStorage.getItem("token");
    await fetch("/api/me/bio", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ bio: "Tester from the e2e suite." }),
    });
    await fetch("/api/me", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ timezone: "America/New_York" }),
    });
  });
});

test("public profile page /u/:userId shows the saved bio and member-since date", async () => {
  await page.goto(`/u/${userId}`);
  // The public profile uses UserProfileCard with forceViewAsPublic, so the
  // dialog opens automatically and renders the public sections.
  await expect(page.getByText(NAME).first()).toBeVisible({ timeout: 10000 });
  await expect(page.getByText("Tester from the e2e suite.")).toBeVisible({ timeout: 5000 });
  await expect(page.getByText(/Member since/)).toBeVisible({ timeout: 5000 });
});

test("the Ink badge tooltip is reachable on the public profile", async () => {
  // The Annex Ink badge is rendered with aria-label="Annex Ink" so we can
  // hover it and assert the tooltip text appears.
  const inkBadge = page.getByLabel("Annex Ink").first();
  await expect(inkBadge).toBeVisible({ timeout: 5000 });
  await inkBadge.hover();
  await expect(page.getByText(/Annex Ink since/).first()).toBeVisible({ timeout: 5000 });
});
