import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const SCRIPT = resolve(__dirname, "../scripts/d1-local.mjs");

/**
 * Run SQL against the local dev D1 (the shared .wrangler/state behind
 * `pnpm dev`) via scripts/d1-local.mjs - the config-free replacement for
 * `npx wrangler d1 execute <db> --local`. `main` = cubedocs-main (api DB),
 * `auth` = cubedocs-auth. Needs the api dev server (:8787) running, which every
 * e2e spec already does. Spawned without a shell, so SQL quotes pass through
 * verbatim. Throws with the helper's error message on failure.
 */
export function d1Local(db: "main" | "auth", sql: string): void {
  try {
    execFileSync(process.execPath, [SCRIPT, db, sql], { stdio: "pipe" });
  } catch (err) {
    const stderr = (err as { stderr?: Buffer }).stderr?.toString().trim();
    throw new Error(stderr || (err as Error).message);
  }
}
