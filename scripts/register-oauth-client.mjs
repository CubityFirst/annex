#!/usr/bin/env node
// Registers a connected service ("Sign in with Annex" OIDC client).
//
// Generates a client_id + client_secret, hashes the secret the same way the
// worker does (SHA-256 → base64url; see packages/auth/src/oidc.ts), and writes
// a ready-to-run .sql file that inserts the oauth_clients row. The plaintext
// secret is printed ONCE - store it in the connected service's config now.
//
// Usage:
//   node scripts/register-oauth-client.mjs \
//     --name "My Dashboard" \
//     --redirect "https://app.example.com/api/auth/callback/annex" \
//     [--redirect "<another exact callback URL>"] \
//     [--scopes "openid profile email"] \
//     [--require-consent]   # show a consent screen instead of auto-approving
//     [--public]            # SPA/native client: no secret, PKCE only
//
// Then apply the generated file:
//   cd packages/auth && npx wrangler d1 execute cubedocs-auth --remote --file <printed path>
//   # local dev:  --local --persist-to ../../.wrangler/state  (instead of --remote)

import { webcrypto } from "node:crypto";
import { randomBytes, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

function parseArgs(argv) {
  const out = { redirect: [], scopes: "openid profile email", requireConsent: false, public: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--name") out.name = argv[++i];
    else if (a === "--redirect") out.redirect.push(argv[++i]);
    else if (a === "--scopes") out.scopes = argv[++i];
    else if (a === "--require-consent") out.requireConsent = true;
    else if (a === "--public") out.public = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!out.name) throw new Error("--name is required");
  if (out.redirect.length === 0) throw new Error("at least one --redirect is required");
  for (const r of out.redirect) {
    let u;
    try {
      u = new URL(r);
    } catch {
      throw new Error(`--redirect is not a valid absolute URL: ${r}`);
    }
    if (u.protocol !== "https:" && u.hostname !== "localhost" && u.hostname !== "127.0.0.1") {
      throw new Error(`--redirect must be https (or localhost for dev): ${r}`);
    }
  }
  return out;
}

async function sha256b64url(input) {
  const digest = await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Buffer.from(digest).toString("base64url");
}

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

const args = parseArgs(process.argv.slice(2));

const clientId = `annx_${randomBytes(12).toString("hex")}`;
let clientSecret = null;
let secretHashSql = "NULL";
if (!args.public) {
  clientSecret = randomBytes(32).toString("base64url");
  secretHashSql = sqlString(await sha256b64url(clientSecret));
}

const redirectJson = JSON.stringify(args.redirect);
const trusted = args.requireConsent ? 0 : 1;
const createdAt = Date.now();

const sql = `INSERT INTO oauth_clients (client_id, client_name, client_secret_hash, redirect_uris, allowed_scopes, trusted, disabled, created_at)
VALUES (${sqlString(clientId)}, ${sqlString(args.name)}, ${secretHashSql}, ${sqlString(redirectJson)}, ${sqlString(args.scopes)}, ${trusted}, 0, ${createdAt});
`;

const here = dirname(fileURLToPath(import.meta.url));
const outFile = join(here, `register-${clientId}.sql`);
writeFileSync(outFile, sql, "utf8");

const line = "─".repeat(60);
console.log(`\n${line}`);
console.log("  Connected service registered (apply the SQL below to finish)");
console.log(line);
console.log(`  client_id:      ${clientId}`);
if (clientSecret) {
  console.log(`  client_secret:  ${clientSecret}`);
  console.log("                  ^ shown ONCE - copy into the service's config now");
} else {
  console.log("  client_secret:  (none - public client, PKCE only)");
}
console.log(`  client_name:    ${args.name}`);
console.log(`  redirect_uris:  ${redirectJson}`);
console.log(`  scopes:         ${args.scopes}`);
console.log(`  consent screen: ${trusted ? "no (trusted / auto-approve)" : "yes"}`);
console.log(line);
console.log("\nApply it:");
console.log(`  cd packages/auth && npx wrangler d1 execute cubedocs-auth --remote --file ${outFile}`);
console.log("\nThen delete the generated .sql file (it contains the secret hash):");
console.log(`  rm ${outFile}\n`);
