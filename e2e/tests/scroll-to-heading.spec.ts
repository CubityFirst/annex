/**
 * E2E test for scroll-to-heading behaviour on published docs.
 *
 * Prerequisites - run from the monorepo root before starting tests:
 *   pnpm dev
 *
 * Also set TURNSTILE_SECRET=1x0000000000000000000000000000000AA in
 * packages/auth/.dev.vars (Cloudflare's always-pass test secret).
 *
 * Covers two flows on the published-doc page:
 *   1. Loading /s/<slug>/<docId>#<heading-slug> scrolls the article viewport
 *      so the heading sits at the top.
 *   2. Clicking outline items in the right rail scrolls to the corresponding
 *      heading and updates the URL bar's hash.
 *
 * The spec sets up a fresh account, project, and published doc with four
 * headings separated by enough filler that scroll positions are distinct,
 * then tears everything down in afterAll.
 */

import { test, expect, type BrowserContext, type Page } from "@playwright/test";

const RUN_ID = Date.now();
const EMAIL = `e2e-scroll-${RUN_ID}@example.com`;
const PASSWORD = "E2eTest-P@ssw0rd!";
const NAME = "E2E Scroll User";
const PROJECT_NAME = `E2E Scroll ${RUN_ID}`;

const FAKE_IP = `10.${Math.floor(RUN_ID / 1e10) % 256}.${Math.floor(RUN_ID / 1e7) % 256}.${RUN_ID % 256}`;

// How close to the top of the viewport a heading must land to count as
// "scrolled to". Generous enough to cover sub-pixel rounding and the small
// top padding CM applies inside heading lines.
const HEADING_NEAR_TOP_MAX_PX = 80;

let context: BrowserContext;
let page: Page;
let projectSettingsUrl = "";
let publicDocUrl = "";

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

// Returns the distance (in px) between the named heading's top edge and the
// public-doc viewport's top edge. Negative = heading is above the viewport;
// positive = below. Returns `null` if the heading text isn't currently in
// the DOM (CM virtualised it out, etc.).
async function headingOffsetFromTop(p: Page, headingText: string): Promise<number | null> {
  return p.evaluate((text) => {
    const scroller = document.querySelector(".public-doc-scroller");
    const vp = scroller?.querySelector("[data-radix-scroll-area-viewport]") as HTMLElement | null;
    if (!vp) return null;
    const vpTop = vp.getBoundingClientRect().top;
    const lines = Array.from(document.querySelectorAll(".cm-line")) as HTMLElement[];
    for (const line of lines) {
      if ((line.textContent ?? "").includes(text)) {
        return line.getBoundingClientRect().top - vpTop;
      }
    }
    return null;
  }, headingText);
}

// Asserts the named heading is rendered AND lands close to the top of the
// viewport. Polls until the *position* is right, not just until the heading
// is in the DOM, so we tolerate the ResizeObserver re-anchor settling.
async function expectTopVisibleHeading(p: Page, expected: string) {
  await expect
    .poll(async () => {
      const offset = await headingOffsetFromTop(p, expected);
      if (offset === null) return "not-rendered";
      if (offset < -10) return `above-viewport (offset=${offset.toFixed(1)})`;
      if (offset >= HEADING_NEAR_TOP_MAX_PX) return `too-low (offset=${offset.toFixed(1)})`;
      return "ok";
    }, {
      timeout: 8000,
      message: `heading "${expected}" should land near the top of the viewport`,
    })
    .toBe("ok");
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  // Outline rail only renders at the xl breakpoint (1280px+). 1440 gives it
  // plenty of room and matches a common laptop width.
  context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await mockTurnstile(context);
  await injectFakeIp(context);
  page = await context.newPage();
});

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

