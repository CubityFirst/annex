/**
 * E2E test covering rendering of the full markdown surface area on a real doc.
 *
 * Prerequisites - run from the monorepo root before starting tests:
 *   pnpm dev
 *
 * Also set TURNSTILE_SECRET=1x0000000000000000000000000000000AA in
 * packages/auth/.dev.vars (Cloudflare's always-pass test secret).
 *
 * Strategy: instead of typing each markdown element through the editor (which
 * is slow and surfaces typing-time autocomplete behaviours, not rendering),
 * PUT the doc body through the API, then assert the *reading mode* DOM
 * renders all of them correctly - headings, lists, code, callouts, wikilinks,
 * underline, image attrs, tables, dice, frontmatter title override, footnotes,
 * blockquotes, links, inline formatting, task lists, horizontal rules.
 */

import { test, expect, type BrowserContext, type Page } from "@playwright/test";

const RUN_ID = Date.now();
const EMAIL = `e2e-md-${RUN_ID}@example.com`;
const PASSWORD = "E2eTest-P@ssw0rd!";
const NAME = "E2E Markdown User";
const PROJECT_NAME = `E2E Project Markdown ${RUN_ID}`;
const FAKE_IP = `10.${Math.floor(RUN_ID / 1e10) % 256}.${Math.floor(RUN_ID / 1e7) % 256}.${(RUN_ID + 6) % 256}`;

let context: BrowserContext;
let page: Page;
let projectId = "";
let docId = "";
let linkedDocId = "";
let projectSettingsUrl = "";

