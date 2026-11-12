#!/usr/bin/env node
// Run SQL against the LOCAL dev D1 databases (the shared .wrangler/state that
// `pnpm dev` serves) - the replacement for
// `npx wrangler d1 execute <db> --local --persist-to ../../.wrangler/state`.
//
// Why not wrangler: the Worker config is cloudflare.config.ts only (there is no
// wrangler.toml), and `wrangler d1 execute --local` can only resolve a local
// database through a Wrangler config file. `cf d1 query --local` has no local
// implementation yet either. So this goes through the running api dev server's
// Local Explorer API (`/cdn-cgi/local/explorer/api/d1/database/<id>/raw`),
// which binds both databases (DB = cubedocs-main, AUTH_DB = cubedocs-auth) and
// reads/writes the exact same SQLite files as the dev servers.
//
// Requires the api worker to be running (`pnpm dev`, :8787). Override the
// origin with ANNEX_DEV_API_ORIGIN (e.g. http://127.0.0.1:18787).
//
// CLI:
//   node scripts/d1-local.mjs <main|auth> "<sql>"
//   node scripts/d1-local.mjs <main|auth> --file path/to/file.sql
// Prints each statement's result as JSON ({ columns, rows }). Exits non-zero on
// any SQL or connection error.
//
// Programmatic (from Node/TS tests):
//   import { d1Local } from "../scripts/d1-local.mjs";
//   await d1Local("auth", "UPDATE users SET ...");
// or, from synchronous code, spawn this file with execFileSync(process.execPath,
// [script, db, sql]) - no shell, so SQL quoting is passed through verbatim.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Database ids from packages/{api,auth}/cloudflare.config.ts.
export const D1_DATABASES = {
  main: "267490be-7141-4d00-ab23-152742f2f6ef", // cubedocs-main
  auth: "db327d85-b8c2-4fed-adaa-25e748778c86", // cubedocs-auth
};

export function devApiOrigin() {
  return (process.env.ANNEX_DEV_API_ORIGIN ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
}

/**
 * Execute `sql` (one or more `;`-separated statements) against a local D1.
 * Resolves to the explorer's per-statement results; rejects on any error.
 * @param {"main" | "auth"} db
 * @param {string} sql
 * @returns {Promise<Array<{ success: boolean, results?: { columns: string[], rows: unknown[][] } }>>}
 */
export async function d1Local(db, sql) {
  const id = D1_DATABASES[db];
  if (!id) throw new Error(`Unknown database "${db}" (expected "main" or "auth")`);
  const url = `${devApiOrigin()}/cdn-cgi/local/explorer/api/d1/database/${id}/raw`;
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sql }),
    });
  } catch (err) {
    throw new Error(
      `Could not reach the local api dev server at ${devApiOrigin()} - is \`pnpm dev\` running? (${err.cause?.code ?? err.message})`,
    );
  }
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`Unexpected ${res.status} response from ${url}: ${text.slice(0, 200)}`);
  }
  const failed = !res.ok || !body.success || (body.result ?? []).some((r) => r.success === false);
  if (failed) {
    const messages = [...(body.errors ?? []), ...(body.result ?? []).flatMap((r) => r.errors ?? [])]
      .map((e) => e.message ?? JSON.stringify(e));
    throw new Error(`D1 ${db} query failed (${res.status}): ${messages.join("; ") || text.slice(0, 200)}`);
  }
  return body.result ?? [];
}

async function main(argv) {
  const [db, ...rest] = argv;
  let sql;
  if (rest[0] === "--file" && rest[1]) sql = readFileSync(rest[1], "utf8");
  else if (rest.length === 1) sql = rest[0];
  if (!db || !sql) {
    console.error('Usage: node scripts/d1-local.mjs <main|auth> "<sql>" | --file <path>');
    process.exit(2);
  }
  try {
    const results = await d1Local(db, sql);
    for (const r of results) console.log(JSON.stringify(r.results ?? null));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
