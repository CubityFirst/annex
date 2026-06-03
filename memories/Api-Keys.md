# Public API + Scoped API Keys

Programmatic REST access to documents and members, authenticated by user-generated
**scoped API keys**. Public reference for consumers lives in `docs/api/README.md`.

## What it is

- A narrow public surface under **`/v1`** on the API worker (reachable publicly at
  `https://<site>/api/v1` because the frontend worker proxies `/api/*` → API
  worker, stripping `/api`).
- Endpoints: doc CRUD + move (`/v1/docs[...]`) and member invite/revoke
  (`/v1/members[...]`). The **site is always implied by the key** — never taken
  from the URL.
- Keys are created/revoked in the UI under **Site Settings → Developer → API Keys**.

## Schema (API DB, `cubedocs-main`)

`api_keys` (migration `0052_add_api_keys.sql`): `id`, `user_id` (owner; bare
string, no cross-DB FK — like `project_members.user_id`), `project_id`
(FK→`projects` `ON DELETE CASCADE`), `name`, `key_hash` (SHA-256 hex, **UNIQUE**
index = lookup index), `key_prefix` (display only), `scope` (`read|readwrite`
CHECK), `can_invite` (0/1), `created_at`, `last_used_at`, `expires_at`,
`revoked_at`.

**Why the API DB, not auth DB:** keys are project-scoped (real FK + cascade), and
management is a plain API-worker write — keeping them out of the read-only
`AUTH_DB` avoids a new auth-worker write path and the 3-package redeploy coupling
that auth-table schema changes carry. The owner is just a stored user id.

## Security model — the load-bearing invariants

1. **Separate auth path, /v1 only.** API keys are authenticated by
   `authenticateApiKey()` (`lib/apiKeys.ts`), wired **only** into the `/v1`
   router (`routes/v1.ts`), via an early-return in `index.ts`. They are
   **never** routed through the shared JWT `authenticate()`. Consequence: a key
   aimed at `/me`, `/projects`, `/docs`, etc. fails JWT parsing → `401`, so it can
   never escape its site/scope ceiling onto a broad handler. **Do not add API-key
   handling to the shared `authenticate()`.**
2. **Keys are ceilings, not grants.** Every `/v1` request re-checks the owner's
   **live** `project_members` role (accepted only). A `readwrite` key still needs
   the owner to be editor+; a `can_invite` key still needs admin+. Removing the
   owner from the site **instantly neuters all their keys**.
3. **Token discrimination.** Keys are prefixed `annx_`; JWTs are 3 dot-separated
   segments and never carry the prefix. `isApiKeyToken()` separates them.
4. **Hashing.** Store only `SHA-256(secret)` (fast hash is correct for
   high-entropy secrets — NOT PBKDF2/`password.ts`, which would tax every API
   call). Secret shown once on creation; lookup by exact hash on a UNIQUE index.
5. **Opaque failures.** Unknown/revoked/expired/garbage key → a single `401` that
   leaks nothing about key state.
6. **Invite hardening.** `apiKeyInviteRoleAllowed` / `apiKeyRemoveAllowed`
   (pure, unit-tested) require admin+, forbid assigning/exceeding `owner`, forbid
   admins removing admins — stricter than the interactive members route.
7. **Invite-capable keys need admin+ to even create.** The UI hides the "Manage
   members" toggle from non-admins, AND `routes/apiKeys.ts` rejects
   `canInvite: true` (403) when the creator's role is below admin — so the raw
   API can't mint a misleadingly invite-flagged key. This is defence in depth on
   top of the live request-time admin re-check (which still handles
   demotion-after-creation).

## Key files

- `packages/api/src/lib/apiKeys.ts` — gen/hash/discriminator, `authenticateApiKey`, pure auth predicates.
- `packages/api/src/lib/docOps.ts` — `createDoc`/`applyDocUpdate`/`deleteDoc`, shared by `routes/docs.ts` (interactive) and `routes/v1.ts` (programmatic) so the two never diverge.
- `packages/api/src/routes/v1.ts` — the public surface (killswitch → key auth → rate limit → scope + live-role enforcement).
- `packages/api/src/routes/apiKeys.ts` — JWT-auth management (`/projects/:id/api-keys`), own-keys only, secret returned once.
- `packages/frontend/src/pages/SiteSettingsPage.tsx` — "API Keys" section (group `developer`).
- Tests: `lib/apiKeys.test.ts` (unit, always runs) + `apiKeys.integration.test.ts` (live-server matrix).

## Rate limiting & killswitch

- `RATE_LIMITER_API` (wrangler `unsafe.bindings`, namespace `2002`, 120/60s) keyed
  by `apikey:<id>`, applied to all `/v1`. Invite email-lookup also reuses
  `RATE_LIMITER_INVITE_LOOKUP` keyed by owner `userId`.
- Flagship flag **`api`** is a global killswitch checked first in `routes/v1.ts`
  (before any auth/DB work) → `503 api_disabled` when off. Defaults to **enabled**
  when the flag/binding is absent (local dev / flag outage) — deliberate-off, not
  fail-closed. Only gates `/v1`; key management stays available so users can still
  revoke during an outage.

## Gotchas

- `routes/docs.ts` was refactored onto `docOps`. `applyDocUpdate` takes a
  `gatherContributors` callback so the interactive collab contributor-collection
  (with its DO-set-clearing side effect) still fires **only on a real content
  change**; the `/v1` path passes none.
- `packages/api/vitest.config.ts` sets `fileParallelism: false` — the integration
  suites share one local dev backend (one SQLite), so parallel files cause
  "database is locked"/lock-fight flakes. Run `pnpm dev` for the live-server
  suites; they auto-skip when servers are down.
