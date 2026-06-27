## Monorepo Structure

pnpm + Turbo monorepo 

- `packages/frontend` - React 19 SPA (Vite, Tailwind CSS 4, shadcn/ui)
- `packages/api` - Core Cloudflare Worker (projects, docs, files)
- `packages/auth` - Auth Cloudflare Worker (login, register, TOTP, WebAuthn)

### Auth

Authentication uses `Authorization: Bearer <JWT>` headers. JWTs are issued by the Auth Worker and verified by the API Worker via a shared `JWT_SECRET`. The Auth Worker handles all identity concerns (register, login, TOTP, WebAuthn).

**Verification boundary - read this before touching auth flow:**

- **API Worker verifies sessions inline.** It binds the auth D1 as `AUTH_DB` (read-only by convention - no migrations) and calls `loadCurrentSession` from `packages/auth/src/session.ts` directly. One batched read of `sessions` + a `users` row LEFT-JOINed against `user_billing` and `user_preferences`, no service-binding hop. This is what every authenticated API request goes through (`packages/api/src/auth.ts`).
- **Auth Worker still owns writes.** Login, register, change-password, session revoke, TOTP/WebAuthn enroll, lookup, etc. are still proxied through the `AUTH` service binding from the API worker. Anything that mutates the auth DB or needs rate limiting / email sending stays in the auth worker.
- **Cross-package import.** API worker imports `loadCurrentSession`, `sessionResultToResponse`, and `verifyJwt` directly from `packages/auth/src/`. The API tsconfig lists those files in `include`. **A schema change to `users` / `sessions` / `user_billing` / `user_preferences` columns referenced in `loadCurrentSession` requires redeploying auth + api + admin (in that order)**, because all three packages read these tables directly. Migrations themselves still only live in `packages/auth/migrations/`.
- The auth worker's `/verify` endpoint still exists but the API worker no longer calls it - leave it in place for now in case external tooling depends on it.

### Database Schemas

- **API DB** (`cubedocs-main`): projects, docs (+ `doc_ai_summaries` satellite), doc_revisions, folders, files, members - see `packages/api/migrations/`. Bound as `DB` on the API worker.
- **Auth DB** (`cubedocs-auth`): users, sessions, totp, webauthn_credentials, plus the 1:1 satellites `user_billing` (Stripe + plan state) and `user_preferences` (fonts, Ink cosmetics, timezone, bio, badges) - see `packages/auth/migrations/`. Bound as `DB` on the auth worker (read+write) and as `AUTH_DB` on the API worker (read-only by convention).

#### Satellite tables and the resolver

`users`, `docs`, and other "hot" tables have been kept narrow by moving rarely-needed columns into 1:1 satellite tables keyed by the parent's id. The pattern:

- Satellite row is created lazily - first write does `INSERT … ON CONFLICT(parent_id) DO UPDATE SET …`. A user/doc/etc. that has never had the feature touched has no satellite row at all.
- Every reader does `LEFT JOIN <satellite> ON <satellite>.<parent>_id = <parent>.id`. Missing rows return NULL for every satellite column, which the consumer treats as "default."
- The satellite declares `REFERENCES <parent>(id) ON DELETE CASCADE` so deleting the parent wipes the satellite row automatically.
- Existing satellites: `doc_ai_summaries` (api DB; ai_summary cache), `user_billing` (auth DB; Stripe/plan state), `user_preferences` (auth DB; fonts + cosmetics + timezone + bio + badges).

`resolvePersonalPlan` in `packages/auth/src/plan.ts` is fed inputs from multiple tables (billing-state from `user_billing`, cosmetic prefs from `user_preferences`). Callers build a flat `PlanRow` from the LEFT-JOINed query result and hand it to the resolver - see `loadCurrentSession`, `members.ts`, `update-ink-prefs.ts` for the pattern.

## Frontend Notes

