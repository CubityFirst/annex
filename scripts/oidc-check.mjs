#!/usr/bin/env node
// End-to-end check of Annex's "Sign in with cubityfir.st" client registration
// from a dev machine: real sign-in, real code exchange, the same id_token checks
// the API worker runs (oauth4webapi: iss, aud, exp, iat, nonce, RS256 pinned,
// signature against the JWKS), then prints the claims.
//
// Useful before the new API worker is deployed: the registered redirect URI is
// the production callback, so the browser lands there (it may show a 404 until
// the new code is live) and you paste that URL back here. The code is
// single-use and short-lived, and this script redeems it itself.
//
// Usage (PowerShell: $env:OIDC_CLIENT_SECRET = Read-Host -MaskInput):
//   OIDC_CLIENT_SECRET=... node scripts/oidc-check.mjs
// Optional: OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_REDIRECT_URI.
// The secret is read from the environment and never printed; tokens aren't
// printed either.
//
// This runs on a dev machine, so it fetches the issuer directly. Worker code
// must never do that (same-zone fetch) - it goes through the IDENTITY_OIDC
// service binding (packages/api/src/account/oidc.ts).

import * as oauth from "../packages/api/node_modules/oauth4webapi/build/index.js";
import { createInterface } from "node:readline/promises";

const issuer = new URL(process.env.OIDC_ISSUER ?? "https://auth.cubityfir.st");
const clientId = process.env.OIDC_CLIENT_ID ?? "oidc_7369d6d5736d2bea35f1ab47";
const redirectUri = process.env.OIDC_REDIRECT_URI ?? "https://docs.cubityfir.st/api/auth/callback";
const secret = process.env.OIDC_CLIENT_SECRET;
if (!secret) {
  console.error("Set OIDC_CLIENT_SECRET in the environment (it is never printed).");
  process.exit(1);
}

const as = await oauth.processDiscoveryResponse(issuer, await oauth.discoveryRequest(issuer, { algorithm: "oidc" }));
const client = { client_id: clientId, id_token_signed_response_alg: "RS256" };

const verifier = oauth.generateRandomCodeVerifier();
const state = oauth.generateRandomState();
const nonce = oauth.generateRandomNonce();
const authorize = new URL(as.authorization_endpoint);
for (const [k, v] of Object.entries({
  client_id: clientId,
  redirect_uri: redirectUri,
  response_type: "code",
  scope: "openid profile email roles",
  state,
  nonce,
  code_challenge: await oauth.calculatePKCECodeChallenge(verifier),
  code_challenge_method: "S256",
})) authorize.searchParams.set(k, v);

console.log("\n1. Open this URL in a browser and sign in:\n\n" + authorize.href);
console.log("\n2. After the redirect, copy the FULL address from the browser's address bar.");
const rl = createInterface({ input: process.stdin, output: process.stdout });
const pasted = (await rl.question("\nPaste the callback URL: ")).trim();
rl.close();

const params = oauth.validateAuthResponse(as, client, new URL(pasted), state);
const res = await oauth.authorizationCodeGrantRequest(as, client, oauth.ClientSecretBasic(secret), params, redirectUri, verifier);
const tokens = await oauth.processAuthorizationCodeResponse(as, client, res, { expectedNonce: nonce, requireIdToken: true });
await oauth.validateApplicationLevelSignature(as, res);
const claims = oauth.getValidatedIdTokenClaims(tokens);
const header = JSON.parse(Buffer.from(tokens.id_token.split(".")[0], "base64url").toString());

console.log("\nid_token checks passed: signature (JWKS), alg, iss, aud, exp, iat, nonce, state, PKCE.");
console.log("header:", { alg: header.alg, kid: header.kid });
console.log("claims:", claims);
console.log(`\nadmin (roles includes "admin"): ${Array.isArray(claims.roles) && claims.roles.includes("admin")}`);
