# Sign in with Annex - OIDC provider

Annex is an **OpenID Connect (OIDC) identity provider**. Other services you run
can offer a "Sign in with Annex" button: the user authenticates once against
their Annex account (password + TOTP + passkeys all apply, because the real
Annex login is reused) and your service receives a verified identity.

It is a standard **authorization-code + PKCE** flow, so consuming services use
any off-the-shelf OIDC client library - there is no Annex-specific SDK.

- **Provider side** (this doc): how the flow is built, the one-time setup, and
  how to register a connected service.
- **Consumer side**: hand [`CONSUMER_PROMPT.md`](./CONSUMER_PROMPT.md) to the
  agent working on the other service, filled in with that service's `client_id`,
  `client_secret`, and callback URL.

---

## Endpoints

| Purpose | URL |
| --- | --- |
| Issuer (`iss`) | `https://auth.cubityfir.st` |
| Discovery | `https://auth.cubityfir.st/.well-known/openid-configuration` |
| Authorization (browser) | `https://docs.cubityfir.st/oauth/authorize` |
| Token | `https://auth.cubityfir.st/oauth/token` |
| UserInfo | `https://auth.cubityfir.st/oauth/userinfo` |
| JWKS | `https://auth.cubityfir.st/oauth/jwks` |

The **authorization endpoint lives on the app origin** (`docs.cubityfir.st`),
not the issuer host. That's deliberate: the user's Annex session is a
browser-local token on the app origin, so the consent/login step has to happen
there. OIDC allows endpoints on different hosts - every client reads the exact
URLs from the discovery document, so this is transparent to consumers.

**Scopes:** `openid` (required, yields `sub`), `profile` (adds `name` and
`picture` - a URL to the user's avatar; it 404s for users who haven't uploaded
one, so fall back to your own placeholder), `email`
(adds `email`, `email_verified`), `roles` (adds a `roles` array - `["user","admin"]`
for Annex platform-admins, `["user"]` otherwise; read live from `users.is_admin`).
A client must be granted `roles` at registration to receive it; gate admin-only
features on `roles.includes("admin")`.
**Signing:** RS256. id_tokens and access tokens are verifiable offline against
the JWKS. This key is **separate** from the Annex session `JWT_SECRET` - no
Annex secret is ever shared with a connected service.
**Tokens:** `id_token` + `access_token` (both JWT, 1-hour lifetime).

---

## One-time provider setup

1. **Generate the RS256 signing key** and store it as a secret:
   ```bash
   node scripts/gen-oidc-key.mjs
   cd packages/auth && npx wrangler secret put OIDC_PRIVATE_KEY
   # paste the printed JSON line when prompted
   ```
   The public half is derived automatically and published at `/oauth/jwks`.

