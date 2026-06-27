#!/usr/bin/env node
// Generates the RS256 signing key for the "Sign in with Annex" OIDC provider.
//
// Prints an RSA private JWK (single line) to paste into the OIDC_PRIVATE_KEY
// secret. The worker derives the public half (published at /oauth/jwks) from
// it automatically, so there's nothing else to store.
//
//   node scripts/gen-oidc-key.mjs
//   # then, from packages/auth:
//   npx wrangler secret put OIDC_PRIVATE_KEY
//   # (paste the JSON line when prompted)

import { webcrypto } from "node:crypto";

const { subtle } = webcrypto;

const keyPair = await subtle.generateKey(
  {
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
    hash: "SHA-256",
  },
  true,
  ["sign", "verify"],
);

const jwk = await subtle.exportKey("jwk", keyPair.privateKey);

// A short, dated key id. Lets you roll keys later (publish both in JWKS during
// the overlap) without breaking already-issued tokens.
const kid = `annex-${new Date().toISOString().slice(0, 10)}`;
jwk.alg = "RS256";
jwk.use = "sig";
jwk.kid = kid;

// Stable field order, single line - ready to paste into `wrangler secret put`.
const ordered = {
  kty: jwk.kty,
  n: jwk.n,
  e: jwk.e,
  d: jwk.d,
  p: jwk.p,
  q: jwk.q,
  dp: jwk.dp,
  dq: jwk.dq,
  qi: jwk.qi,
  alg: jwk.alg,
  use: jwk.use,
  kid: jwk.kid,
};

console.error(`\nGenerated RS256 signing key (kid=${kid}).`);
console.error("Set it as the OIDC_PRIVATE_KEY secret:\n");
console.error("  cd packages/auth && npx wrangler secret put OIDC_PRIVATE_KEY\n");
console.error("Paste this single line when prompted (also printed to stdout):\n");
console.log(JSON.stringify(ordered));
