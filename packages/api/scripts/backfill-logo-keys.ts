/**
 * One-shot backfill: rename existing R2 logo objects from the legacy
 * single-slot key (`site-logos/{id}`) to the new variant-aware key
 * (`site-logos/{id}-wide`), matching the column copy in migration
 * 0048_split_project_logos.sql.
 *
 * Run from the monorepo root AFTER applying migration 0048:
 *
 *   # against the local persisted dev state
 *   npx tsx packages/api/scripts/backfill-logo-keys.ts --local
 *
 *   # against prod (uses your default wrangler login)
 *   npx tsx packages/api/scripts/backfill-logo-keys.ts --remote
 *
 * Wrangler has no `r2 object list` CLI, so we derive the candidate keys
 * from the D1 `projects` table - we already know each project that had a
 * logo (their old `logo_updated_at` was copied into `logo_wide_updated_at`).
 *
 * Idempotent: if the legacy `site-logos/{id}` key is already gone, the
 * script logs and skips it.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BUCKET = "cubedocs-assets";
const DB = "cubedocs-main";

const args = new Set(process.argv.slice(2));
const isLocal = args.has("--local");
const isRemote = args.has("--remote");
if (isLocal === isRemote) {
  console.error("Pass exactly one of --local or --remote");
  process.exit(1);
}

// `--config` so we can run from monorepo root and still resolve the
// `cubedocs-main` D1 binding + `cubedocs-assets` R2 binding declared in
// the api package's wrangler.toml.
const configFlags = ["--config", "packages/api/wrangler.toml"];
const baseFlags = isLocal
  ? [...configFlags, "--local", "--persist-to", "./.wrangler/state"]
  : [...configFlags, "--remote"];

function wrangler(...subargs: string[]): string {
  // shell: true so this works on Windows where `npx` is `npx.cmd`.
  return execFileSync("npx", ["wrangler", ...subargs], { encoding: "utf8", shell: true });
}

function listProjectIdsWithLogo(): string[] {
  const out = wrangler(
    "d1", "execute", DB,
    "--command", `"SELECT id FROM projects WHERE logo_wide_updated_at IS NOT NULL"`,
    "--json",
    ...baseFlags,
  );
  // wrangler d1 execute --json returns an array with one entry per statement.
  const parsed = JSON.parse(out) as Array<{ results: Array<{ id: string }> }>;
  if (!parsed[0]) return [];
  return parsed[0].results.map(r => r.id);
}

function tryGet(srcKey: string, destPath: string): boolean {
  try {
    wrangler("r2", "object", "get", `${BUCKET}/${srcKey}`, "--file", destPath, ...baseFlags);
    return true;
  } catch {
    return false;
  }
}

function put(destKey: string, srcPath: string): void {
  wrangler("r2", "object", "put", `${BUCKET}/${destKey}`, "--file", srcPath, ...baseFlags);
}

function del(key: string): void {
  wrangler("r2", "object", "delete", `${BUCKET}/${key}`, ...baseFlags);
}

const ids = listProjectIdsWithLogo();
console.log(`Found ${ids.length} project(s) with a wide-logo entry. Renaming legacy R2 keys.`);

let renamed = 0;
let skipped = 0;
for (const id of ids) {
  const oldKey = `site-logos/${id}`;
  const newKey = `site-logos/${id}-wide`;
  const dir = mkdtempSync(join(tmpdir(), "logo-backfill-"));
  const tmpPath = join(dir, "blob");
  try {
    if (!tryGet(oldKey, tmpPath)) {
      console.log(`  ${oldKey} - already migrated or missing, skipping.`);
      skipped++;
      continue;
    }
    put(newKey, tmpPath);
    del(oldKey);
    console.log(`  ${oldKey} -> ${newKey}`);
    renamed++;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
console.log(`Backfill complete. Renamed ${renamed}, skipped ${skipped}.`);
