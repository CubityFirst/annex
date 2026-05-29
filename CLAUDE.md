## Monorepo Structure

pnpm + Turbo monorepo 

- `packages/frontend` — React 19 SPA (Vite, Tailwind CSS 4, shadcn/ui)
- `packages/api` — Core Cloudflare Worker (projects, docs, files)
- `packages/auth` — Auth Cloudflare Worker (login, register, TOTP, WebAuthn)

### Auth

Authentication uses `Authorization: Bearer <JWT>` headers. JWTs are issued by the Auth Worker and verified by the API Worker via a shared `JWT_SECRET`. The Auth Worker handles all identity concerns (register, login, TOTP, WebAuthn).

**Verification boundary — read this before touching auth flow:**

- **API Worker verifies sessions inline.** It binds the auth D1 as `AUTH_DB` (read-only by convention — no migrations) and calls `loadCurrentSession` from `packages/auth/src/session.ts` directly. One batched read of `sessions` + a `users` row LEFT-JOINed against `user_billing` and `user_preferences`, no service-binding hop. This is what every authenticated API request goes through (`packages/api/src/auth.ts`).
- **Auth Worker still owns writes.** Login, register, change-password, session revoke, TOTP/WebAuthn enroll, lookup, etc. are still proxied through the `AUTH` service binding from the API worker. Anything that mutates the auth DB or needs rate limiting / email sending stays in the auth worker.
- **Cross-package import.** API worker imports `loadCurrentSession`, `sessionResultToResponse`, and `verifyJwt` directly from `packages/auth/src/`. The API tsconfig lists those files in `include`. **A schema change to `users` / `sessions` / `user_billing` / `user_preferences` columns referenced in `loadCurrentSession` requires redeploying auth + api + admin (in that order)**, because all three packages read these tables directly. Migrations themselves still only live in `packages/auth/migrations/`.
- The auth worker's `/verify` endpoint still exists but the API worker no longer calls it — leave it in place for now in case external tooling depends on it.

### Database Schemas

- **API DB** (`cubedocs-main`): projects, docs (+ `doc_ai_summaries` satellite), doc_revisions, folders, files, members — see `packages/api/migrations/`. Bound as `DB` on the API worker.
- **Auth DB** (`cubedocs-auth`): users, sessions, totp, webauthn_credentials, plus the 1:1 satellites `user_billing` (Stripe + plan state) and `user_preferences` (fonts, Ink cosmetics, timezone, bio, badges) — see `packages/auth/migrations/`. Bound as `DB` on the auth worker (read+write) and as `AUTH_DB` on the API worker (read-only by convention).

#### Satellite tables and the resolver

`users`, `docs`, and other "hot" tables have been kept narrow by moving rarely-needed columns into 1:1 satellite tables keyed by the parent's id. The pattern:

- Satellite row is created lazily — first write does `INSERT … ON CONFLICT(parent_id) DO UPDATE SET …`. A user/doc/etc. that has never had the feature touched has no satellite row at all.
- Every reader does `LEFT JOIN <satellite> ON <satellite>.<parent>_id = <parent>.id`. Missing rows return NULL for every satellite column, which the consumer treats as "default."
- The satellite declares `REFERENCES <parent>(id) ON DELETE CASCADE` so deleting the parent wipes the satellite row automatically.
- Existing satellites: `doc_ai_summaries` (api DB; ai_summary cache), `user_billing` (auth DB; Stripe/plan state), `user_preferences` (auth DB; fonts + cosmetics + timezone + bio + badges).

`resolvePersonalPlan` in `packages/auth/src/plan.ts` is fed inputs from multiple tables (billing-state from `user_billing`, cosmetic prefs from `user_preferences`). Callers build a flat `PlanRow` from the LEFT-JOINed query result and hand it to the resolver — see `loadCurrentSession`, `members.ts`, `update-ink-prefs.ts` for the pattern.

## Frontend Notes

- UI components from shadcn/ui — always use these instead of raw HTML elements when possible
- Document rendering and editing both go through `packages/frontend/src/components/wysiwyg/WysiwygEditor.tsx` (CodeMirror 6, Lezer markdown grammar, decoration-based inline-rendered widgets). The `mode` prop selects `"reading"` | `"editing"` | `"raw"`.
- `react-markdown` + remark plugins is still used for the AI-summary block in `DocPage.tsx` and the file-summary block in `FileManager.tsx`, but not for the main document body.
- Authenticated images use the `AuthenticatedImage` component (fetches with auth header)
- PWA service worker in `dev-dist/sw.js` (auto-generated — do not edit manually)

### Dice Module

`packages/frontend/src/lib/dice.ts` — parser and roller for dice notation.
`packages/frontend/src/components/DiceRoll.tsx` — clickable inline dice roll widget used in rendered markdown.