async function mockTurnstile(ctx: BrowserContext) {
  await ctx.addInitScript(() => {
    Object.defineProperty(window, "turnstile", {
      value: {
        render(_c: unknown, opts: { callback: (t: string) => void }) {
          setTimeout(() => opts.callback("e2e-bypass-token"), 50);
          return "mock-widget-id";
        },
        reset() {},
        remove() {},
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

async function putDoc(p: Page, id: string, title: string, content: string) {
  // Retry once on 5xx - local wrangler dev intermittently drops requests
  // through the browser → vite → worker chain.
  const result = await p.evaluate(async ({ id, title, content }) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = localStorage.getItem("token");
      const res = await fetch(`/api/docs/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ title, content }),
      });
      if (res.status === 200) return { status: 200, body: "" };
      const body = await res.text();
      if (attempt === 0 && res.status >= 500) {
        await new Promise(r => setTimeout(r, 300));
        continue;
      }
      return { status: res.status, body };
    }
    return { status: 0, body: "" };
  }, { id, title, content });
  if (result.status !== 200) throw new Error(`PUT /docs/${id} failed (${result.status}): ${result.body}`);
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

test("sets up an account, project, and two docs (one as wikilink target)", async () => {
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

  // Target doc - wikilink references its title.
  await page.getByRole("button", { name: "New document" }).click();
  await expect(page).toHaveURL(/\/projects\/.+\/docs\/.+/, { timeout: 10000 });
  linkedDocId = page.url().match(/\/docs\/([a-z0-9-]+)/)![1];
  await putDoc(page, linkedDocId, "Linked Doc", "# Linked Doc body");

  // Main doc that exercises markdown.
  await page.goto(`/projects/${projectId}`);
  await page.getByRole("button", { name: "New document" }).click();
  await expect(page).toHaveURL(/\/projects\/.+\/docs\/.+/, { timeout: 10000 });
  docId = page.url().match(/\/docs\/([a-z0-9-]+)/)![1];
});

test("renders every supported markdown element in reading mode", async () => {
  const body = [
    "# H1 Heading",
    "## H2 Heading",
    "### H3 Heading",
    "",
    "Plain paragraph with **bold**, *italic*, __underline__, ~~strike~~, and `inline code`.",
    "",
    "A [link to example](https://example.com) and a [[Linked Doc]] wikilink.",
    "",
    "> Plain blockquote",
    "",
    "> [!note] Note callout",
    "> This is a note.",
    "",
    "> [!warning]+ Folded warning",
    "> Body content.",
    "",
    "- Bullet item one",
    "- Bullet item two",
    "  - Nested bullet",
    "",
    "1. Ordered one",
    "2. Ordered two",
    "",
    "- [ ] Open task",
    "- [x] Done task",
    "",
    "| Col A | Col B |",
    "| --- | --- |",
    "| a1 | b1 |",
    "| a2 | b2 |",
    "",
    "```js",
    "const x = 42;",
    "```",
    "",
    "---",
    "",
    "Rolling `dice: 1d20` for damage.",
    "",
    "![[alt-text]](https://placehold.co/40){width=40 height=40}",
    "",
    "Footnote ref[^1].",
    "",
    "[^1]: Footnote body.",
  ].join("\n");

  await putDoc(page, docId, "Markdown Showcase", body);

  // Open in reading mode (DocPage default after save).
  await page.goto(`/projects/${projectId}/docs/${docId}`);
  await expect(page.locator(".cm-content")).toBeVisible({ timeout: 10000 });

  // The body in reading mode is rendered by CodeMirror (decoration-based
  // inline widgets) for on-screen display. A parallel react-markdown render
  // lives in `.pdf-print-mirror` for the PDF print path and is the cleanest
  // place to assert semantic HTML output of remark plugins, because it
  // contains real <h1>/<table>/<code> elements regardless of CM virtualization.
  const mirror = page.locator(".pdf-print-mirror");
  await expect(mirror).toHaveCount(1);

  // The doc title is rendered as a real <h1> in the article header.
  await expect(page.getByRole("heading", { name: "Markdown Showcase" })).toBeVisible({ timeout: 5000 });

  // Headings - react-markdown emits h1/h2/h3 from the body markdown.
  await expect(mirror.locator("h1", { hasText: "H1 Heading" })).toHaveCount(1);
  await expect(mirror.locator("h2", { hasText: "H2 Heading" })).toHaveCount(1);
  await expect(mirror.locator("h3", { hasText: "H3 Heading" })).toHaveCount(1);

  // Inline formatting - render as <strong>, <em>, <u>, <del>, <code>.
  await expect(mirror.locator("strong", { hasText: "bold" })).toHaveCount(1);
  await expect(mirror.locator("em", { hasText: "italic" })).toHaveCount(1);
  await expect(mirror.locator("u", { hasText: "underline" })).toHaveCount(1);
  await expect(mirror.locator("del", { hasText: "strike" })).toHaveCount(1);
  await expect(mirror.locator("code", { hasText: "inline code" })).toHaveCount(1);

  // Plain link and wikilink.
  await expect(mirror.locator("a", { hasText: "link to example" })).toHaveAttribute("href", "https://example.com");
  await expect(mirror.locator("a", { hasText: "Linked Doc" })).toHaveCount(1);

  // Callouts surface via data-callout attribute on a blockquote container.
  // The fold marker (`+`/`-`) parsing is covered by the remark-callouts unit
  // tests - here we just need to confirm both callout types render in DOM.
  await expect(mirror.locator("[data-callout='note']")).toHaveCount(1);
  await expect(mirror.locator("[data-callout='warning']")).toHaveCount(1);

  // Lists. hasText matches ancestors too (a parent <li> that contains a
  // nested <li> matches "Nested bullet"), so assert ≥1 rather than ==1.
  expect(await mirror.locator("ul li", { hasText: "Bullet item one" }).count()).toBeGreaterThanOrEqual(1);
  expect(await mirror.locator("ul li", { hasText: "Nested bullet" }).count()).toBeGreaterThanOrEqual(1);
  expect(await mirror.locator("ol li", { hasText: "Ordered one" }).count()).toBeGreaterThanOrEqual(1);
  await expect(mirror.locator("input[type='checkbox']")).toHaveCount(2);

  // Table.
  await expect(mirror.locator("table")).toHaveCount(1);
  await expect(mirror.locator("th", { hasText: "Col A" })).toHaveCount(1);
  await expect(mirror.locator("td", { hasText: "a1" })).toHaveCount(1);

  // Code block - react-markdown emits pre > code.
  await expect(mirror.locator("pre code")).toContainText("const x = 42");

  // Horizontal rule.
  await expect(mirror.locator("hr")).toHaveCount(1);

  // Image with size attrs applied as inline style.
  const img = mirror.locator("img").first();
  await expect(img).toHaveAttribute("style", /width:\s*40px/);

  // Footnote: gfm renders a ref link "1" plus a footnote list with body text.
  await expect(mirror.locator("a[href*='fn-1']").first()).toHaveCount(1);
  await expect(mirror).toContainText("Footnote body.");

  // The DiceRoll widget is a CodeMirror decoration so it lives inside the
  // on-screen .cm-content rather than the print mirror. Confirm at least one
  // dice button rendered (the parser turned `1d20` into a clickable widget).
  await expect(page.locator(".cm-content button").filter({ hasText: "1d20" }).first()).toBeVisible({ timeout: 5000 });
});

test("frontmatter title override is honored in reading mode", async () => {
  const body = [
    "---",
    "title: Override Title",
    "description: From frontmatter",
    "---",
    "",
    "Body content.",
  ].join("\n");

  // Reuse the existing doc - frontmatter title swaps the rendered <h1>.
  await putDoc(page, docId, "Stored Title", body);
  await page.goto(`/projects/${projectId}/docs/${docId}`);
  await expect(page.locator(".cm-content")).toBeVisible({ timeout: 10000 });
  await expect(page.getByRole("heading", { name: "Override Title" }).first()).toBeVisible({ timeout: 5000 });
});

test("raw markdown is preserved on round-trip through the API", async () => {
  const body = "## Roundtrip\n\nHello **world**.";
  await putDoc(page, docId, "Roundtrip Doc", body);

  // Fetching the doc back via the API is the cleanest source-of-truth check.
  // Editing mode decorations hide certain marker characters (e.g. inline `**`
  // when the cursor isn't on the line), so reading the CodeMirror DOM is the
  // wrong layer to compare a round-trip against.
  const stored = await page.evaluate(async ({ id }) => {
    const token = localStorage.getItem("token");
    const res = await fetch(`/api/docs/${id}`, { headers: { Authorization: `Bearer ${token}` } });
    const json = await res.json() as { ok: boolean; data?: { title: string; content: string } };
    return json.data;
  }, { id: docId });
  expect(stored?.title).toBe("Roundtrip Doc");
  expect(stored?.content).toBe(body);
});