- UI components from shadcn/ui - always use these instead of raw HTML elements when possible
- Document rendering and editing both go through `packages/frontend/src/components/wysiwyg/WysiwygEditor.tsx` (CodeMirror 6, Lezer markdown grammar, decoration-based inline-rendered widgets). The `mode` prop selects `"reading"` | `"editing"` | `"raw"`.
- `react-markdown` + remark plugins is still used for the AI-summary block in `DocPage.tsx` and the file-summary block in `FileManager.tsx`, but not for the main document body.
- Authenticated images use the `AuthenticatedImage` component (fetches with auth header)
- PWA service worker in `dev-dist/sw.js` (auto-generated - do not edit manually)
- The public marketing/legal pages (landing, privacy, terms, acknowledgements) share one footer: `components/SiteFooter.tsx`. **Use `<SiteFooter />` on any new page in that family** instead of hand-rolling a `l-footer` block, so the link set stays identical everywhere.
- The **Acknowledgements** page (`/acknowledgements`, `pages/AcknowledgementsPage.tsx`, linked from `SiteFooter`) lists bundled open-source libraries and is driven by `packages/frontend/src/lib/acknowledgements.ts`. **When you add or remove a runtime dependency in `packages/frontend/package.json`, update `acknowledgements.ts` to match** - name, license (read the real value from the package's `package.json`, don't assume MIT), and project URL.
- File preview/classification flows through `lib/fileKind.ts` (`fileKind()` → icon + which inline preview). **Excalidraw drawings are a file kind** (`.excalidraw` → kind `"drawing"`): they reuse the `files` table/R2 but are the one **mutable** file (overwritten by `PUT /files/:id/content`, gated to the `application/vnd.excalidraw+json` vendor MIME via `isMutableFile`; content ETag is versioned by `files.updated_at`). The heavy `@excalidraw/excalidraw` editor is lazy-loaded in `ExcalidrawCanvas`. **Anything touching the drawing editor, the mutable-content path, `files.updated_at`, or the `"drawing"` kind belongs to this system** - see `memories/Excalidraw.md`.

### Dice Module

`packages/frontend/src/lib/dice.ts` - parser and roller for dice notation.
`packages/frontend/src/components/DiceRoll.tsx` - clickable inline dice roll widget used in rendered markdown.

**Supported notation:** see `memories/Dice-Notation.md` - read that file when you need details on dice notation syntax (table of examples, reroll/keep/explode/success-count behavior, operator precedence).

## Demo Mode

The landing page's "See a demo" links to **`/demo`**, a local-only sandbox: a sessionStorage flag (`lib/demo.ts`) makes `main.tsx` install `lib/demoServer.ts`, which patches `window.fetch` and answers every `/api/*` call from an in-memory dataset (one "Demo Site", seeded docs/files/revisions; site/org creation refused; anonymous auth endpoints like `/api/login` pass through). The real DocsLayout/Dashboard/FileManager/DocPage run unmodified; `getToken()` hands out a fake JWT while the flag is set, and DocsLayout shows the "this is a demo environment" banner. Nothing persists - the store dies on reload. Tests: `e2e/tests/demo.spec.ts` (needs only the frontend dev server).

## Annex Ink + Stripe

Personal supporter subscription ($5/mo) with Stripe billing, comp-grant override, animated avatar ring, admin grant/revoke/cancel controls, and a webhook proxy through the frontend worker. **Anything touching the `user_billing` table (Stripe ids, `personal_plan_*`, `granted_plan_*`), the cosmetic-pref columns on `user_preferences` (`personal_plan_style`, `personal_presence_color`, `personal_crit_sparkles`), `billing.ts`, `stripe-webhook.ts`, the billing UI in user settings or the admin user-details sheet, or the `InkBillingCard` belongs to this system** - see `memories/Ink-Stripe.md` for schema, plan resolution rules, webhook flow, deploy/dev setup, and ops cheatsheet.

## Realtime Collaboration

Yjs-based realtime co-editing gated per-project by `projects.features & 4` (`ProjectFeatures.REALTIME`), served from the `DocCollabRoom` Durable Object behind the API worker. **Anything touching `DocCollabRoom`, the `/api/docs/:id/collab` WebSocket route, `CollabProvider`, `EditorPresence`, or the `collab` prop on `WysiwygEditor` belongs to this system** - see `memories/Collab.md` for architecture, key files, WebSocket auth flow, reconnect behavior, and the local-enable command.

## Public API & Scoped API Keys

