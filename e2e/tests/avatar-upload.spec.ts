/**
 * E2E test for animated avatar upload.
 *
 * Verifies the full pipeline:
 *   GIF file → AvatarCropDialog decodes frames via gifuct-js → encodes each as
 *   static WebP via canvas.toBlob → muxes into animated WebP via webpMux →
 *   uploads to the API → /api/avatar/:id serves it back with Content-Type
 *   image/webp, RIFF/WEBP framing, and ANIM/ANMF chunks intact.
 *
 * Prerequisites - run from the monorepo root before starting tests:
 *   pnpm dev
 *
 * packages/auth/.dev.vars must contain:
 *   TURNSTILE_SECRET=1x0000000000000000000000000000000AA
 */

import { test, expect, type BrowserContext, type Page } from "@playwright/test";

// ── Unique-per-run values ────────────────────────────────────────────────────

const RUN_ID = Date.now();
const EMAIL = `e2e-avatar-${RUN_ID}@example.com`;
const PASSWORD = "AvatarTest-P@ssw0rd!";
const NAME = "Avatar Upload Test User";
// Offset +3 from app.spec to keep this run's rate-limit bucket separate from
// other suites that may execute in parallel.
const FAKE_IP = `10.${Math.floor(RUN_ID / 1e10) % 256}.${Math.floor(RUN_ID / 1e7) % 256}.${(RUN_ID + 3) % 256}`;

// ── Test fixture: minimal animated GIF ───────────────────────────────────────

// 1×1 pixel, 2 frames, infinite loop, 100ms delay each. Built inline so the
// test ships no binary fixtures. Bytes laid out per the GIF89a spec; the LZW
// payload is the precomputed three-code stream (clear=4, code(0), end=5)
// packed LSB-first into bytes 0x44, 0x01. We just need >1 frame so gifuct-js
// reports it as animated - visual content is irrelevant.
function buildAnimatedGif(): Buffer {
  const frameSection = [
    // Graphics Control Extension
    0x21, 0xF9, 0x04, 0x00, 0x0A, 0x00, 0x00, 0x00,
    // Image Descriptor: 1×1 at (0,0), no local colour table, no interlace
    0x2C, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    // Image Data: min code size 2, sub-block of 2 LZW bytes, terminator
    0x02, 0x02, 0x44, 0x01, 0x00,
  ];
  return Buffer.from([
    // "GIF89a"
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61,
    // Logical Screen Descriptor: 1×1, GCT present (2 colours), bg index 0
    0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00,
    // Global Colour Table: white, black
    0xFF, 0xFF, 0xFF, 0x00, 0x00, 0x00,
    // NETSCAPE2.0 application extension (loop forever)
    0x21, 0xFF, 0x0B,
    0x4E, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45, 0x32, 0x2E, 0x30,
    0x03, 0x01, 0x00, 0x00, 0x00,
    ...frameSection,
    ...frameSection,
    // Trailer
    0x3B,
  ]);
}

// ── Shared state ─────────────────────────────────────────────────────────────

let context: BrowserContext;
let page: Page;
// Set by the upload test, reused by the variant tests below (serial mode).
let userId = "";

// ── Helpers ──────────────────────────────────────────────────────────────────

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

// ── Lifecycle ────────────────────────────────────────────────────────────────

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext();
  await mockTurnstile(context);
  await injectFakeIp(context);
  page = await context.newPage();
});

// Account cleanup runs in globalTeardown (deletes e2e-%@example.com users).
test.afterAll(async () => {
  await context.close();
});

// ── Setup ────────────────────────────────────────────────────────────────────

test("registers a fresh account", async () => {
  await page.goto("/register");
  await page.getByLabel("Name").fill(NAME);
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await expect(page.getByRole("button", { name: "Create account" })).toBeEnabled({ timeout: 5000 });
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).not.toHaveURL(/\/register/, { timeout: 10000 });
});

// ── Upload + verify ──────────────────────────────────────────────────────────

