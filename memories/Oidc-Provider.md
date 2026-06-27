# Sign in with Annex - OIDC provider

Annex is an OpenID Connect identity provider so other first-party services can
offer "Sign in with Annex". Standard **authorization-code + PKCE**, RS256
id_tokens verifiable offline via JWKS - consumers use any OIDC client library.
Generalizes the single-purpose admin handoff (`admin_handoffs`, 0009).

## Hosts / endpoints
- **Issuer** = `https://auth.cubityfir.st` (dedicated identity host, decoupled
  from the app origin which may migrate). The auth worker serves
  `/oauth/{token,userinfo,jwks}` + `/.well-known/openid-configuration` there
  directly via two `wrangler.toml` routes (`auth.cubityfir.st/oauth/*`,
  `/.well-known/*`). Needs a **proxied** DNS record for `auth.cubityfir.st` on
  the `cubityfir.st` zone.
- **authorization_endpoint** = `https://docs.cubityfir.st/oauth/authorize` - a
  SPA page on the APP origin (the user's Annex session/JWT lives there, not on
  the issuer host). It POSTs to `/api/oauth/authorize` (frontend → api → auth
  via the `AUTH` binding) with the user's Bearer JWT to mint a single-use code.

## Key files
- `packages/auth/src/oidc.ts` - pure crypto/helpers: RS256 sign/verify, JWKS
  derivation, PKCE (S256), `resolveScopes`, exact `redirectUriAllowed`, claim
  builders. Scopes: `openid`/`profile`/`email`/`roles`. `profile` adds `name` +
  `picture` (the latter built as `${APP_ORIGIN}/api/avatar/{id}` in the token +
  userinfo handlers, not in `scopedClaims`; the avatar endpoint 404s for users
  with no avatar). The `roles` scope adds a
  `roles` array claim via `rolesForUser` (admins → `["user","admin"]`, else
  `["user"]`), sourced live from `users.is_admin` at token+userinfo time - lets
  connected services gate admin features on `roles.includes("admin")`. Unit-tested
  in `oidc.test.ts` (PKCE RFC vectors, alg-confusion, exact redirect match,
  RS256 round-trip, roles).
- `packages/auth/src/routes/oauth-{authorize,token,userinfo,discovery}.ts`.
- `packages/auth/src/routes/oauth-clients.ts` - **admin-only** client CRUD
  (`/admin/oauth/clients` GET/POST + `/set-disabled`, `/delete`, `/rotate-secret`).
  NOT on the public routes; reached only via the admin worker's `AUTH` binding;
  each handler re-checks `session.isAdmin`. Secrets generated/hashed here.
- Admin UI: `packages/admin/src/routes/oauth.ts` (thin proxy under
  `/api/oauth-clients`, gated by `enforceAdmin`) + `packages/admin/frontend/src/pages/OAuthClientsPage.tsx`
  (the "OAuth" nav tab - register/list/disable/rotate/delete; secret shown once).
- `packages/auth/src/index.ts` - routing + **path-aware CORS** (public OIDC
  paths = `*`; everything else locked to the app origin) + `RATE_LIMITER_OIDC`.
- `packages/auth/migrations/0028_add_oauth_clients.sql` - `oauth_clients`
  (exact-match `redirect_uris` JSON, hashed secret, `trusted`/`disabled`) +
  `oauth_codes` (single-use, PKCE-bound, 5-min).
- `packages/api/src/index.ts` - proxies `/oauth/authorize` only.
- `packages/frontend/src/pages/OAuthAuthorizePage.tsx` (+ App.tsx route).
- `scripts/gen-oidc-key.mjs` (RS256 key → `OIDC_PRIVATE_KEY` secret),
  `scripts/register-oauth-client.mjs` (per-service client_id/secret + SQL).
- Docs: `docs/oauth/README.md` (provider/ops), `docs/oauth/CONSUMER_PROMPT.md`
  (paste into the connected service's agent).

## Security invariants
- **Exact** redirect-URI match only (no wildcard/prefix). The `/oauth/authorize`
  endpoint NEVER emits a `redirectTo` until the URI is validated; pre-validation
  failures (unknown/disabled client, bad redirect) return a plain 400 with no
  redirect.
- **PKCE S256 mandatory** for all clients; verified **before** the code is
  atomically consumed (so a bad verifier can't burn an unredeemed code).
  Confidential clients also auth with a secret (Basic or post).
- Codes consumed atomically (`UPDATE … WHERE consumed_at IS NULL`, assert 1 row).
- **RS256 with a dedicated key** (`OIDC_PRIVATE_KEY`) - `JWT_SECRET` is NEVER
  shared. Verifier pins `alg: RS256` (no alg-confusion).
- Live account standing re-checked at token + userinfo; **disabled client**
  refused at authorize, token, AND userinfo (so disabling cuts off existing
  access tokens, not just new ones).
- Tokens are stateless, 1h, no revocation list - disable the client to cut off.

## Deploy
New tables aren't read by `loadCurrentSession`, so the auth/api/admin
triple-redeploy rule does NOT apply. But auth + api + frontend all changed:
migrate auth DB → deploy auth → api → frontend. See `docs/oauth/README.md` for
the full one-time setup (key, DNS, migrate, deploy, register client).