A narrow public REST surface under **`/v1`** on the API worker (reachable at `https://<site>/api/v1`), authenticated by user-generated **scoped API keys** (`annx_…`) created in Site Settings → Developer → API Keys. Covers doc CRUD + move and member invite/revoke; the site is always implied by the key. **Anything touching the `api_keys` table, `lib/apiKeys.ts`, `lib/docOps.ts`, `routes/v1.ts`, `routes/apiKeys.ts`, the `RATE_LIMITER_API` binding, the Flagship `api` killswitch, or the "API Keys" settings section belongs to this system** - see `memories/Api-Keys.md` for schema, the security invariants (separate key-only auth path used **only** by `/v1`; keys are ceilings re-checked against live membership), rate limiting/killswitch, and tests. Public consumer reference: `docs/api/README.md`.

**Critical invariant:** API keys are authenticated by `authenticateApiKey` and wired **only** into the `/v1` router - never through the shared JWT `authenticate()`. A key sent to any other route fails JWT parsing → 401, which is what stops a scoped key from escaping its site/scope ceiling. Do not route keys through `authenticate()`.

## Organizations (a level above sites)

An **organization** is a collection of sites (`projects`) with **trickle-down roles**: an org member's role applies to every site in the org (org owner→site owner, admin→admin, editor→editor, viewer→viewer). A site belongs to at most one org (nullable `projects.organization_id`, `ON DELETE SET NULL`). Schema (API DB) in `0054_add_organizations.sql`: `organizations`, `organization_members` (roles `viewer|editor|admin|owner`, no `limited`). **Anything touching `organizations`/`organization_members`, `routes/organizations.ts`, `lib/access.ts`, the `organizationId` arg on `POST /projects`, the org pages (`OrgPage`, `OrgSettingsPage`, the "Your Orgs" dashboard section, `openCreateOrg`), or the pending-invites union belongs to this system** - see `memories/Organizations.md`.

**Critical invariant - `lib/access.ts` is the single per-site access-check boundary.** Every authenticated per-site authorization gate resolves the caller's *effective* role via `resolveAccess`/`resolveRole` = the higher `ROLE_RANK` of (direct `project_members` row, accepted `organization_members` role for the site's org). **Do NOT re-introduce a local `getCallerRole` or an inline `SELECT role FROM project_members …` for a caller-access gate.** Direct `project_members` queries remain ONLY for: target-row escalation guards (members/docShares), attribution joins (`author_id`/`uploaded_by`), the `GET /projects` "Your Sites" list, the site members-list *contents*, and **attach's site-owner check** (which must be the caller's *direct* role, never effective). Org trickle-down flows into `/v1`'s `liveCaller` too (the key's role floor), while scope/`canInvite` stay independent ceilings. Orgs live entirely in the API DB (no auth-DB coupling / triple-redeploy).

## Custom Domains (Cloudflare for SaaS)

A site owner can map their **own domain** (e.g. `docs.example.com`) to their published site via Cloudflare for SaaS **custom hostnames**. Cloudflare issues + auto-renews the DV cert and routes the host to the frontend Worker, which serves the site at **clean root URLs** (`docs.example.com/`, `docs.example.com/<docId>`). **This is the same feature as the vanity slug - both are gated by the single `ProjectFeatures.CUSTOM_LINK` (bit 1) flag** (admin-enabled per-site in the admin app; surfaced together in Site Settings → Site → "Custom Link & Domain"). One domain per site (`project_custom_domains` is keyed by `project_id`, globally-unique `hostname`).