2. **Add DNS for the issuer host.** In the Cloudflare dashboard, on the
   **`cubityfir.st`** zone, add a **proxied** (orange-cloud) DNS record for
   `auth` - e.g. `AAAA auth 100::` (a placeholder; the Worker route handles the
   request, the record just makes the hostname resolve to Cloudflare's edge).
   The `auth.cubityfir.st/oauth/*` and `/.well-known/*` routes in
   `packages/auth/wrangler.toml` attach the auth worker to those paths only -
   nothing else on the auth worker is reachable at that host.

3. **Apply the migration** (creates `oauth_clients` + `oauth_codes`):
   ```bash
   cd packages/auth
   npx wrangler d1 migrations apply cubedocs-auth --remote
   # local dev: --local --persist-to ../../.wrangler/state
   ```

4. **Deploy** the three workers that gained code (new tables aren't read by
   `loadCurrentSession`, so the auth/api/admin triple-redeploy rule does *not*
   apply here - but auth, api, and frontend each changed):
   ```bash
   cd packages/auth && npx wrangler deploy        # endpoints + routes + migration
   cd packages/api && npx wrangler deploy          # /oauth/authorize proxy
   cd packages/frontend && pnpm build && npx wrangler deploy   # /oauth/authorize SPA page
   ```

5. **Smoke-test discovery + JWKS:**
   ```bash
   curl https://auth.cubityfir.st/.well-known/openid-configuration
   curl https://auth.cubityfir.st/oauth/jwks
   ```

---

## Registering a connected service

### Option A - Admin dashboard (recommended)

In the admin app (`admin.cubityfir.st`) → **OAuth** tab → **Register client**.
Enter a name, the exact redirect URI(s), scopes, and whether it's trusted /
public. The `client_id` + `client_secret` are shown **once** in a dialog (with
copy buttons and the discovery URL) - store the secret immediately. The same
page lists existing clients and lets you disable/enable, rotate the secret, or
delete them. (Backed by admin-only endpoints on the auth worker, proxied through
the admin worker - `packages/admin/src/routes/oauth.ts` → `auth` `/admin/oauth/clients*`.)

### Option B - CLI

```bash
node scripts/register-oauth-client.mjs \
  --name "My Dashboard" \
  --redirect "https://app.example.com/api/auth/callback/annex"
# add more --redirect for additional EXACT callback URLs
# --require-consent  -> show a consent screen (default: trusted/auto-approve)
# --public           -> SPA/native client (no secret; PKCE only)
```

It prints the `client_id` + `client_secret` (**secret shown once**) and writes a
`.sql` file. Apply it:

```bash
cd packages/auth && npx wrangler d1 execute cubedocs-auth --remote --file <printed path>
```

Either way, put `client_id` + `client_secret` (+ the discovery URL) into the
connected service's config and follow [`CONSUMER_PROMPT.md`](./CONSUMER_PROMPT.md).

- `redirect_uris` are matched **exactly** - register the precise callback URL(s),
  including scheme, host, port, and path. No wildcards or trailing-slash slack.
- First-party services you run should stay **trusted** (auto-approve, no consent
  screen). Use `--require-consent` only for something you don't fully control.

---

## How the flow works

```
Service          Browser                    Annex app (docs)         Annex issuer (auth)
  │  redirect to authorization_endpoint │                                  │
  │─────────────────────────────────────▶ /oauth/authorize (SPA)          │
  │                                      │  (logs in via real Annex login   │
  │                                      │   if no session; consent if not  │
  │                                      │   trusted)                       │
  │                                      │  POST /api/oauth/authorize ──────▶ mint single-use code
  │  302 redirect_uri?code&state ◀───────│                                  │
  │  POST code + PKCE verifier (+secret) ───────────────────────────────────▶ /oauth/token
  │  ◀───────────────────────── id_token + access_token (RS256) ────────────│
  │  verify id_token via JWKS, optionally GET /oauth/userinfo                │
```

PKCE (S256) is **mandatory**. `state` (CSRF) is echoed back. `nonce`, if sent,
is bound into the id_token. Authorization codes are single-use and expire in
5 minutes; consuming one a second time fails.

---

## Operations

- **Disable a client** (stops new sign-ins; keeps history):
  `UPDATE oauth_clients SET disabled = 1 WHERE client_id = '…';`
- **Rotate a client secret:** re-run the register script for a new client, or
  `UPDATE oauth_clients SET client_secret_hash = '<sha256-b64url>' …`.
- **Tokens are short (1h)** and stateless - there is no token revocation list.
  Disabling a client is refused at authorize, token, **and** userinfo, so its
  access tokens stop resolving claims immediately (an id_token already delivered
  to the consumer stays offline-verifiable until it expires). Disabling or
  suspending a *user* likewise takes effect immediately at token + userinfo
  (account standing is re-checked there).
- **Rotate the signing key:** generate a new key with a new `kid`. To avoid
  invalidating live tokens, publish both keys in JWKS during the 1-hour overlap
  before swapping `OIDC_PRIVATE_KEY` (current code serves a single key; extend
  `/oauth/jwks` to an array for a zero-downtime roll).

## Security model (why it's safe to point other services at it)

- **Exact** redirect-URI matching - the primary defence against open-redirect /
  token theft. No prefix or wildcard matching anywhere.
- **PKCE S256 mandatory** for every client; confidential clients additionally
  authenticate with a secret at the token endpoint.
- **Single-use codes**, consumed atomically (`UPDATE … WHERE consumed_at IS NULL`).
- **RS256 with a dedicated key** - `JWT_SECRET` is never exposed; consumers
  verify offline via JWKS. The token verifier pins `alg: RS256` (no alg-confusion).
- **Live account checks** - disabled/suspended/force-password-change users can't
  obtain or use tokens even mid-session.
- The issuer host exposes **only** `/oauth/*` and `/.well-known/*`; the public
  CORS (`*`) is scoped to those read/exchange endpoints, never the app session
  routes.
