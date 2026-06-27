/**
 * E2E test for file permission locking across projects ("sites"), AUDIO edition.
 *
 * The audio twin of file-permission-lock.spec.ts. Embedded audio goes through
 * the SAME file-content routes and the SAME project-scoping lock as images -
 * only the renderer (AudioEmbed) and its error UI differ.
 *
 * Prerequisites - run from the monorepo root before starting tests:
 *   pnpm dev
 *
 * Scenario (single owner, two sites):
 *   - Create Site A, upload an audio file to Site A, grab its "Copy markdown".
 *   - Create Site B, upload an audio file to Site B, grab its "Copy markdown".
 *   - Create a document in Site B and paste BOTH internal links plus a third
 *     "External URL" audio (https://i.cubityfir.st/explorer_9LHgOrjobE.wav).
 *   - View the doc in reading mode internal to Site B.
 *   - Publish Site B and view the published reader.
 *
 * Expected in BOTH the internal reading view and the published view:
 *   - Site A audio  → "Audio unavailable" error badge. Even though the same
 *     user owns Site A, AudioEmbed fetches it scoped `?projectId=<SiteB>`, and
 *     the file-content route locks files to their owning project, so the
 *     cross-project request 404s. (`packages/api/src/routes/files.ts` /
 *     `routes/public.ts` - same `AND f.project_id = ?` / `(p.id = ? OR
 *     p.vanity_slug = ?)` guard as images; the public route's "images only"
 *     comment is stale, it serves any MIME from a published project.)
 *   - Site B audio  → renders an <audio> player (same project context, member
 *     access, then published access).
 *   - External URL  → renders an <audio> player (not an /api/files/ URL, so it
 *     bypasses the lock entirely).
 *
 * Notes:
 *   - Audio detection (`looksLikeAudio`) keys off the URL extension, falling
 *     back to the alt text when the URL has none. A "Copy markdown" link is
 *     `![<filename>](/api/files/<id>/content)` (no extension), so the uploaded
 *     files MUST be named `*.wav` for the alt to trigger the audio renderer.
 *   - The external audio is intercepted and fulfilled with a tiny valid WAV so
 *     the test is hermetic / offline-deterministic - we are exercising the
 *     renderer branch that treats non-/api/files URLs as a plain <audio> not
 *     subject to the lock, not third-party network availability.
 *   - The doc body is built from the exact "Copy markdown" string format (see
 *     FilePage.tsx; the button is shown for `audio/*` too). On Chromium we
 *     additionally click the real button and assert the clipboard matches;
 *     Firefox can't read the clipboard under Playwright, so there we only
 *     assert the visible "Copied!" feedback.
 */

import { test, expect, type BrowserContext, type Page } from "@playwright/test";

const RUN_ID = Date.now();
const EMAIL = `e2e-audiolock-${RUN_ID}@example.com`;
const PASSWORD = "E2eTest-P@ssw0rd!";
const NAME = "E2E AudioLock User";
const PROJECT_A_NAME = `E2E AudioLock Site A ${RUN_ID}`;
const PROJECT_B_NAME = `E2E AudioLock Site B ${RUN_ID}`;
const FAKE_IP = `10.${Math.floor(RUN_ID / 1e10) % 256}.${Math.floor(RUN_ID / 1e7) % 256}.${(RUN_ID + 31) % 256}`;

// External "URL" audio - intercepted below, never hits the network. The .wav
// extension makes the renderer treat it as audio.
const EXTERNAL_URL = "https://i.cubityfir.st/explorer_9LHgOrjobE.wav";

// Minimal valid 16-bit PCM WAV (8 silent samples @ 8 kHz, 60 bytes). Avoids
// shipping a binary fixture and keeps every upload / fulfilled response tiny.
const TINY_WAV_BASE64 =
  "UklGRjQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YRAAAAAAAAAAAAAAAAAAAAAAAAAA";

// Filenames carry the .wav so the Copy-markdown alt drives audio detection.
const FILE_A_NAME = "siteA.wav";
const FILE_B_NAME = "siteB.wav";
const EXTERNAL_ALT = "external-audio";

let context: BrowserContext;
let page: Page;

let projectAId = "";
let projectBId = "";
let fileAId = "";
let fileBId = "";
let docId = "";

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

// Intercept the external audio so the "External URL renders" assertion does
// not depend on third-party network reachability from the test runner.
async function mockExternalAudio(ctx: BrowserContext) {
  await ctx.route(EXTERNAL_URL, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "audio/wav",
      body: Buffer.from(TINY_WAV_BASE64, "base64"),
    });
  });
}