**Anything touching `project_custom_domains` (`0055_add_custom_domains.sql`), `lib/customDomains.ts` (the Cloudflare API client + `isValidHostname`/`deriveDnsRecords`/`deriveStatus` pure helpers), `routes/customDomains.ts` (`/projects/:id/domain` GET/PUT/DELETE + `/refresh`), the `/public/site-by-host` resolver, the host-mode serving path (`lib/siteUrl.ts`, `CustomDomainApp`, the base-path-aware `PublicDocPage`/`SearchPalette`), or the Custom Domain UI in Site Settings belongs to this system** - see `memories/Custom-Domains.md` for schema, the Cloudflare API flow, the **one-time zone setup** (on a **dedicated `yourannex.com` SaaS zone** - kept separate from `cubityfir.st` so the `*/*` route can't shadow our own hosts: enable SaaS, fallback origin, `*/*` Worker route → `annex-frontend`, `CF_API_TOKEN`/`CF_ZONE_ID`/`CUSTOM_DOMAIN_CNAME_TARGET = publish.yourannex.com`), host-detection rules + the dev `?__site=` override, and tests.

**Critical invariant:** the custom domain serves a **published, read-only** public site only - never the authenticated app (sessions/JWT are per-origin). Host detection (`isCustomDomain` in `lib/siteUrl.ts`) treats `localhost`/`*.cubityfir.st`/`*.workers.dev`/`*.pages.dev`/`*.local` as app hosts; anything else is a custom domain and boots `CustomDomainApp` (site-only routes). When `CF_API_TOKEN`/`CF_ZONE_ID` are unset the endpoints report "not configured" and never call Cloudflare.

## Sign in with Annex (OIDC provider)

Annex is an **OpenID Connect identity provider** (authorization-code + PKCE, RS256
id_tokens via JWKS) so other first-party services can offer "Sign in with Annex".
Issuer is the dedicated host **`https://auth.cubityfir.st`** (the auth worker serves
`/oauth/{token,userinfo,jwks}` + `/.well-known/openid-configuration` there via routes
in its `wrangler.toml`); the browser-facing **authorization_endpoint is a SPA page on
the app origin** `docs.cubityfir.st/oauth/authorize` because the user's Annex session
lives there. **Anything touching `oauth_clients`/`oauth_codes` (`0028_*`), `src/oidc.ts`,
`routes/oauth-*.ts`, the `/oauth/authorize` proxy, the `RATE_LIMITER_OIDC` binding,
`OAuthAuthorizePage`, the `OIDC_*` vars/secret, the admin client-management surface
(`packages/admin` `routes/oauth.ts` proxy + `OAuthClientsPage` "OAuth" tab → auth worker
`/admin/oauth/clients*`), or the `scripts/{gen-oidc-key,register-oauth-client}.mjs`
helpers belongs to this system** - see `memories/Oidc-Provider.md` and `docs/oauth/README.md`.

**Critical invariants:** exact redirect-URI match only (no wildcards; never redirect to an
unvalidated URI); PKCE S256 mandatory and verified *before* the single-use code is consumed;
RS256 signs with a dedicated `OIDC_PRIVATE_KEY` (never the session `JWT_SECRET`) and the verifier
pins `alg`; disabled clients + suspended users are refused at authorize, token, AND userinfo.

## Tests

Tests exist - run them before reporting work as done when changes are testable.

- **Vitest unit tests** live next to source as `*.test.ts(x)` in each package. Run per-package with `pnpm --filter <api|auth|frontend> test`, or all packages + e2e with `pnpm test` from the root. Coverage is heaviest in `packages/auth` (login, password, jwt, totp, plan, billing, stripe-webhook) and `packages/frontend/src/lib` (remark plugins, dice, frontmatter, userColor).
- **Playwright e2e tests** live in `e2e/tests/` (`2fa`, `app`, `change-password`, `invites`, `limited-permissions`). Run with `pnpm test:e2e` (headless) or `pnpm test:e2e:ui` (UI mode). First run needs `pnpm --filter cubedocs-e2e install:browsers`.
- When adding behavior with existing test coverage in the same area, extend the corresponding suite rather than leaving it untested.

## CLI Notes

- All wrangler commands must be prefixed with `npx` (e.g. `npx wrangler d1 execute ...`)

## Local D1 State

The dev servers use a shared wrangler state at the **monorepo root** (`/.wrangler/state`), not inside each package. This is set via `--persist-to ../../.wrangler/state` in each package's dev script.

When running local D1 migrations or queries, always pass `--persist-to ../../.wrangler/state` from the package directory, otherwise the command hits the package-local `.wrangler/state` which the dev server never reads.

```
# Correct - targets the shared dev state
cd packages/auth && npx wrangler d1 execute cubedocs-auth --local --persist-to ../../.wrangler/state --command "..."

# Wrong - targets packages/auth/.wrangler/state, ignored by dev server
cd packages/auth && npx wrangler d1 execute cubedocs-auth --local --command "..."
```

## Parallel Worktrees (dev review)

For running several feature branches side-by-side (e.g. many agents in parallel, each
reviewable in a browser on its own port), use `scripts/worktree.mjs`. The main checkout runs
the full stack via `pnpm dev` (frontend 5173 + api 8787 + auth 8788 + admin 8789 + the shared
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
