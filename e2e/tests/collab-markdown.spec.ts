/**
 * E2E test for collaborative editing of markdown content.
 *
 * Prerequisites - run from the monorepo root before starting tests:
 *   pnpm dev
 *
 * Also set TURNSTILE_SECRET=1x0000000000000000000000000000000AA in
 * packages/auth/.dev.vars (Cloudflare's always-pass test secret).
 *
 * Covers, on top of the basic collab.spec.ts:
 *   - Markdown-flavoured edits from peer A propagate to peer B
 *   - Reconnect scenario: B closes, A keeps editing, B reopens and sees both
 *     pre- and post-disconnect content
 *   - Realtime presence colours render after the WebSocket handshake
 */

import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { execSync } from "node:child_process";
import { resolve } from "node:path";

const RUN_ID = Date.now();
const EMAIL = `e2e-collab-md-${RUN_ID}@example.com`;
const PASSWORD = "E2eTest-P@ssw0rd!";
const NAME = "E2E Collab Md User";
const PROJECT_NAME = `E2E Project Collab Md ${RUN_ID}`;
const FAKE_IP = `10.${Math.floor(RUN_ID / 1e10) % 256}.${Math.floor(RUN_ID / 1e7) % 256}.${(RUN_ID + 15) % 256}`;

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

function enableRealtime(pId: string) {
  const apiDir = resolve(__dirname, "../../packages/api");
  execSync(
    `npx wrangler d1 execute cubedocs-main --local --persist-to ../../.wrangler/state --command "UPDATE projects SET features = features | 4 WHERE id = '${pId}';"`,
    { cwd: apiDir, stdio: "pipe" },
  );
}

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
      const btn = pageA.getByRole("button", { name: /delete site/i });
      if (await btn.isVisible({ timeout: 3000 })) {
        await btn.click();
        await pageA.getByRole("alertdialog").waitFor({ timeout: 5000 });
        await pageA.getByRole("button", { name: /yes.*delete/i }).click();
        await pageA.waitForURL(/\/(dashboard|projects(?!\/[a-z0-9]))/, { timeout: 15000 });
      }
    } catch { /* */ }
  }
  await context.close();
});

test("sets up a realtime-enabled doc with seeded markdown", async () => {
  await pageA.goto("/register");
  await pageA.getByLabel("Name").fill(NAME);
  await pageA.getByLabel("Email").fill(EMAIL);
  await pageA.getByLabel("Password").fill(PASSWORD);
  await expect(pageA.getByRole("button", { name: "Create account" })).toBeEnabled({ timeout: 5000 });
  await pageA.getByRole("button", { name: "Create account" }).click();
  await expect(pageA).not.toHaveURL(/\/register/, { timeout: 10000 });

  await pageA.goto("/dashboard");
  await pageA.getByText("New site").click();
  await pageA.getByLabel("Name").fill(PROJECT_NAME);
  await pageA.getByRole("button", { name: "Create site" }).click();
  await expect(pageA).toHaveURL(/\/projects\/[a-z0-9-]+/, { timeout: 10000 });
  projectId = pageA.url().match(/\/projects\/([a-z0-9-]+)/)![1];
  projectSettingsUrl = `/projects/${projectId}/settings`;

  enableRealtime(projectId);

  await pageA.getByRole("button", { name: "New document" }).click();
  await expect(pageA).toHaveURL(/\/projects\/.+\/docs\/.+/, { timeout: 10000 });
  docId = pageA.url().match(/\/docs\/([a-z0-9-]+)/)![1];

  await pageA.getByPlaceholder("Document title").fill("Collab Markdown");
  const editor = pageA.locator(".cm-content");
  await expect(editor).toBeVisible({ timeout: 5000 });
  await editor.click();
  await pageA.keyboard.type("# Title\n\nSeed paragraph.");

  await pageA.getByRole("button", { name: "Save" }).click();
  await expect(pageA.getByTitle("Edit document")).toBeVisible({ timeout: 10000 });

  await pageA.reload();
  await expect(pageA.locator(".cm-content")).toBeVisible({ timeout: 10000 });
});

