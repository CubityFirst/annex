import { defineConfig, configDefaults } from "vitest/config";

export default defineConfig({
  test: {
    // Several suites here are integration tests that talk to ONE shared local
    // dev backend (a single SQLite file behind the dev workers). Running test
    // files in parallel causes write contention ("database is locked"),
    // execSync-vs-dev-server lock fights (collab sizeCap), and cross-suite
    // rate-limit/state collisions. Serialise files; tests within a file already
    // run in order. The unit suites are fast, so the cost is negligible.
    fileParallelism: false,
    // Integration suites require a live `pnpm dev` stack: they probe
    // localhost:8787/8788 at module load and self-skip when it's down - but
    // headless that skip surfaces as a suite-load error, not a clean skip, so
    // they'd fail CI. Exclude them from the default unit run; they run on demand
    // against a live stack via `pnpm test:integration` (vitest.integration.config.ts).
    exclude: [
      ...configDefaults.exclude,
      "**/*.integration.test.ts",
      "**/integration.test.ts",
      "src/collab/sizeCap.test.ts",
    ],
  },
});
