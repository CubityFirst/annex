import { defineConfig, devices } from "@playwright/test";

// Headed showcase layout: when PWGRID is set, each parallel worker's browser
// window is tiled into a 2x2 grid per monitor across two side-by-side monitors
// (8 slots, assigned by worker slot; slot 8+ wraps around). Use with
// `--headed --workers=8 --project=chromium`.
//
//   PWGRID=1920x1080   per-monitor resolution (bare PWGRID=1 assumes 1920x1080)
//
// Chromium-only: firefox has no --window-position flag. Assumes monitor 2 sits
// directly right of monitor 1 (adjust the `mon * monW` term if not). This works
// because every worker process re-loads this config with TEST_PARALLEL_INDEX
// set, so each worker computes its own launch args.
function gridArgs(): string[] {
  const spec = process.env.PWGRID;
  const slot = Number(process.env.TEST_PARALLEL_INDEX ?? NaN);
  if (!spec || Number.isNaN(slot)) return [];
  const m = spec.match(/^(\d+)x(\d+)$/);
  const monW = m ? Number(m[1]) : 1920;
  const monH = m ? Number(m[2]) : 1080;
  const w = Math.floor(monW / 2);
  const h = Math.floor(monH / 2);
  const slots: { x: number; y: number }[] = [];
  for (const mon of [0, 1]) {
    for (const row of [0, 1]) {
      for (const col of [0, 1]) {
        slots.push({ x: mon * monW + col * w, y: row * h });
      }
    }
  }
  const s = slots[slot % slots.length];
  return [`--window-position=${s.x},${s.y}`, `--window-size=${w},${h}`];
}

export default defineConfig({
  testDir: "./tests",
  globalTeardown: "./global-teardown.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // Local wrangler dev intermittently drops requests through the
  // browser → vite → API worker → auth worker chain (rate-limit edge cases,
  // service-binding hiccups). One retry catches those without masking real
  // bugs, since deterministic failures still fail twice.
  retries: 1,
  workers: 2,
  reporter: "list",
  use: {
    baseURL: "http://localhost:5173",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    launchOptions: process.env.PWSLOWMO
      ? { slowMo: Number(process.env.PWSLOWMO) }
      : undefined,
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        ...(process.env.PWGRID
          ? {
              // Let the page fill the half-screen window instead of the
              // device preset's fixed 1280x720 viewport.
              viewport: null,
              deviceScaleFactor: undefined,
              launchOptions: {
                args: gridArgs(),
                ...(process.env.PWSLOWMO ? { slowMo: Number(process.env.PWSLOWMO) } : {}),
              },
            }
          : {}),
      },
    },
    {
      name: "firefox",
      use: { ...devices["Desktop Firefox"] },
    },
  ],
});