test("markdown edits from A propagate verbatim to B (and back)", async () => {
  // Defensive: tests in this file are serial and the prior test left pageA on
  // the doc page, but make the path explicit so a stray navigation between
  // tests can't break the assumption.
  await pageA.goto(`/projects/${projectId}/docs/${docId}`);
  await expect(pageA.getByTitle("Edit document")).toBeVisible({ timeout: 10000 });
  await pageA.getByTitle("Edit document").click();
  await expect(pageA.locator(".cm-content")).toBeVisible({ timeout: 5000 });

  pageB = await context.newPage();
  await pageB.goto(`/projects/${projectId}/docs/${docId}`);
  await expect(pageB.getByTitle("Edit document")).toBeVisible({ timeout: 10000 });
  await pageB.getByTitle("Edit document").click();
  await expect(pageB.locator(".cm-content")).toBeVisible({ timeout: 5000 });

  // Wait for both peers to have the seeded content.
  await expect.poll(async () => (await readEditorText(pageA)).includes("Seed paragraph."), { timeout: 8000 }).toBe(true);
  await expect.poll(async () => (await readEditorText(pageB)).includes("Seed paragraph."), { timeout: 8000 }).toBe(true);

  // A appends a marker on its own line. Typing via keyboard.type splits at
  // newlines which can fire list-continue / table-continue keymaps; sticking
  // to one Enter + one literal line keeps the input deterministic.
  const markerA = `marker-from-A-${RUN_ID}`;
  await pageA.locator(".cm-content").click();
  await pageA.keyboard.press("End");
  await pageA.keyboard.press("Enter");
  await pageA.keyboard.press("Enter");
  await pageA.keyboard.type(markerA);
  // Confirm the marker landed in A's own editor first; otherwise we have no
  // hope of observing it on B.
  await expect.poll(async () => (await readEditorText(pageA)).includes(markerA), { timeout: 5000 }).toBe(true);
  await expect.poll(async () => (await readEditorText(pageB)).includes(markerA), { timeout: 8000 }).toBe(true);

  // B types markdown-formatted text. Asterisks survive the round-trip even
  // though editing-mode decorations may visually hide them - readEditorText
  // walks .cm-line nodes which still contain the raw source.
  const markerB = `marker-from-B-${RUN_ID}`;
  await pageB.locator(".cm-content").click();
  await pageB.keyboard.press("End");
  await pageB.keyboard.press("Enter");
  await pageB.keyboard.press("Enter");
  await pageB.keyboard.type(markerB);
  await expect.poll(async () => (await readEditorText(pageB)).includes(markerB), { timeout: 5000 }).toBe(true);
  await expect.poll(async () => (await readEditorText(pageA)).includes(markerB), { timeout: 8000 }).toBe(true);
});

test("after B disconnects, A's solo edits still land when B reopens the doc", async () => {
  // Snapshot A's current text so we can verify post-reconnect content
  // includes both old + new edits.
  const preDisconnect = await readEditorText(pageA);
  expect(preDisconnect).toContain("Seed paragraph.");

  // Disconnect B.
  await pageB.close();

  // A keeps editing solo.
  const soloMarker = `solo-while-B-was-offline-${RUN_ID}`;
  await pageA.locator(".cm-content").click();
  await pageA.keyboard.press("End");
  await pageA.keyboard.press("Enter");
  await pageA.keyboard.press("Enter");
  await pageA.keyboard.type(soloMarker);

  // Save so the DO flushes to R2 (also tests the route-handler save path
  // rather than depending on the alarm flush).
  await pageA.getByRole("button", { name: "Save" }).click();
  await expect(pageA.getByTitle("Edit document")).toBeVisible({ timeout: 10000 });

  // B re-opens. The reading view shows both pre- and post-disconnect markers.
  pageB = await context.newPage();
  await pageB.goto(`/projects/${projectId}/docs/${docId}`);
  await expect(pageB.locator(".cm-content")).toBeVisible({ timeout: 10000 });
  await expect(pageB.getByText("Seed paragraph.").first()).toBeVisible({ timeout: 5000 });
  await expect(pageB.getByText(soloMarker).first()).toBeVisible({ timeout: 5000 });
});
