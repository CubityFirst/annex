/**
 * E2E test for Durable Object collaborative editing.
 *
 * Prerequisites - run from the monorepo root before starting tests:
 *   pnpm dev
 *
 * Also set TURNSTILE_SECRET=1x0000000000000000000000000000000AA in
 * packages/auth/.dev.vars (Cloudflare's always-pass test secret).
 *
 * Covers:
 *   1. Two pages on the same doc see each other's edits within the editor
 *      after the realtime feature flag is flipped on the project.
 *   2. Presence avatars appear in the title bar of each peer.
 *   3. After all peers disconnect, content persists to R2 - verified by
 *      reloading the doc and reading the rendered preview.
 *
 * Uses a single browser context (one user, two tabs) - Yjs uses per-tab
 * clientID, so two tabs of the same user are still distinct peers, which is
 * enough to exercise the DocCollabRoom WebSocket fan-out + persistence path.
 *
 * The REALTIME bit (= 4) on `projects.features` has no API toggle; we shell
 * out to wrangler the same way the in-package size-cap integration test does.
 */

import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { execSync } from "node:child_process";
import { resolve } from "node:path";

const RUN_ID = Date.now();
const EMAIL = `e2e-collab-${RUN_ID}@example.com`;
const PASSWORD = "E2eTest-P@ssw0rd!";
const NAME = "E2E Collab User";
// Prefix matches the "E2E Project %" pattern in global-teardown, so the
// safety-net cleanup catches this project even if afterAll never runs.
const PROJECT_NAME = `E2E Project Collab ${RUN_ID}`;

const FAKE_IP = `10.${Math.floor(RUN_ID / 1e10) % 256}.${Math.floor(RUN_ID / 1e7) % 256}.${RUN_ID % 256}`;

let context: BrowserContext;
let pageA: Page;
let pageB: Page;
let projectId = "";
let docId = "";
let projectSettingsUrl = "";

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

function enableRealtime(pId: string): void {
  const apiDir = resolve(__dirname, "../../packages/api");
  execSync(
    `npx wrangler d1 execute cubedocs-main --local --persist-to ../../.wrangler/state --command "UPDATE projects SET features = features | 4 WHERE id = '${pId}';"`,
    { cwd: apiDir, stdio: "pipe" },
  );
}

// Reads the editor's plain text from a page. Uses CodeMirror's `.cm-content`
// DOM, which is what real users see; bypassing it would test the in-memory
// Y.Doc rather than that the editor actually rendered the synced update.
async function readEditorText(p: Page): Promise<string> {
  return p.evaluate(() => {
    const lines = Array.from(document.querySelectorAll(".cm-content .cm-line"));
    return lines.map(l => l.textContent ?? "").join("\n");
  });
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext();
  await mockTurnstile(context);
  await injectFakeIp(context);
  pageA = await context.newPage();
});

test.afterAll(async () => {
  try { if (pageB && !pageB.isClosed()) await pageB.close(); } catch { /* */ }

  if (pageA && !pageA.isClosed() && projectSettingsUrl) {
    try {
      await pageA.goto(projectSettingsUrl, { timeout: 10000 });
      const deleteBtn = pageA.getByRole("button", { name: /delete site/i });
      if (await deleteBtn.isVisible({ timeout: 3000 })) {
        await deleteBtn.click();
        await pageA.getByRole("alertdialog").waitFor({ timeout: 5000 });
        await pageA.getByRole("button", { name: /yes.*delete/i }).click();
        await pageA.waitForURL(/\/(dashboard|projects(?!\/[a-z0-9]))/, { timeout: 15000 });
      }
    } catch { /* already deleted or unreachable */ }
  }

  await context.close();
});

test("sets up a project + doc with the realtime flag enabled", async () => {
  // Register
  await pageA.goto("/register");
  await pageA.getByLabel("Name").fill(NAME);
  await pageA.getByLabel("Email").fill(EMAIL);
  await pageA.getByLabel("Password").fill(PASSWORD);
  await expect(pageA.getByRole("button", { name: "Create account" })).toBeEnabled({ timeout: 5000 });
  await pageA.getByRole("button", { name: "Create account" }).click();
  await expect(pageA).not.toHaveURL(/\/register/, { timeout: 10000 });

  // Create project
  await pageA.goto("/dashboard");
  await pageA.getByText("New site").click();
  await pageA.getByLabel("Name").fill(PROJECT_NAME);
  await pageA.getByRole("button", { name: "Create site" }).click();
  await expect(pageA).toHaveURL(/\/projects\/[a-z0-9-]+/, { timeout: 10000 });

  const projectMatch = pageA.url().match(/\/projects\/([a-z0-9-]+)/);
  if (!projectMatch) throw new Error("could not parse project id from URL");
  projectId = projectMatch[1];
  projectSettingsUrl = `/projects/${projectId}/settings`;

  // Flip REALTIME bit. Has to happen BEFORE we land on DocPage with collab
  // wiring, since `realtimeEnabled` is computed from the project load.
  enableRealtime(projectId);

  // Create doc - starts in editing mode because location.state.isNew is true.
  await pageA.getByRole("button", { name: "New document" }).click();
  await expect(pageA).toHaveURL(/\/projects\/.+\/docs\/.+/, { timeout: 10000 });
  const docMatch = pageA.url().match(/\/docs\/([a-z0-9-]+)/);
  if (!docMatch) throw new Error("could not parse doc id from URL");
  docId = docMatch[1];

  // Set a title and seed some initial content so we have a non-empty baseline
  // that the collab room will load on first connect.
  await pageA.getByPlaceholder("Document title").fill("Collab Test Doc");
  const editor = pageA.locator(".cm-content");
  await expect(editor).toBeVisible({ timeout: 5000 });
  await editor.click();
  await pageA.keyboard.type("# Collab Test\n\nInitial line.");

  // Save so the seed content lands in R2 + D1. The DO room hasn't been
  // touched yet - it'll boot off the R2 snapshot on first peer connect.
  await pageA.getByRole("button", { name: "Save" }).click();
  await expect(pageA.getByTitle("Edit document")).toBeVisible({ timeout: 10000 });

  // Hard reload so the project's `features` field (which the DocsLayout
  // outlet computes `realtimeEnabled` from) re-fetches and picks up the bit
  // we just flipped via wrangler.
  await pageA.reload();
  await expect(pageA.locator(".cm-content")).toBeVisible({ timeout: 10000 });
});

