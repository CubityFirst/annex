import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    // A non-UTC zone, so the SQLite-datetime-is-UTC tests (AF-C1) can fail on
    // a UTC host (CI) - there a zone-less string already parses as UTC.
    env: { TZ: "America/New_York" },
  },
});
