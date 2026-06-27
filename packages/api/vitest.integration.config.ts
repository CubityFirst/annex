import { defineConfig } from "vitest/config";

// Integration suites ONLY. These require a live local stack - start it first:
//   pnpm dev        (api :8787 + auth :8788, shared .wrangler/state)
// then, from packages/api:
//   pnpm test:integration
//
// They self-skip when the stack isn't reachable, but headless that skip
// surfaces as a suite-load error rather than a clean skip - which is exactly
// why the default unit run (vitest.config.ts) excludes them.
export default defineConfig({
  test: {
    // Shared single-SQLite dev backend - never run these files in parallel.
    fileParallelism: false,
    include: [
      "**/*.integration.test.ts",
      "**/integration.test.ts",
      "src/collab/sizeCap.test.ts",
    ],
  },
});
