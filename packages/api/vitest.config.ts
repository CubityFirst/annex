import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Several suites here are integration tests that talk to ONE shared local
    // dev backend (a single SQLite file behind the dev workers). Running test
    // files in parallel causes write contention ("database is locked"),
    // execSync-vs-dev-server lock fights (collab sizeCap), and cross-suite
    // rate-limit/state collisions. Serialise files; tests within a file already
    // run in order. The unit suites are fast, so the cost is negligible.
    fileParallelism: false,
  },
});
