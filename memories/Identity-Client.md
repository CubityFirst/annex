# Identity: Annex as a client of auth.cubityfir.st

Accounts live on the standalone identity service at **https://auth.cubityfir.st**
(worker `cubityfirst-auth`, its own repo and D1 `cubityfirst-auth`). It does
registration, sign-in (password, TOTP, passkeys with RP ID `cubityfir.st`),
email changes, sessions on its side, moderation (disable/suspend), the admin
role, account deletion, and OAuth client management (`/admin/clients`). Annex is
an OpenID Connect client like any other service. Annex keeps its own sessions,
a users mirror, and everything Annex-specific (Ink billing, preferences,
handles, badges, sites).

## Bindings (api + admin workers)

| Binding | Target | Used for |
| --- | --- | --- |
| `IDENTITY` | `cubityfirst-auth`, entrypoint `IdentityService` | `getUser` (standing, ~60s cache), `findUserByEmail` (invites), `listDeletedUsers` (deletion sync) |
| `IDENTITY_OIDC` | `cubityfirst-auth` default export | discovery, JWKS, token: **every server-side OIDC request** |

Annex's workers share the cubityfir.st zone with auth.cubityfir.st. A Worker's
`fetch()` to another Worker's hostname on the same zone goes to the origin (a
placeholder record), not to that Worker, so server-side OIDC requests must use
`IDENTITY_OIDC` (`identityFetch` in `packages/api/src/account/oidc.ts`). Only
the browser redirects (authorize, logout) use the public URL. Requests over a
binding carry no `CF-Connecting-IP`, so the provider rate-limits them per
client_id (100/min for token, again for userinfo) - fine at current volume.

Post-logout URIs are matched byte for byte: they're registered as the bare
origin (no trailing slash), which is the default `APP_ORIGIN` sends.

Vars: `OIDC_ISSUER`, `OIDC_CLIENT_ID` (docs: `oidc_7369d6d5736d2bea35f1ab47`;
admin: `oidc_07c81f4a5aa63dd2bd0b15cc`), `APP_ORIGIN`; optional `OIDC_REDIRECT_URI`,
`OIDC_POST_LOGOUT_REDIRECT_URI`. Secret: `OIDC_CLIENT_SECRET`.

## Registering the clients (auth.cubityfir.st/admin/clients)

| Client | Redirect URI | Post-logout URI | Scopes | First-party |
| --- | --- | --- | --- | --- |
| docs app (`oidc_7369d6d5736d2bea35f1ab47`) | `https://docs.cubityfir.st/api/auth/callback` | `https://docs.cubityfir.st` | `openid profile email roles` | yes |
| admin panel (`oidc_07c81f4a5aa63dd2bd0b15cc`) | `https://admin.cubityfir.st/api/auth/callback` | `https://admin.cubityfir.st` | `openid profile email roles` | yes |

Local dev clients: `http://localhost:5173/api/auth/callback` (docs) and
`http://localhost:5174/api/auth/callback` (admin), against a local identity
worker on :8790.

## Flow (packages/api/src/routes/auth.ts, shared by admin via AuthFlow)