test("sets up a published doc with multiple headings", async () => {
  // Register
  await page.goto("/register");
  await page.getByLabel("Name").fill(NAME);
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await expect(page.getByRole("button", { name: "Create account" })).toBeEnabled({ timeout: 5000 });
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).not.toHaveURL(/\/register/, { timeout: 10000 });

  // Create project
  await page.goto("/dashboard");
  await page.getByText("New site").click();
  await page.getByLabel("Name").fill(PROJECT_NAME);
  await page.getByRole("button", { name: "Create site" }).click();
  await expect(page).toHaveURL(/\/projects\/[a-z0-9-]+/, { timeout: 10000 });

  const projectMatch = page.url().match(/\/projects\/([a-z0-9-]+)/);
  if (!projectMatch) throw new Error("could not parse project id from URL");
  const projectId = projectMatch[1];
  projectSettingsUrl = `/projects/${projectId}/settings`;

  // Create doc
  await page.getByRole("button", { name: "New document" }).click();
  await expect(page).toHaveURL(/\/projects\/.+\/docs\/.+/, { timeout: 10000 });
  const docMatch = page.url().match(/\/docs\/([a-z0-9-]+)/);
  if (!docMatch) throw new Error("could not parse doc id from URL");
  const docId = docMatch[1];

  // Build the doc body. Many short paragraphs (not one long line - Lezer's
  // markdown parser drops subsequent headings after very long single-line
  // paragraphs) so the doc is taller than the viewport but parses cleanly.
  // 30 paragraphs per section gives roughly 1500px below the last heading -
  // enough that even the bottom-most heading can scroll flush to the top of
  // the viewport rather than bumping against max-scroll.
  const sectionFiller = Array.from({ length: 30 }, () =>
    "Lorem ipsum dolor sit amet, consectetur adipiscing elit.\n\n",
  ).join("");
  const content = [
    "# Alpha Section",
    "",
    sectionFiller,
    "## Beta Section",
    "",
    sectionFiller,
    "## Gamma Section",
    "",
    sectionFiller,
    "## Delta Section",
    "",
    sectionFiller,
  ].join("\n");

  // Set content via the API rather than typing it. UI typing dropped lines
  // under load (the `## Beta` and `## Gamma` headings went missing entirely),
  // and the test doesn't need to exercise the editor input path anyway.
  const putResult = await page.evaluate(async ({ docId, title, content }) => {
    const token = localStorage.getItem("token");
    const res = await fetch(`/api/docs/${docId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ title, content }),
    });
    return { status: res.status, body: await res.text() };
  }, { docId, title: "Scroll Test Doc", content });
  if (putResult.status !== 200) {
    throw new Error(`PUT /docs/${docId} failed (${putResult.status}): ${putResult.body}`);
  }

  // Publish the site so PublicDocPage will serve the content.
  await page.goto(projectSettingsUrl);
  await page.getByRole("button", { name: "Publish site" }).click();
  await expect(page.getByRole("button", { name: "Unpublish" })).toBeVisible({ timeout: 10000 });

  publicDocUrl = `/s/${projectId}/${docId}`;
});

test("URL #hash scrolls deep heading to viewport top", async () => {
  await page.goto(`${publicDocUrl}#delta-section`);
  await expect(page.locator(".cm-content")).toBeVisible({ timeout: 10000 });
  await expectTopVisibleHeading(page, "Delta Section");
});

test("URL #hash scrolls shallower heading to viewport top", async () => {
  await page.goto(`${publicDocUrl}#beta-section`);
  await expect(page.locator(".cm-content")).toBeVisible({ timeout: 10000 });
  await expectTopVisibleHeading(page, "Beta Section");
});

test("outline click scrolls to heading and updates URL hash", async () => {
  await page.goto(publicDocUrl);
  await expect(page.locator(".cm-content")).toBeVisible({ timeout: 10000 });

  const outline = page.locator("aside", { hasText: "Outline" });
  await outline.getByRole("button", { name: "Gamma Section" }).click();

  await expect(page).toHaveURL(/#gamma-section$/, { timeout: 3000 });
  await expectTopVisibleHeading(page, "Gamma Section");
});

test("consecutive outline clicks each scroll to their heading", async () => {
  // Back-to-back outline clicks would expose state leaks between scroll
  // attempts - earlier we had inconsistent behaviour from this exact pattern.
  const outline = page.locator("aside", { hasText: "Outline" });

  await outline.getByRole("button", { name: "Beta Section" }).click();
  await expect(page).toHaveURL(/#beta-section$/, { timeout: 3000 });
  await expectTopVisibleHeading(page, "Beta Section");

  await outline.getByRole("button", { name: "Delta Section" }).click();
  await expect(page).toHaveURL(/#delta-section$/, { timeout: 3000 });
  await expectTopVisibleHeading(page, "Delta Section");

  await outline.getByRole("button", { name: "Alpha Section" }).click();
  await expect(page).toHaveURL(/#alpha-section$/, { timeout: 3000 });
  await expectTopVisibleHeading(page, "Alpha Section");
});

test("clicking outline after manually scrolling to the bottom still scrolls back up", async () => {
  // Regression: when the user has scrolled all the way down, outline clicks
  // targeting headings near the top were silently failing because the target
  // line had been virtualised out of the DOM by CodeMirror.
  await page.goto(publicDocUrl);
  await expect(page.locator(".cm-content")).toBeVisible({ timeout: 10000 });

  // Drive the viewport to the bottom directly - we don't care how it got
  // there, only that scrolling back to a top heading works.
  await page.evaluate(() => {
    const vp = document.querySelector("[data-radix-scroll-area-viewport]") as HTMLElement | null;
    if (vp) vp.scrollTop = vp.scrollHeight;
  });

  const outline = page.locator("aside", { hasText: "Outline" });
  await outline.getByRole("button", { name: "Alpha Section" }).click();

  await expect(page).toHaveURL(/#alpha-section$/, { timeout: 3000 });
  await expectTopVisibleHeading(page, "Alpha Section");
});
