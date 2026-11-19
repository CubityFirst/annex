#!/usr/bin/env node
import { execSync } from "child_process";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const mode = process.argv[2];
if (mode !== "local" && mode !== "remote") {
  console.error("Usage: node scripts/migrate.mjs <local|remote>");
  process.exit(1);
}

function run(label, cmd, cwd) {
  console.log(`\n→ ${label}`);
  try {
    execSync(cmd, { cwd, stdio: "inherit" });
    console.log(`✓ ${label}`);
  } catch {
    console.error(`✗ ${label} failed`);
    process.exit(1);
  }
}

const apiDir = resolve(root, "packages/api");

// `cf d1 migrations apply` takes the database ID (see each package's
// cloudflare.config.ts) and reads ./migrations by default. It applies to the
// remote database unless --local is passed.
const API_DB_ID = "267490be-7141-4d00-ab23-152742f2f6ef"; // cubedocs-main

if (mode === "local") {
  run(
    "API local migrations",
    `npx cf d1 migrations apply ${API_DB_ID} --local --persist-to ../../.wrangler/state`,
    apiDir
  );
} else {
  run(
    "API remote migrations",
    `npx cf d1 migrations apply ${API_DB_ID}`,
    apiDir
  );
}

console.log("\nAll migrations complete.");