1. `GET /api/auth/login?return_to=` - PKCE S256 verifier, state, nonce sealed
   (HMAC with `JWT_SECRET`) into the HttpOnly `annex_oidc_<state>` cookie (one
   per sign-in, so two tabs don't clobber each other; path `/api/auth`, 10 min); 302 to the authorize endpoint from discovery.
2. `GET /api/auth/callback` - opens the cookie, `validateAuthResponse` (state,
   `iss`), code exchange with `client_secret_basic`,
   `processAuthorizationCodeResponse` (iss, aud, exp, nonce, RS256 pinned) and
   `validateApplicationLevelSignature` (JWKS). Refuses ids in
   `identity_deletions` (`account_deleted`) or `user_deletions`
   (`account_disabled`), and non-admins for the admin client (`not_admin`).
   Upserts the users mirror (+ member snapshots; every mirror write that
   changes the email also updates the Stripe customer's, `refreshMirror`) and creates a session row with a single-use `handoff_hash`.
3. Sets the handoff code as the HttpOnly, SameSite=Strict
   `annex_handoff_<attempt>` cookie (60s; never in a URL, so a leaked/crafted
   completion link signs no one in; one cookie per sign-in, so two finishing
   at once in one browser don't swap) and 302s to
   `<APP_ORIGIN>/auth/complete#status=ok&attempt=<id>&return_to=…` (or
   `#error=<code>`).
4. SPA `POST /api/auth/exchange?attempt=<id>` (no body; the browser sends the cookie) -
   redeems it once for the HS256 session JWT. The docs app keeps it in localStorage, the admin panel
   in sessionStorage.
5. `POST /api/auth/logout` - revokes the session, returns the end-session URL
   with `id_token_hint` + `post_logout_redirect_uri`.

`loadCurrentSession(token, env, kind)` (`account/session.ts`) re-derives
everything per request; standing comes from `IDENTITY.getUser` (cache ~60s,
mirror fallback when unreachable). `kind` (`app`/`admin`) keeps docs and admin
tokens apart. Tokens last 1h on the provider and there are no refresh tokens;
Annex sessions last 7 days (admin 12h) independently.

Local dev without the identity worker: `DEV_QUICK_LOGIN=true` +
`APP_ORIGIN=http://localhost:5173` enables `POST /api/dev/quick-login` (dev
users have ids `dev-…`; standing checks skip the RPC for them).

## Deletion

- **Identity deletion** (user deletes their account on auth.cubityfir.st, or
  an operator does there): hourly api cron `23 * * * *`
  (`lib/identityDeletions.ts`) records it in `identity_deletions`, deletes the
  Stripe customer, memberships, API keys, shares, favourites, avatars and the
  users mirror row. **Owned sites/orgs are kept** and shown on the admin
  Projects page ("Owner account deleted") for an operator to resolve.
- **Admin-scheduled deletion** (Annex admin Users page): deletes Annex data
  only after 7 days; the person stays blocked from Annex; the operator then
  deletes the account on auth.cubityfir.st, and the sync finishes the rest.

## Cutover (the user runs these; never automatic)

The identity service went live 2026-11-18 (~16:33 UTC) with a fresh import of
cubedocs-auth and a new signing key. Until this branch ships, annex-auth still
serves Annex logins and **account changes drift** between the two stores.

1. Ship `chore(auth): retire annex-auth's OIDC provider` before/with any
   annex-auth deploy (removes the `auth.cubityfir.st` routes).
2. Register the two clients above on auth.cubityfir.st, **disabled** (they
   stay disabled until step 7, so nobody can sign in to Annex before
   reconciliation); set
   `OIDC_CLIENT_SECRET` on annex-api and annex-admin (`npx wrangler secret put
   OIDC_CLIENT_SECRET --name annex-api` / `--name annex-admin`), move
   `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` to annex-api, and fix
   `OIDC_CLIENT_ID` in the configs if the registered ids differ.
3. Apply api migration 0065 remotely (`node scripts/migrate.mjs remote`).
4. Freeze, then export and import. cubedocs-auth stays writable until the new
   code is live, and anything written there after the export is lost, so keep
   the window short and quiet (export, import and step 5 back to back, within
   minutes, and not across :17 past the hour when the old admin cron runs
   scheduled deletions): turn off sign-ups on the old Annex and let in-flight
   registrations finish (an account made between the export and step 5
   misses this import), note the time, don't schedule or cancel admin
   deletions or change grants/badges/handles in the admin panel, then
   `npx wrangler d1 export cubedocs-auth --remote --output migration-data/cubedocs-auth.sql`,
   `node scripts/import-auth-data.mjs migration-data/cubedocs-auth.sql`,
   `npx wrangler d1 execute cubedocs-main --remote --file migration-data/annex-import.sql`.
   Keep `migration-data/` for the reconciliation in step 7.
5. Deploy api, then admin, then frontend. Everyone signs in again (old Annex
   JWTs don't validate against the new sessions table).
6. Replay Stripe: events the old worker handled between the export and the
   deploy were applied to cubedocs-auth only. In the Stripe Dashboard
   (Developers → Webhooks → the docs.cubityfir.st endpoint) resend every event
   since the time noted in step 4. The handler is idempotent
   (`webhook_events`), so overlap is harmless.
7. Reconcile, once nothing routes to the old login/register/delete-account
   routes (after step 5): take a FINAL export of cubedocs-auth and compare its
   user ids with the identity service's actual import snapshot (the
   `import.sql` it was loaded from on 2026-11-18). Compare ids, not dates:
   accounts created on auth.cubityfir.st since its import are never involved.
   - **Deletions** - ids in the snapshot but absent from the final export were
     deleted on the old Annex after that import and could otherwise sign back
     in. Delete them at auth.cubityfir.st/admin/users.
   - **Additions** - ids in the final export but absent from the snapshot
     registered on the old Annex after that import. Step 4 already mirrored
     them (with their sites and billing) under that id, but auth.cubityfir.st
     has no such account: registering there would mint a new id and strand
     their Annex data. Add them to cubityfirst-auth **with their original
     ids** (users + recovery codes, from the final export). The identity
     repo's `import-from-annex.mjs` replaces every user, so it can't be re-run
     now; this needs an additions-only import from that repo. If an addition's
     email has since been registered on auth.cubityfir.st under a new id,
     resolve it by hand.

   Then **enable** the two Annex clients and delete `migration-data/`.
8. Retire annex-auth (`npx wrangler delete annex-auth`) once traffic is on the
   new code, and later cubedocs-auth after a backup.
