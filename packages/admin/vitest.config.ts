import { defineConfig } from "vitest/config";

// Worker tests only. The SPA under frontend/ has its own vitest setup
// (jsdom + the @ alias) and runs via `pnpm --filter @annex/admin-frontend
// test` - letting this config glob those files up would run them without
// either.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
