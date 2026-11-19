## Monorepo Structure

pnpm + Turbo monorepo 

- `packages/frontend` - React 19 SPA (Vite, Tailwind CSS 4, shadcn/ui)
- `packages/api` - Core Cloudflare Worker (projects, docs, files, Annex sign-in + sessions, billing, preferences)
- `packages/admin` - Admin panel Worker + SPA (`admin.cubityfir.st`)
- `packages/mcp` - stdio MCP server over the public `/v1` API, authenticated by one or more site-scoped API keys (see "Public API & Scoped API Keys")

### Auth

Accounts live on the standalone identity service **auth.cubityfir.st** (worker `cubityfirst-auth`, its own repo + D1). Annex is an **OpenID Connect client** of it, like every other service: password, 2FA, passkeys, email changes, sessions on the identity side, account moderation, registration and account deletion all happen there. Annex keeps its own **sessions**, a **users mirror**, and everything Annex-specific (billing/Ink, preferences, handles, badges). See `memories/Identity-Client.md`.

**Read this before touching auth flow:**

- **Sign-in** (`packages/api/src/routes/auth.ts`, `src/account/oidc.ts` on oauth4webapi): `GET /api/auth/login` → identity service (PKCE S256, state, nonce in an HMAC-sealed HttpOnly cookie) → `GET /api/auth/callback` (id_token claims + JWKS signature verified, `users` mirror upserted, pending Annex session created, its single-use handoff code set ONLY as an HttpOnly SameSite=Strict `annex_handoff_<attempt>` cookie - never in a URL, so a crafted link can't sign anyone in; one per sign-in) → SPA `/auth/complete#status=ok&attempt=<id>` → `POST /api/auth/exchange?attempt=<id>` redeems that cookie for the session JWT (kept in localStorage, sent as `Authorization: Bearer`). Sign-out: `POST /api/auth/logout` revokes the session and returns the end-session URL (`id_token_hint` kept on the session row). The admin panel runs the same flow (shared `AuthFlow`) as its own client with session `kind = 'admin'`.
- **Server-side OIDC requests never fetch `https://auth.cubityfir.st` directly.** Annex's workers share the cubityfir.st zone with it, and a Worker's same-zone `fetch()` to another Worker's hostname goes to the origin, not that Worker. Discovery/JWKS/token go through the **`IDENTITY_OIDC`** service binding (`cubityfirst-auth` default export; `identityFetch` in `account/oidc.ts`). Only browser redirects use the public URL. Local dev falls back to the public/local issuer when the binding has no target.
- **Sessions are verified inline** against cubedocs-main (`account/session.ts` `loadCurrentSession(token, env, kind)`: one batch of `sessions` + `users` mirror LEFT JOIN `user_billing`/`user_preferences`/`user_deletions`). The JWT (HS256, Annex-only `JWT_SECRET`) only proves Annex minted the session. **Account standing comes from the identity service** via the **`IDENTITY`** RPC binding (`IdentityService.getUser`, cached ~60s per isolate in `account/identity.ts`, falls back to the mirror's last known standing when unreachable). An admin-scheduled `user_deletions` row blocks the user in Annex regardless.
- **The users mirror** (`users` in cubedocs-main) is refreshed at sign-in and whenever the standing check sees a change; name/email changes are copied to `project_members`/`organization_members` snapshots. `PATCH /me` refuses `name` (owned by the identity service). Invite-by-email asks `IDENTITY.findUserByEmail` and mirrors the result.
- **No `AUTH_DB` / `AUTH` binding, no `packages/auth`.** Don't reintroduce a shared secret or a direct read of the identity DB.

### Database Schemas

- **API DB** (`cubedocs-main`): projects, docs (+ `doc_ai_summaries` satellite; `docs.slug` is the doc's custom public-URL segment from the `slug:` frontmatter key - unique per project, normalized + synced by `docOps.syncDocSlug` on every save path incl. collab checkpoints and restores, resolved by `/public/docs/:site/:idOrSlug`), doc_revisions, folders, files, members, site_reports + user_reports (abuse reports: public "Report Site" button → `POST /public/projects/:id/report`, profile-card "Report user" → authenticated `POST /users/:id/report`; both triaged via the admin worker's `/api/reports/{sites,users}` routes + the admin "Reports" page's Sites/Users tabs) - see `packages/api/migrations/`. Bound as `DB` on the API worker.
- **Recycle bin** (API DB, `0062_add_trash.sql`, `lib/trash.ts`, `routes/trash.ts`, `components/RecycleBin.tsx` - shown as the "Recycle bin" section of Site Settings, `/projects/:id/trash` redirects there): deleting a doc/file/folder (app, or `/v1` doc DELETE) **moves its rows out of** `docs`/`files`/`folders` into `trash_items` JSON snapshots (one `trash_entries` row per user-visible entry; a folder bins its whole subtree as one entry, except the home doc, which is moved to the root). Because binned rows are physically gone from the live tables, **no reader needs a "not deleted" filter - don't add one, and don't hard-delete docs/files/folders from a route; call `moveToTrash`**. Cascade-lost satellites that aren't derivable (`doc_shares`, the `docs_fts` row, `site_reports.doc_id`) ride in `extra_json` and come back on restore; R2 objects + `asset_revisions` stay until purge. Restore/list = editor+, delete-forever/empty = admin+, auto-purge after 30 days on the daily cron. Site deletion (api + admin) must include `trash_items` ids in its R2 sweep. `trash.test.ts` runs against real SQLite via `src/test/sqliteD1.ts` (all migrations applied) - use that harness for SQL-heavy logic.
- **Doc search index** (API DB, `0064_rebuild_docs_fts.sql`, `lib/fts.ts`): `docs_fts` is FTS5 with an indexed `pid` = `hex(project_id)` token column plus a `docs_fts_map(rid, doc_id)` rowid map, so per-doc writes are rowid lookups and search MATCHes `pid:"<token>"` (`siteFtsMatch`) instead of scanning every site. **Never write `docs_fts` with raw SQL (`WHERE doc_id = ?` / `WHERE project_id = ?` are full scans, and a bare INSERT gets no `pid` or map row) - use the `fts*Statements` helpers**, which keep exactly one map row per FTS row and compose into a caller's batch (the insert + map statements must stay adjacent: `last_insert_rowid()`). Search weights stay `bm25(docs_fts, 5.0, 1.0, 0.0)` (pid weighted 0). `scripts/repair-docs-fts.sql` reconciles rows written by pre-0064 code.
- **Admin deletion is always delayed and deletes Annex data only** (api `0065_add_identity_mirror.sql` `user_deletions`, admin `lib/userDeletion.ts`, Users page checkboxes → bulk Delete/Cancel deletion): "Delete" only **schedules** - the `user_deletions` row blocks the person from Annex at once; the admin worker's hourly cron (`runDueUserDeletions`) deletes their Annex data after 7 days (Stripe customer, confirmed sites/orgs, memberships, billing, preferences, sessions) and sets `completed_at`. The users mirror row and schedule stay, so they remain blocked until the operator deletes the **identity account on auth.cubityfir.st** (Annex never deletes it). Any admin can cancel before execution starts. Moderation (disable/suspend) happens on auth.cubityfir.st, not in the Annex admin. Owned sites/orgs are deleted **only** when the operator ticked an explicit per-account box in the preview, scheduling refuses unless the confirmed ids exactly match current ownership (`sameIdSet`), and execution refuses if the account owns anything outside them. The cron claims each schedule by `(user_id, id)` with a lease; cancel is refused while leased or once `started_at` is set (first irreversible step), after which a failed run is retried to completion - a confirmed site/org that no longer exists counts as done; completed rows are never re-run. Real-SQLite scenario tests: `userDeletion.sqlite.test.ts`. **Don't add an immediate admin delete path.** Site deletion itself is shared via `lib/projectDelete.ts`.
- **Account data** (cubedocs-main, `0065_add_identity_mirror.sql`; copied once from the retired `cubedocs-auth` by `scripts/import-auth-data.mjs`): the `users` mirror (`id` = OIDC `sub`, email, name, is_admin, last known `status`/`suspended_until`), Annex `sessions` (`kind` app/admin, `id_token`, single-use `handoff_hash`), and the satellites `user_billing` (Stripe + plan state) and `user_preferences` (fonts, theme, Ink cosmetics, timezone, bio, badges, opt-in profile `handle` + `handle_locked`), plus `webhook_events`, `user_deletions`, `user_moderation_events` (read-only history), `admin_audit_log` and `identity_deletions`. The `handle` (partial unique index, stored lowercase, rules in `packages/api/src/account/handle.ts` mirrored by `frontend/src/lib/handle.ts`) powers the `/@<handle>` profile link: set via `PATCH /me/handle`, resolved by `GET /users/by-handle/:handle`; admins moderate it via the admin worker's `PATCH /api/users/:id/handle` and can lock it (`403 reason: "locked"`).
- **Deletion sync** (api `lib/identityDeletions.ts`, hourly cron `23 * * * *`): `IDENTITY.listDeletedUsers` from the newest recorded `identity_deletions.deleted_at`; for each account it deletes the Stripe customer, memberships, API keys, shares, favourites, avatars and the users mirror row (cascading the rest). **Sites/orgs the person owned are kept** (owner rows too) and listed on the admin Projects page ("Owner account deleted") for an operator to delete or leave. Failures stay pending with `last_error` and retry.

#### Satellite tables and the resolver

`users`, `docs`, and other "hot" tables have been kept narrow by moving rarely-needed columns into 1:1 satellite tables keyed by the parent's id. The pattern:

- Satellite row is created lazily - first write does `INSERT … ON CONFLICT(parent_id) DO UPDATE SET …`. A user/doc/etc. that has never had the feature touched has no satellite row at all.
- Every reader does `LEFT JOIN <satellite> ON <satellite>.<parent>_id = <parent>.id`. Missing rows return NULL for every satellite column, which the consumer treats as "default."
- The satellite declares `REFERENCES <parent>(id) ON DELETE CASCADE` so deleting the parent wipes the satellite row automatically.
- Existing satellites: `doc_ai_summaries` (ai_summary cache), `user_billing` (Stripe/plan state), `user_preferences` (fonts + cosmetics + timezone + bio + badges + handle). All in cubedocs-main.

`resolvePersonalPlan` in `packages/api/src/account/plan.ts` is fed inputs from multiple tables (billing-state from `user_billing`, cosmetic prefs from `user_preferences`). Callers build a flat `PlanRow` from the LEFT-JOINed query result and hand it to the resolver - see `loadCurrentSession`, `members.ts`, `routes/me/update-ink-prefs.ts` for the pattern.

## Frontend Notes

- UI components from shadcn/ui - always use these instead of raw HTML elements when possible
- Document rendering and editing both go through `packages/frontend/src/components/wysiwyg/WysiwygEditor.tsx` (CodeMirror 6, Lezer markdown grammar, decoration-based inline-rendered widgets). The `mode` prop selects `"reading"` | `"editing"` | `"raw"`.
- `react-markdown` + remark plugins is still used for the AI-summary block in `DocPage.tsx` and the file-summary block in `FileManager.tsx`, but not for the main document body.
- Authenticated images use the `AuthenticatedImage` component (fetches with auth header)
- PWA service worker in `dev-dist/sw.js` (auto-generated - do not edit manually)
- The public marketing/legal pages (landing, privacy, terms, acknowledgements) share one footer: `components/SiteFooter.tsx`. **Use `<SiteFooter />` on any new page in that family** instead of hand-rolling a `l-footer` block, so the link set stays identical everywhere.
- **Link previews.** `index.html` carries the site-wide description/OG tags plus a Discord **component embed** (`<script id="discord:component-embed">`, baked in at build by the `annex:discord-component-embed` Vite plugin) inside `<!-- default-meta -->` markers. The frontend worker's `renderIndexWithMeta` strips that whole block (`stripDefaultMeta`) before injecting per-page meta for share links, custom-domain docs and invites, including their own component-embed cards. Cards are built and validated in `worker/componentEmbed.ts` against Discord's draft spec (discord-api-docs PR #8606: one Container root, ≤40 components, ≤10 gallery items, ≤3000 bytes, link buttons only). An invalid card is dropped (plain OG preview) and never emitted. User text goes through `escapeMarkdown`.
- The **Acknowledgements** page (`/acknowledgements`, `pages/AcknowledgementsPage.tsx`, linked from `SiteFooter`) lists bundled open-source libraries and is driven by `packages/frontend/src/lib/acknowledgements.ts`. **When you add or remove a runtime dependency in `packages/frontend/package.json`, update `acknowledgements.ts` to match** - name, license (read the real value from the package's `package.json`, don't assume MIT), and project URL.
- File preview/classification flows through `lib/fileKind.ts` (`fileKind()` → icon + which inline preview). **Excalidraw drawings are a file kind** (`.excalidraw` → kind `"drawing"`): they reuse the `files` table/R2 but are the one **mutable** file (overwritten by `PUT /files/:id/content`, gated to the `application/vnd.excalidraw+json` vendor MIME via `isMutableFile`; content ETag is versioned by `files.updated_at`). The heavy `@excalidraw/excalidraw` editor is lazy-loaded in `ExcalidrawCanvas`. **Anything touching the drawing editor, the mutable-content path, `files.updated_at`, or the `"drawing"` kind belongs to this system** - see `memories/Excalidraw.md`.

### Dice Module

`packages/frontend/src/lib/dice.ts` - parser and roller for dice notation.
`packages/frontend/src/components/DiceRoll.tsx` - clickable inline dice roll widget used in rendered markdown.

**Supported notation:** see `memories/Dice-Notation.md` - read that file when you need details on dice notation syntax (table of examples, reroll/keep/explode/success-count behavior, operator precedence).

## Demo Mode

The landing page's "See a demo" links to **`/demo`**, a local-only sandbox: a sessionStorage flag (`lib/demo.ts`) makes `main.tsx` install `lib/demoServer.ts`, which patches `window.fetch` and answers every `/api/*` call from an in-memory dataset (one "Demo Site", seeded docs/files/revisions plus a seeded `.excalidraw` drawing; site/org creation refused; anonymous auth endpoints like `/api/login` pass through). The real DocsLayout/Dashboard/FileManager/DocPage run unmodified; `getToken()` hands out a fake JWT while the flag is set, and DocsLayout shows the "this is a demo environment" banner. Site Settings writes (PATCH `/projects/:id`: name/description/publish/AI/graph/changelog/home-doc) and user prefs (`/me` name/timezone, bio, fonts) mutate the store; destructive or unsupportable actions (delete site/account, invites, API keys, export, avatar, billing) are refused with human-readable "…disabled in the demo." errors. The demo site is **seeded as published** and `/api/public/*` requests referencing demo data (ids all start with `demo-`) are served from the store too, so the public reading view at `/s/demo-site` works in-demo; public requests for real sites still pass through. Nothing persists - the store dies on reload. Tests: `packages/frontend/src/lib/demoServer.test.ts` + `e2e/tests/demo.spec.ts` (needs only the frontend dev server).

## Annex Ink + Stripe

Personal supporter subscription ($5/mo) with Stripe billing, comp-grant override, animated avatar ring, admin grant/revoke/cancel controls, and a webhook proxy through the frontend worker. **Anything touching the `user_billing` table (Stripe ids, `personal_plan_*`, `granted_plan_*`), the cosmetic-pref columns on `user_preferences` (`personal_plan_style`, `personal_presence_color`, `personal_crit_sparkles`), `routes/billing.ts`, `routes/stripeWebhook.ts` (api worker), the billing UI in user settings or the admin user-details sheet, or the `InkBillingCard` belongs to this system** - see `memories/Ink-Stripe.md` for schema, plan resolution rules, webhook flow, deploy/dev setup, and ops cheatsheet.

## Realtime Collaboration

Yjs-based realtime co-editing gated per-project by `projects.features & 4` (`ProjectFeatures.REALTIME`), served from the `DocCollabRoom` Durable Object behind the API worker. **Anything touching `DocCollabRoom`, the `/api/docs/:id/collab` WebSocket route, `CollabProvider`, `EditorPresence`, or the `collab` prop on `WysiwygEditor` belongs to this system** - see `memories/Collab.md` for architecture, key files, WebSocket auth flow, reconnect behavior, and the local-enable command.

## Public API & Scoped API Keys

A narrow public REST surface under **`/v1`** on the API worker (reachable at `https://<site>/api/v1`), authenticated by user-generated **scoped API keys** (`annx_…`) created in Site Settings → Developer → API Keys. Covers doc CRUD + move, member invite/revoke, key introspection (`GET /v1/key`) and key self-revocation (`DELETE /v1/key`, deliberately ahead of the killswitch and account gates); the site is always implied by the key. The **MCP server** (`packages/mcp`) is a client of `/v1` that takes several keys (one per site) - it must never gain a user-scoped/all-sites credential. **Anything touching the `api_keys` table, `lib/apiKeys.ts`, `lib/docOps.ts`, `routes/v1.ts`, `routes/apiKeys.ts`, `packages/mcp`, the `RATE_LIMITER_API` binding, the Flagship `api` killswitch, or the "API Keys" settings section belongs to this system** - see `memories/Api-Keys.md` for schema, the security invariants (separate key-only auth path used **only** by `/v1`; keys are ceilings re-checked against live membership), rate limiting/killswitch, and tests. Public consumer reference: `docs/api/README.md`.

**Critical invariant:** API keys are authenticated by `authenticateApiKey` and wired **only** into the `/v1` router - never through the shared JWT `authenticate()`. A key sent to any other route fails JWT parsing → 401, which is what stops a scoped key from escaping its site/scope ceiling. Do not route keys through `authenticate()`.

## Organizations (a level above sites)

An **organization** is a collection of sites (`projects`) with **trickle-down roles**: an org member's role applies to every site in the org (org owner→site owner, admin→admin, editor→editor, viewer→viewer). A site belongs to at most one org (nullable `projects.organization_id`, `ON DELETE SET NULL`). Schema (API DB) in `0054_add_organizations.sql`: `organizations`, `organization_members` (roles `viewer|editor|admin|owner`, no `limited`). **Anything touching `organizations`/`organization_members`, `routes/organizations.ts`, `lib/access.ts`, the `organizationId` arg on `POST /projects`, the org pages (`OrgPage`, `OrgSettingsPage`, the "Your Orgs" dashboard section, `openCreateOrg`), or the pending-invites union belongs to this system** - see `memories/Organizations.md`.

**Critical invariant - `lib/access.ts` is the single per-site access-check boundary.** Every authenticated per-site authorization gate resolves the caller's *effective* role via `resolveAccess`/`resolveRole` = the higher `ROLE_RANK` of (direct `project_members` row, accepted `organization_members` role for the site's org). **Do NOT re-introduce a local `getCallerRole` or an inline `SELECT role FROM project_members …` for a caller-access gate.** Direct `project_members` queries remain ONLY for: target-row escalation guards (members/docShares), attribution joins (`author_id`/`uploaded_by`), the `GET /projects` "Your Sites" list, the site members-list *contents*, and **attach's site-owner check** (which must be the caller's *direct* role, never effective). Org trickle-down flows into `/v1`'s `liveCaller` too (the key's role floor), while scope/`canInvite` stay independent ceilings. Orgs live entirely in the API DB (no auth-DB coupling / triple-redeploy).

## Custom Domains (Cloudflare for SaaS)

A site owner can map their **own domain** (e.g. `docs.example.com`) to their published site via Cloudflare for SaaS **custom hostnames**. Cloudflare issues + auto-renews the DV cert and routes the host to the frontend Worker, which serves the site at **clean root URLs** (`docs.example.com/`, `docs.example.com/<docId>`). **This is the same feature as the vanity slug - both are gated by the single `ProjectFeatures.CUSTOM_LINK` (bit 1) flag** (admin-enabled per-site in the admin app; surfaced together in Site Settings → Site → "Custom Link & Domain"). One domain per site (`project_custom_domains` is keyed by `project_id`, globally-unique `hostname`).

**Anything touching `project_custom_domains` (`0055_add_custom_domains.sql`), `lib/customDomains.ts` (the Cloudflare API client + `isValidHostname`/`isReservedHostname`/`deriveDnsRecords`/`deriveStatus` pure helpers), `routes/customDomains.ts` (`/projects/:id/domain` GET/PUT/DELETE + `/refresh`), the `/public/site-by-host` resolver, the host-mode serving path (`lib/siteUrl.ts`, `CustomDomainApp`, the base-path-aware `PublicDocPage`/`SearchPalette`, and the frontend worker's custom-host meta/robots/sitemap injection in `worker/index.ts`), or the Custom Domain UI in Site Settings belongs to this system** - see `memories/Custom-Domains.md` for schema, the Cloudflare API flow, the **one-time zone setup** (on a **dedicated `yourannex.com` SaaS zone** - kept separate from `cubityfir.st` so the `*/*` route can't shadow our own hosts: enable SaaS, fallback origin, `*/*` Worker route → `annex-frontend`, `CF_API_TOKEN`/`CF_ZONE_ID`/`CUSTOM_DOMAIN_CNAME_TARGET = publish.yourannex.com`), host-detection rules + the dev `?__site=` override, and tests.

**Critical invariant:** the custom domain serves a **published, read-only** public site only - never the authenticated app (sessions/JWT are per-origin). Host detection (`isCustomDomain` in `lib/siteUrl.ts`) treats `localhost`/`*.cubityfir.st`/`*.workers.dev`/`*.pages.dev`/`*.local` as app hosts; anything else is a custom domain and boots `CustomDomainApp` (site-only routes). When `CF_API_TOKEN`/`CF_ZONE_ID` are unset the endpoints report "not configured" and never call Cloudflare.

## Identity provider (auth.cubityfir.st)

Annex is **not** an OpenID Connect provider any more. Since 2026-11-18 the
provider is the standalone `cubityfirst-auth` worker at `https://auth.cubityfir.st`
(its own repo and D1); Annex is one of its clients (see "Auth" above). The
`auth.cubityfir.st` hostname is cubityfirst-auth's Custom Domain - **never add
routes for it to an Annex worker**. OAuth clients are managed at
`auth.cubityfir.st/admin/clients`. The old `docs.cubityfir.st/oauth/authorize`
URL redirects to the provider (frontend worker + SPA shim). See
`docs/oauth/README.md`.

## Tests

Tests exist - run them before reporting work as done when changes are testable.

- **Vitest unit tests** live next to source as `*.test.ts(x)` in each package. Run per-package with `pnpm --filter <api|frontend|@annex/admin|@annex/admin-frontend> test`, or all packages + e2e with `pnpm test` from the root. Sign-in is covered end to end against a fake OpenID provider (`packages/api/src/test/fakeIdp.ts`, `routes/auth.test.ts`); SQL-heavy logic runs on real SQLite (`src/test/sqliteD1.ts`, `test/session.ts` seeds a mirror user + session).
- **Playwright e2e tests** live in `e2e/tests/` (one `*.spec.ts` per feature area - list the directory to see current coverage). Accounts live on auth.cubityfir.st, so suites sign in with `e2e/signIn.ts` (`devSignIn` via the api worker's localhost-only `POST /api/dev/quick-login`; needs `DEV_QUICK_LOGIN=true` + `APP_ORIGIN=http://localhost:5173` in `packages/api/.dev.vars`). `admin.spec.ts` uses the admin worker's own `POST /api/dev/quick-login` (`DEV_QUICK_LOGIN=true` + `APP_ORIGIN=http://localhost:5174` in `packages/admin/.dev.vars`). Keep `OIDC_ISSUER` in both `.dev.vars` local (see the `.example` files) so sign-out never redirects a test to the real provider. Run with `pnpm test:e2e` (headless) or `pnpm test:e2e:ui` (UI mode). First run needs `pnpm --filter cubedocs-e2e install:browsers`.
- When adding behavior with existing test coverage in the same area, extend the corresponding suite rather than leaving it untested.

## Commits

Use Conventional Commits with a type **and** scope: `<type>(<scope>): <imperative summary>` (e.g. `feat(frontend): draft-first doc creation`, `fix(auth): ...`). Types/scopes are listed in `CONTRIBUTING.md` - scope is the package (`frontend`, `api`, `admin`, `e2e`) or feature area (`files`, `search`, `orgs`, `billing`, `collab`, `oidc`, ...).

## CLI Notes

- All wrangler commands must be prefixed with `npx` (e.g. `npx wrangler secret put ...`)

## Worker Config (cf)

Each worker (`packages/{api,admin,frontend}`) is configured by **`cloudflare.config.ts`** (Worker settings, bindings, vars, routes/domains, crons, DO `exports`) plus **`wrangler.config.ts`** (build settings: assets dir, source maps). **These are the only Worker config files - there is no `wrangler.toml`/`wrangler.json`; don't add one.** They are what **`cf build` / `cf deploy`**, the Workers Builds deploy triggers, and local dev read, so a binding/var/route change goes in `cloudflare.config.ts` only. Each package pins `cf` and `wrangler` (the Wrangler bundler must be installed per package, not hoisted).

- **Local dev** (`pnpm dev`): api/admin run `wrangler dev --experimental-new-config --port <n> --persist-to ../../.wrangler/state`, which loads `cloudflare.config.ts` + `wrangler.config.ts` (and `.dev.vars`) directly. Plain `cf dev` isn't used because it can't take a persist dir yet, and both workers must share one state dir (they share cubedocs-main). The frontend's `pnpm dev` is plain Vite. **Sign-in locally**: run the identity worker (`G:\scripts\auth`) with `npx wrangler dev --port 8790` (Annex's api owns :8787) and point `OIDC_*` in `packages/{api,admin}/.dev.vars` at it (see the `.dev.vars.example` files), or skip it with the dev quick-login buttons (`DEV_QUICK_LOGIN=true`).
- **Local D1 SQL** (no Wrangler config means `wrangler d1 execute --local` can't resolve a database, and `cf d1 query --local` isn't implemented yet): use `node scripts/d1-local.mjs main "<sql>"` (or `--file`), which runs through the running api dev server's Local Explorer API against the shared state - see "Local D1 State" below. Remote commands (`npx wrangler d1 execute <db> --remote`, `npx wrangler r2 object ... --remote`) work without a config file.
- D1 migrations: `pnpm migrate` / `node scripts/migrate.mjs <local|remote>` run `cf d1 migrations apply <DATABASE_ID>` (remote unless `--local`).
- `annex-api`'s `DocCollabRoom` is declared as `exports.durableObject({ storage: "legacy-kv" })` - it was created with `new_classes` (KV-backed). Never change it to `"sqlite"`.
- The frontend package depends on Vite, so `cf build` would run `vite build` instead of Wrangler; its deploy is `pnpm build && pnpm build:worker (cf-wrangler build) && cf deploy --prebuilt`.
- Secrets are still set with `npx wrangler secret put <NAME> --name <worker>`; `cf deploy` keeps existing secrets.

## Local D1 State

The dev servers use a shared wrangler state at the **monorepo root** (`/.wrangler/state`), not inside each package. This is set via `--persist-to ../../.wrangler/state` in each package's dev script.

Local migrations (`pnpm migrate` / `node scripts/migrate.mjs local`) pass `--persist-to ../../.wrangler/state` from the package directory; any manual `cf d1 migrations apply <id> --local` must too, otherwise it hits a state the dev servers never read.

Ad-hoc local queries go through `scripts/d1-local.mjs` (needs `pnpm dev` running - it talks to the api worker on :8787, override with `ANNEX_DEV_API_ORIGIN`). `main` = `cubedocs-main` (the only database; accounts live on auth.cubityfir.st); it prints the last statement's rows as JSON. Use it for DML/SELECTs - schema changes belong in migrations. e2e specs use the `e2e/d1Local.ts` wrapper.

```
node scripts/d1-local.mjs main "SELECT id, email, status FROM users LIMIT 5"
node scripts/d1-local.mjs main "UPDATE projects SET features = features | 4 WHERE id = '<id>'"
```

## Parallel Worktrees (dev review)

For running several feature branches side-by-side (e.g. many agents in parallel, each
reviewable in a browser on its own port), use `scripts/worktree.mjs`. The main checkout runs
the full stack via `pnpm dev` (frontend 5173 + api 8787 + admin 8789 + the shared
`.wrangler/state` D1) - that's the **one backend**. Each worktree adds **another frontend** on
its own port, and the Vite `/api` proxy (hardcoded to `:8787` in `vite.config.ts`) makes every
worktree frontend talk to that single backend and share the one dev DB. No app-code or
vite-config changes.

```
node scripts/worktree.mjs new <name> [--base main] [--start]   # create + install + assign port
node scripts/worktree.mjs serve [--port <n>]                   # run frontend from CURRENT checkout
node scripts/worktree.mjs list                                 # worktrees, ports, serving status
node scripts/worktree.mjs rm <name> [--force]                  # remove worktree, free port
```

Worktrees live at `../cubedocs-worktrees/<name>` - **on the same drive as the repo** so
`pnpm install` hardlinks from the warm pnpm store (`G:\.pnpm-store`) instead of copying.
Ports are assigned from 5200–5299 and persisted in the gitignored `.worktree-ports.json`
so each feature keeps a stable review port. **The shared dev DB is the boundary of this
model** - a schema migration on one branch hits everyone; run an isolated backend manually
if a branch needs its own schema. See `memories/Worktree-Dev.md` for the full workflow,
caveats (per-port login, dev service-worker staleness, one-backend-at-a-time), and when to
use this vs. the agents' built-in ephemeral `isolation: "worktree"`.

### Exposing a review port from an agent (e.g. agent view)

**If you are an agent that edited frontend code and the user wants to review it running:**
expose a port by running, from your current checkout, **`node scripts/worktree.mjs serve`**
(auto-picks a free port in 5200–5299) or **`node scripts/worktree.mjs serve --port <n>`**
(fails fast on an invalid port or one already in use, via `--strictPort`), then **report the
`http://localhost:<port>` URL** to the user. The server runs in the foreground and keeps the
session alive; tell the user to pin the session (`Ctrl+T` in agent view) so it isn't reaped
while idle. Notes: `serve` runs vite from the *current* checkout and installs deps first if
missing, so it works inside an agent-view worktree (`.claude/worktrees/...`) as-is - **do not
run `new` there** (the agent already has its own isolated worktree). `/api` calls still need
the one shared backend up (`pnpm dev` in the main checkout) on `:8787`.