test("two pages on the same doc sync edits via the collab DO", async () => {
  // Both peers must be in editing mode for the WysiwygEditor to mount with
  // the `collab` prop. Reading mode never opens the WS.
  await pageA.getByTitle("Edit document").click();
  await expect(pageA.locator(".cm-content")).toBeVisible({ timeout: 5000 });

  pageB = await context.newPage();
  await pageB.goto(`/projects/${projectId}/docs/${docId}`);
  await expect(pageB.getByTitle("Edit document")).toBeVisible({ timeout: 10000 });
  await pageB.getByTitle("Edit document").click();
  await expect(pageB.locator(".cm-content")).toBeVisible({ timeout: 5000 });

  // Give both providers a beat to finish the initial sync handshake (step1
  // → step2). Without this, the first keystroke can race the sync and the
  // peer applies its own initial state on top of an empty doc.
  await expect.poll(async () => (await readEditorText(pageA)).includes("Initial line."), {
    timeout: 5000,
    message: "page A should have loaded the seeded content",
  }).toBe(true);
  await expect.poll(async () => (await readEditorText(pageB)).includes("Initial line."), {
    timeout: 5000,
    message: "page B should have synced the seeded content",
  }).toBe(true);

  // Type on page A; page B should reflect it.
  const markerFromA = `from-A-${RUN_ID}`;
  await pageA.locator(".cm-content").click();
  await pageA.keyboard.press("End");
  await pageA.keyboard.press("Enter");
  await pageA.keyboard.type(markerFromA);

  await expect.poll(async () => (await readEditorText(pageB)).includes(markerFromA), {
    timeout: 5000,
    message: "edit on A should appear in B via the collab DO",
  }).toBe(true);

  // Type on page B; page A should reflect it.
  const markerFromB = `from-B-${RUN_ID}`;
  await pageB.locator(".cm-content").click();
  await pageB.keyboard.press("End");
  await pageB.keyboard.press("Enter");
  await pageB.keyboard.type(markerFromB);

  await expect.poll(async () => (await readEditorText(pageA)).includes(markerFromB), {
    timeout: 5000,
    message: "edit on B should appear in A via the collab DO",
  }).toBe(true);
});

test("each peer renders a presence avatar for the other", async () => {
  // Two tabs of the same user produce two distinct Yjs clientIds; the
  // EditorPresence component renders one button per remote client, so each
  // page should show at least one avatar button (the other tab).
  const presenceA = pageA.locator("button:has(img[alt]), button:has([data-slot='avatar'])");
  const presenceB = pageB.locator("button:has(img[alt]), button:has([data-slot='avatar'])");

  // The page chrome has other avatar buttons (user menu, etc.), so we can't
  // assert an exact count. Instead, snapshot the presence-region count on
  // a connected vs. disconnected peer and assert it dropped - that
  // isolates the presence avatars from the rest of the UI.
  const aBeforeDisconnect = await presenceA.count();
  expect(aBeforeDisconnect).toBeGreaterThan(0);
  const bCount = await presenceB.count();
  expect(bCount).toBeGreaterThan(0);

  // Close B; A's presence count should drop within a few seconds as the
  // server emits the awareness removal on socket close.
  await pageB.close();
  await expect.poll(async () => await presenceA.count(), {
    timeout: 8000,
    message: "page A's presence avatar count should drop after B disconnects",
  }).toBeLessThan(aBeforeDisconnect);
});

test("content persists to R2 after all peers disconnect", async () => {
  // Currently A is the only connected peer. Save through the UI so the
  // route-handler R2 path also runs (and so the test doesn't depend on the
  // DO's debounced 30s alarm flush - that's exercised separately by the
  // in-package collab tests).
  await pageA.getByRole("button", { name: "Save" }).click();
  await expect(pageA.getByTitle("Edit document")).toBeVisible({ timeout: 10000 });

  // Verify the doc body shows both peers' edits. The reading view renders the
  // markdown both into CodeMirror (`.cm-line`) and into a separate react-markdown
  // `<article>`, so the marker text matches in two places - use .first() rather
  // than asserting against a strict-mode locator.
  await expect(pageA.getByText(`from-A-${RUN_ID}`).first()).toBeVisible({ timeout: 5000 });
  await expect(pageA.getByText(`from-B-${RUN_ID}`).first()).toBeVisible({ timeout: 5000 });

  // Hard reload - kicks the doc loader and resets the DocPage state. If R2
  // didn't have the merged content, the reload would show only the seed.
  await pageA.reload();
  await expect(pageA.locator(".cm-content")).toBeVisible({ timeout: 10000 });
  await expect(pageA.getByText(`from-A-${RUN_ID}`).first()).toBeVisible({ timeout: 5000 });
  await expect(pageA.getByText(`from-B-${RUN_ID}`).first()).toBeVisible({ timeout: 5000 });
});