**Supported notation:** see `memories/Dice-Notation.md` — read that file when you need details on dice notation syntax (table of examples, reroll/keep/explode/success-count behavior, operator precedence).

## Annex Ink + Stripe

Personal supporter subscription ($5/mo) with Stripe billing, comp-grant override, animated avatar ring, admin grant/revoke/cancel controls, and a webhook proxy through the frontend worker. **Anything touching the `user_billing` table (Stripe ids, `personal_plan_*`, `granted_plan_*`), the cosmetic-pref columns on `user_preferences` (`personal_plan_style`, `personal_presence_color`, `personal_crit_sparkles`), `billing.ts`, `stripe-webhook.ts`, the billing UI in user settings or the admin user-details sheet, or the `InkBillingCard` belongs to this system** — see `memories/Ink-Stripe.md` for schema, plan resolution rules, webhook flow, deploy/dev setup, and ops cheatsheet.

## Realtime Collaboration

Yjs-based realtime co-editing gated per-project by `projects.features & 4` (`ProjectFeatures.REALTIME`), served from the `DocCollabRoom` Durable Object behind the API worker. **Anything touching `DocCollabRoom`, the `/api/docs/:id/collab` WebSocket route, `CollabProvider`, `EditorPresence`, or the `collab` prop on `WysiwygEditor` belongs to this system** — see `memories/Collab.md` for architecture, key files, WebSocket auth flow, reconnect behavior, and the local-enable command.

## Tests

Tests exist — run them before reporting work as done when changes are testable.

- **Vitest unit tests** live next to source as `*.test.ts(x)` in each package. Run per-package with `pnpm --filter <api|auth|frontend> test`, or all packages + e2e with `pnpm test` from the root. Coverage is heaviest in `packages/auth` (login, password, jwt, totp, plan, billing, stripe-webhook) and `packages/frontend/src/lib` (remark plugins, dice, frontmatter, userColor).
- **Playwright e2e tests** live in `e2e/tests/` (`2fa`, `app`, `change-password`, `invites`, `limited-permissions`). Run with `pnpm test:e2e` (headless) or `pnpm test:e2e:ui` (UI mode). First run needs `pnpm --filter cubedocs-e2e install:browsers`.
- When adding behavior with existing test coverage in the same area, extend the corresponding suite rather than leaving it untested.

## CLI Notes

- All wrangler commands must be prefixed with `npx` (e.g. `npx wrangler d1 execute ...`)

## Local D1 State

The dev servers use a shared wrangler state at the **monorepo root** (`/.wrangler/state`), not inside each package. This is set via `--persist-to ../../.wrangler/state` in each package's dev script.

When running local D1 migrations or queries, always pass `--persist-to ../../.wrangler/state` from the package directory, otherwise the command hits the package-local `.wrangler/state` which the dev server never reads.

```
# Correct — targets the shared dev state
cd packages/auth && npx wrangler d1 execute cubedocs-auth --local --persist-to ../../.wrangler/state --command "..."

# Wrong — targets packages/auth/.wrangler/state, ignored by dev server
cd packages/auth && npx wrangler d1 execute cubedocs-auth --local --command "..."
```

## Parallel Worktrees (dev review)

For running several feature branches side-by-side (e.g. many agents in parallel, each
reviewable in a browser on its own port), use `scripts/worktree.mjs`. The main checkout runs
the full stack via `pnpm dev` (frontend 5173 + api 8787 + auth 8788 + admin 8789 + the shared
`.wrangler/state` D1) — that's the **one backend**. Each worktree adds **another frontend** on
its own port, and the Vite `/api` proxy (hardcoded to `:8787` in `vite.config.ts`) makes every
worktree frontend talk to that single backend and share the one dev DB. No app-code or
vite-config changes.

```
node scripts/worktree.mjs new <name> [--base main] [--start]   # create + install + assign port
node scripts/worktree.mjs list                                 # worktrees, ports, serving status
node scripts/worktree.mjs rm <name> [--force]                  # remove worktree, free port
```

Worktrees live at `../cubedocs-worktrees/<name>` — **on the same drive as the repo** so
`pnpm install` hardlinks from the warm pnpm store (`G:\.pnpm-store`) instead of copying.
Ports are assigned from 5200–5299 and persisted in the gitignored `.worktree-ports.json`
so each feature keeps a stable review port. **The shared dev DB is the boundary of this
model** — a schema migration on one branch hits everyone; run an isolated backend manually
if a branch needs its own schema. See `memories/Worktree-Dev.md` for the full workflow,
caveats (per-port login, dev service-worker staleness, one-backend-at-a-time), and when to
use this vs. the agents' built-in ephemeral `isolation: "worktree"`.