test("uploading an animated GIF stores it as animated WebP", async () => {
  await page.goto("/settings");

  // Avatar input is a hidden <input type="file"> - setInputFiles works on it
  // directly without opening the popover. The change handler triggers the
  // crop dialog. Using a hidden input also avoids racing the popover open
  // animation.
  const fileInput = page.locator('input[type="file"][accept*="image/gif"]');
  await expect(fileInput).toBeAttached({ timeout: 5000 });
  await fileInput.setInputFiles({
    name: "tiny.gif",
    mimeType: "image/gif",
    buffer: buildAnimatedGif(),
  });

  // Crop dialog opens. The Apply button rolls through "Decoding…" while
  // gifuct-js loads + decodes, then settles on "Apply" once frames are ready.
  const dialog = page.getByRole("dialog", { name: "Edit Image" });
  await expect(dialog).toBeVisible({ timeout: 5000 });
  const applyButton = dialog.getByRole("button", { name: /^Apply$/ });
  await expect(applyButton).toBeEnabled({ timeout: 15000 });
  await applyButton.click();

  // Successful upload surfaces a "Avatar updated" toast (sonner).
  await expect(page.getByText("Avatar updated")).toBeVisible({ timeout: 15000 });

  // Look up the freshly-registered user's id via /api/me using the bearer
  // token that the app dropped into localStorage on login. We can't use
  // page.request directly here because it doesn't share localStorage, only
  // cookies - and we mint JWTs, not cookies.
  userId = await page.evaluate(async () => {
    const token = localStorage.getItem("token");
    const r = await fetch("/api/me", { headers: { Authorization: `Bearer ${token}` } });
    const j = await r.json() as { ok: boolean; data?: { userId: string } };
    if (!j.ok || !j.data) throw new Error("failed to load /api/me");
    return j.data.userId;
  });

  // The avatar endpoint is public - no auth needed. Cache-bust so we don't
  // get a stale 404 from a CDN/SW in between the POST and this GET.
  const response = await page.request.get(`/api/avatar/${userId}?v=${Date.now()}`);
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toBe("image/webp");

  const bytes = await response.body();
  // RIFF/WEBP container framing
  expect(bytes.subarray(0, 4).toString("ascii")).toBe("RIFF");
  expect(bytes.subarray(8, 12).toString("ascii")).toBe("WEBP");
  // Animated-WebP markers - the muxer writes a VP8X header, an ANIM chunk
  // (loop info), and one ANMF chunk per frame. Their FourCCs appear as
  // ASCII strings somewhere inside the binary, so a substring scan is
  // sufficient and resilient to chunk-size variations from the browser's
  // per-frame WebP encoder.
  const asString = bytes.toString("binary");
  expect(asString).toContain("VP8X");
  expect(asString).toContain("ANIM");
  expect(asString).toContain("ANMF");
});

// ── Light/dark variants ──────────────────────────────────────────────────────

test("a light request falls back to the dark variant when no light exists", async () => {
  const res = await page.request.get(`/api/avatar/${userId}?variant=light&v=${Date.now()}`);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toBe("image/webp");
});

test("uploading with the toggle on Light stores an independent light variant", async () => {
  await page.goto("/settings");

  // The sun/moon toggle sits directly below the avatar. It starts on "Dark"
  // (Moon); clicking it switches the slot that Upload/Remove targets to Light.
  const toggle = page.getByRole("button", { name: "Dark", exact: true });
  await expect(toggle).toBeVisible({ timeout: 5000 });
  await toggle.click();
  await expect(page.getByRole("button", { name: "Light", exact: true })).toBeVisible();

  const fileInput = page.locator('input[type="file"][accept*="image/gif"]');
  await fileInput.setInputFiles({
    name: "tiny.gif",
    mimeType: "image/gif",
    buffer: buildAnimatedGif(),
  });
  const dialog = page.getByRole("dialog", { name: "Edit Image" });
  await expect(dialog).toBeVisible({ timeout: 5000 });
  const applyButton = dialog.getByRole("button", { name: /^Apply$/ });
  await expect(applyButton).toBeEnabled({ timeout: 15000 });
  await applyButton.click();
  await expect(page.getByText("Avatar updated")).toBeVisible({ timeout: 15000 });

  // Both variants now resolve independently.
  const light = await page.request.get(`/api/avatar/${userId}?variant=light&v=${Date.now()}`);
  expect(light.status()).toBe(200);
  expect(light.headers()["content-type"]).toBe("image/webp");
  const dark = await page.request.get(`/api/avatar/${userId}?variant=dark&v=${Date.now()}`);
  expect(dark.status()).toBe(200);
  expect(dark.headers()["content-type"]).toBe("image/webp");
});

test("deleting only the light variant falls back to dark; dark is untouched", async () => {
  const status = await page.evaluate(async (uid) => {
    const token = localStorage.getItem("token");
    await fetch("/api/avatar?variant=light", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    const l = await fetch(`/api/avatar/${uid}?variant=light&v=${Date.now()}`);
    const d = await fetch(`/api/avatar/${uid}?variant=dark&v=${Date.now()}`);
    return { light: l.status, dark: d.status };
  }, userId);
  // Light now resolves via fallback to the still-present dark variant.
  expect(status.light).toBe(200);
  expect(status.dark).toBe(200);
});
