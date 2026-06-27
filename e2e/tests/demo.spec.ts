/**
 * E2E tests for the /demo sandbox (linked from the landing page's "See a
 * demo"). Demo mode patches window.fetch with an in-memory mock API
 * (frontend/src/lib/demoServer.ts), so these tests only need the frontend dev
 * server - no auth/API worker state is touched and nothing is left behind.
 *
 * Demo mode is flagged in sessionStorage, so every test gets a clean sandbox
 * simply by navigating to /demo in its own browser context.
 */

import { test, expect, type Page } from "@playwright/test";

const BANNER_TEXT = "This is a demo environment, any changes you make here are local, and will not be saved.";

async function enterDemo(page: Page) {
  await page.goto("/demo");
  await page.waitForURL("**/dashboard");
  await expect(page.getByText(BANNER_TEXT)).toBeVisible();
}

// The reading view is CodeMirror-virtualized, and its scrollHeight grows as
// content mounts - a single scroll-to-bottom can land short. Keep scrolling
// until the target locator actually renders.
async function scrollUntilVisible(page: Page, locator: ReturnType<Page["locator"]>) {
  await expect(async () => {
    await page.evaluate(() => {
      const scroller = document.querySelector("main .overflow-y-auto");
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
    });
    await expect(locator).toBeVisible({ timeout: 500 });
  }).toPass({ timeout: 10000 });
}

test.describe("demo sandbox", () => {
  test("landing page 'See a demo' links to /demo", async ({ page }) => {
    await page.goto("/");
    const demoLink = page.locator('a:has-text("See a demo")');
    await expect(demoLink).toHaveAttribute("href", "/demo");
  });

  test("boots into the dashboard with the demo site; site creation is refused", async ({ page }) => {
    await enterDemo(page);
    await expect(page.getByRole("heading", { name: "Demo Site" })).toBeVisible();

    await page.click("text=New site");
    await page.fill("#site-name", "My Real Site");
    await page.click('button:has-text("Create site")');
    await expect(page.getByText("Site creation is disabled in the demo.")).toBeVisible();
  });

  test("file manager lists seeded content and search finds it", async ({ page }) => {
    await enterDemo(page);
    await page.click('div.cursor-pointer:has-text("Demo Site")');
    await expect(page.getByText("Welcome to the Annex demo")).toBeVisible();
    await expect(page.getByText("demo-illustration.svg")).toBeVisible();
    await expect(page.getByText("session-zero-notes.txt")).toBeVisible();
    await expect(page.getByText("Guides")).toBeVisible();

    await page.keyboard.press("Control+k");
    await page.fill("[cmdk-input]", "coffee");
    const palette = page.getByRole("dialog");
    await expect(palette.getByText("Coffee brewing guide", { exact: true })).toBeVisible();

    // Open the search hit - this doc has frontmatter tags, which DocPage
    // JSON.parses, so it guards the demo store's tags encoding too.
    await palette.getByText("Coffee brewing guide", { exact: true }).click();
    await expect(page.getByText("Weigh everything").first()).toBeVisible();
  });

  test("doc renders, edits save into the in-memory store, history grows", async ({ page }) => {
    await enterDemo(page);
    await page.click('div.cursor-pointer:has-text("Demo Site")');
    await page.click("text=Welcome to the Annex demo");
    await expect(page.getByText("Go ahead, break things").first()).toBeVisible();

    // Scroll until the image widget mounts, then require a visible img
    // resolved to a blob URL (i.e. served from the in-memory store).
    await scrollUntilVisible(page, page.locator('img[src^="blob:"]:visible').first());

    await page.click('button[title="Edit document"]');
    await page.click(".cm-content");
    await page.keyboard.press("Control+End");
    await page.keyboard.type("\n\nEdited locally in the demo e2e test.");
    await page.click('button:has-text("Save")');
    // Back in the reading view - scroll until the appended paragraph mounts,
    // scoped to the CodeMirror content to avoid matching the hidden
    // PDF-export markdown copy.
    await expect(page.locator(".cm-content")).toBeVisible();
    await scrollUntilVisible(page, page.locator(".cm-content").getByText("Edited locally in the demo e2e test."));

    await page.click('button[title="View history"]');
    await expect(page.getByText("Added the feature checklist")).toBeVisible();
  });

  test("exit demo returns to the landing page", async ({ page }) => {
    await enterDemo(page);
    await page.click('button:has-text("Exit demo")');
    await page.waitForURL((url) => url.pathname === "/");
    await expect(page.getByText("See a demo")).toBeVisible();
  });
});
