/**
 * E2E test for large-document handling.
 *
 * Prerequisites - run from the monorepo root before starting tests:
 *   pnpm dev
 *
 * Covers:
 *   - Creating a ~200 KB doc body via the API
 *   - Loading the doc and confirming the editor mounts without hang
 *   - Late headings render (Lezer markdown grammar handles paragraph-heavy docs)
 *   - Switching to editing mode preserves the source
 */

import { test, expect, type BrowserContext, type Page } from "@playwright/test";

const RUN_ID = Date.now();
const EMAIL = `e2e-bigdoc-${RUN_ID}@example.com`;
const PASSWORD = "E2eTest-P@ssw0rd!";
const NAME = "E2E Bigdoc User";
const PROJECT_NAME = `E2E Project Bigdoc ${RUN_ID}`;
const FAKE_IP = `10.${Math.floor(RUN_ID / 1e10) % 256}.${Math.floor(RUN_ID / 1e7) % 256}.${(RUN_ID + 8) % 256}`;

let context: BrowserContext;
let page: Page;
let projectId = "";
let docId = "";
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

test("creates a project and uploads a ~200 KB markdown doc", async () => {
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
  projectId = page.url().match(/\/projects\/([a-z0-9-]+)/)![1];
  projectSettingsUrl = `/projects/${projectId}/settings`;

  await page.getByRole("button", { name: "New document" }).click();
  await expect(page).toHaveURL(/\/projects\/.+\/docs\/.+/, { timeout: 10000 });
  docId = page.url().match(/\/docs\/([a-z0-9-]+)/)![1];

  // Build a doc with 25 sections, each ~80 paragraphs. Markdown is paragraph
  // heavy (not a single huge line) so the Lezer grammar parses each heading.
  const filler = Array.from({ length: 80 }, () =>
    "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.\n\n",
  ).join("");
  const sections = Array.from({ length: 25 }, (_, i) =>
    `## Section ${i + 1}\n\n${filler}\n`,
  );
  const content = ["# Big Document", "", ...sections].join("\n");
  // Sanity: target a chunky but well-below-2MB-cap doc.
  expect(content.length).toBeGreaterThan(150_000);

  const result = await page.evaluate(async ({ id, content }) => {
    const token = localStorage.getItem("token");
    const res = await fetch(`/api/docs/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ title: "Big Document", content }),
    });
    return { status: res.status, body: await res.text() };
  }, { id: docId, content });
  expect(result.status).toBe(200);
});

test("loads the big doc without timing out and renders the first and last sections", async () => {
  await page.goto(`/projects/${projectId}/docs/${docId}`);
  await expect(page.locator(".cm-content")).toBeVisible({ timeout: 20000 });

  // The article title is a real <h1> (data-pdf-title); body headings are
  // rendered through CodeMirror (virtualised) on screen and through
  // react-markdown in `.pdf-print-mirror` for print, where they exist as
  // real DOM headings regardless of scroll position.
  await expect(page.getByRole("heading", { name: "Big Document" })).toBeVisible({ timeout: 10000 });

  // Read all h2 texts directly so we can match on exact equality without
  // role-name heuristics (which can fold whitespace / drop trailing chars).
  const mirrorHeadings = await page.evaluate(() => {
    return Array.from(document.querySelectorAll(".pdf-print-mirror h2"))
      .map(h => (h.textContent ?? "").trim());
  });
  expect(mirrorHeadings).toContain("Section 1");
  expect(mirrorHeadings).toContain("Section 25");
  // And confirm we got the full sequence (all 25 sections rendered).
  expect(mirrorHeadings.filter(t => /^Section \d+$/.test(t))).toHaveLength(25);

  // Sanity-check that the doc loaded without rendering errors. We don't
  // assert on CodeMirror virtualisation behaviour here (it's covered by
  // scroll-to-heading.spec.ts); the print-mirror counts above already prove
  // the body parsed end-to-end.
});

test("editing mode of a big doc still mounts and preserves the source", async () => {
  await page.getByTitle("Edit document").click();
  await expect(page.locator(".cm-content")).toBeVisible({ timeout: 10000 });

  // We can't easily read the entire 200 KB source in one go because CM
  // virtualises lines outside the viewport - but the first line ("# Big
  // Document") and the next ("## Section 1") should be in the DOM.
  await expect.poll(async () => {
    return page.evaluate(() => {
      const lines = Array.from(document.querySelectorAll(".cm-content .cm-line"));
      return lines.map(l => l.textContent ?? "").join("\n");
    });
  }, { timeout: 5000 }).toContain("# Big Document");
});