async function createSite(p: Page, name: string): Promise<string> {
  await p.goto("/dashboard");
  await p.getByText("New site").click();
  await p.getByLabel("Name").fill(name);
  await p.getByRole("button", { name: "Create site" }).click();
  await expect(p).toHaveURL(/\/projects\/[a-z0-9-]+/, { timeout: 10000 });
  return p.url().match(/\/projects\/([a-z0-9-]+)/)![1];
}

// Upload the tiny WAV straight to /api/files (mime audio/wav so the FilePage
// "Copy markdown" button appears and the file is treated as audio).
async function uploadAudio(p: Page, projectId: string, name: string): Promise<string> {
  const id = await p.evaluate(async ({ projectId, name, b64 }) => {
    const token = localStorage.getItem("token");
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const file = new File([bytes], name, { type: "audio/wav" });
    const fd = new FormData();
    fd.append("file", file);
    fd.append("projectId", projectId);
    const res = await fetch("/api/files", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: fd,
    });
    if (res.status !== 200 && res.status !== 201) {
      throw new Error(`upload failed: ${res.status} ${await res.text()}`);
    }
    const json = await res.json();
    return json.data.id as string;
  }, { projectId, name, b64: TINY_WAV_BASE64 });
  return id;
}

async function putDoc(p: Page, id: string, title: string, content: string) {
  // Local wrangler dev intermittently drops requests through the
  // browser → vite → API worker → auth worker chain (per playwright.config.ts).
  // Retry once on 5xx so transient infra hiccups don't cause spurious failures.
  const result = await p.evaluate(async ({ id, title, content }) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = localStorage.getItem("token");
      const res = await fetch(`/api/docs/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ title, content }),
      });
      if (res.status === 200) return 200;
      if (attempt === 0 && res.status >= 500) {
        await new Promise(r => setTimeout(r, 300));
        continue;
      }
      return res.status;
    }
    return 0;
  }, { id, title, content });
  if (result !== 200) throw new Error(`PUT /docs/${id} failed: ${result}`);
}

async function deleteSite(p: Page, projectId: string) {
  try {
    await p.goto(`/projects/${projectId}/settings`, { timeout: 10000 });
    const btn = p.getByRole("button", { name: /delete site/i });
    if (await btn.isVisible({ timeout: 3000 })) {
      await btn.click();
      await p.getByRole("alertdialog").waitFor({ timeout: 5000 });
      await p.getByRole("button", { name: /yes.*delete/i }).click();
      await p.waitForURL(/\/(dashboard|projects(?!\/[a-z0-9]))/, { timeout: 15000 });
    }
  } catch { /* best-effort cleanup */ }
}

// Reading-mode / published-mode assertions are identical - Site A locked,
// Site B + external rendered. The doc body is rendered more than once in the
// DOM (DocPage / PublicDocPage keep a second hidden WysiwygEditor for
// print/PDF export), so assert on .first() for visibility and on
// attribute-scoped counts for the negative cases rather than singletons.
async function assertAudioLockOutcome(p: Page) {
  // Site A: scoped to Site B, the file-content route refuses the cross-project
  // read, and AudioEmbed swaps in its destructive "Audio unavailable" badge
  // (a <span title=<alt>> - distinct text/icon from the image badge).
  const lockedBadge = p.locator(`span[title="${FILE_A_NAME}"]`).first();
  await expect(lockedBadge).toBeVisible({ timeout: 15000 });
  await expect(lockedBadge).toContainText("Audio unavailable");
  // It must NOT have resolved to a real <audio> player.
  await expect(p.locator(`audio[aria-label="${FILE_A_NAME}"]`)).toHaveCount(0);

  // Site B + external both resolve to real <audio> players inside the
  // full-size audio container.
  await expect(p.locator(`audio[aria-label="${FILE_B_NAME}"]`).first()).toBeVisible({ timeout: 15000 });
  await expect(p.locator(`audio[aria-label="${EXTERNAL_ALT}"]`).first()).toBeVisible({ timeout: 15000 });
  await expect(p.locator(".cm-wysiwyg-audio--full").first()).toBeVisible({ timeout: 15000 });

  // Site B / external never produced the failure badge (the badge carries
  // title=<alt>; working players are <audio aria-label=…> instead, so a
  // non-zero count here would mean that file was wrongly locked too).
  await expect(p.locator(`span[title="${FILE_B_NAME}"]`)).toHaveCount(0);
  await expect(p.locator(`span[title="${EXTERNAL_ALT}"]`)).toHaveCount(0);
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext();
  // Clipboard read is only grantable/reliable in Chromium under Playwright.
  if (browser.browserType().name() === "chromium") {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  }
  await mockTurnstile(context);
  await injectFakeIp(context);
  await mockExternalAudio(context);
  page = await context.newPage();
});

test.afterAll(async () => {
  if (page) {
    if (projectBId) await deleteSite(page, projectBId);
    if (projectAId) await deleteSite(page, projectAId);
  }
  // Firefox under Playwright intermittently throws a protocol error from
  // browserContext.close() during teardown (a known Playwright/Gecko quirk,
  // unrelated to anything under test). Swallow it so a clean run isn't
  // reported flaky.
  try { await context.close(); } catch { /* best-effort */ }
});

test("registers, creates Site A + Site B, uploads audio to each, and a doc in Site B", async () => {
  await page.goto("/register");
  await page.getByLabel("Name").fill(NAME);
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await expect(page.getByRole("button", { name: "Create account" })).toBeEnabled({ timeout: 5000 });
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).not.toHaveURL(/\/register/, { timeout: 10000 });

  projectAId = await createSite(page, PROJECT_A_NAME);
  fileAId = await uploadAudio(page, projectAId, FILE_A_NAME);

  projectBId = await createSite(page, PROJECT_B_NAME);
  fileBId = await uploadAudio(page, projectBId, FILE_B_NAME);

  // Create the document in Site B.
  await page.getByRole("button", { name: "New document" }).click();
  await expect(page).toHaveURL(/\/projects\/.+\/docs\/.+/, { timeout: 10000 });
  docId = page.url().match(/\/docs\/([a-z0-9-]+)/)![1];

  expect(projectAId).toBeTruthy();
  expect(projectBId).toBeTruthy();
  expect(fileAId).toBeTruthy();
  expect(fileBId).toBeTruthy();
  expect(docId).toBeTruthy();
});

test("the 'Copy markdown' button copies the canonical /api/files link for audio", async ({ browserName }) => {
  for (const [projectId, fileId, fileName] of [
    [projectAId, fileAId, FILE_A_NAME],
    [projectBId, fileBId, FILE_B_NAME],
  ] as const) {
    await page.goto(`/projects/${projectId}/files/${fileId}`);
    const copyBtn = page.getByRole("button", { name: /copy markdown/i });
    await expect(copyBtn).toBeVisible({ timeout: 10000 });
    await copyBtn.click();

    // Visible feedback flips to "Copied!" on every browser (state is set
    // regardless of clipboard outcome).
    await expect(page.getByRole("button", { name: /copied!/i })).toBeVisible({ timeout: 5000 });

    const expected = `![${fileName}](/api/files/${fileId}/content)`;
    if (browserName === "chromium") {
      const clip = await page.evaluate(() => navigator.clipboard.readText());
      expect(clip).toBe(expected);
    }
  }
});

test("internal reading view locks the Site A audio; Site B + external render", async () => {
  // "Paste both links" + the external URL into the Site B document. This is
  // exactly the markdown the FilePage "Copy markdown" button produces.
  const content = [
    "# Audio Permission Lock",
    "",
    "Cross-project (Site A) audio - must be locked:",
    "",
    `![${FILE_A_NAME}](/api/files/${fileAId}/content)`,
    "",
    "Same-project (Site B) audio - must render:",
    "",
    `![${FILE_B_NAME}](/api/files/${fileBId}/content)`,
    "",
    "External URL audio - must render:",
    "",
    `![${EXTERNAL_ALT}](${EXTERNAL_URL})`,
    "",
  ].join("\n");

  await putDoc(page, docId, "Audio Permission Lock Doc", content);

  // Navigating to the doc opens it in reading mode (rendered <article>).
  await page.goto(`/projects/${projectBId}/docs/${docId}`);
  await expect(page.locator("article, .cm-content").first()).toBeVisible({ timeout: 10000 });

  await assertAudioLockOutcome(page);
});

test("published Site B reader enforces the same audio lock", async () => {
  await page.goto(`/projects/${projectBId}/settings`);
  await page.getByRole("button", { name: "Publish site" }).click();
  await expect(page.getByRole("button", { name: "Unpublish" })).toBeVisible({ timeout: 10000 });

  // /s/<projectId>/<docId> is the always-available public route (vanity slugs
  // need a premium flag); both resolve through PublicDocPage with isPublic.
  await page.goto(`/s/${projectBId}/${docId}`);
  await expect(page.locator("article, .cm-content").first()).toBeVisible({ timeout: 10000 });

  await assertAudioLockOutcome(page);
});
