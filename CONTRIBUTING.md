# Contributing

## Setup

This is a pnpm + Turbo monorepo (`packageManager: pnpm@10`, Node 20+ recommended).

```sh
pnpm install
pnpm migrations:local   # apply D1 migrations to the shared local dev state
pnpm dev                # frontend :5173, api :8787, auth :8788, admin :8789
```

The dev servers share one wrangler state at the monorepo root (`.wrangler/state`). Any manual `wrangler d1` command must pass `--persist-to ../../.wrangler/state` from the package directory or it will hit a state the dev servers never read. All wrangler invocations go through `npx wrangler`.

## Packages

- `packages/frontend` - React 19 SPA (Vite, Tailwind CSS 4, shadcn/ui)
- `packages/api` - Core Cloudflare Worker (projects, docs, files)
- `packages/auth` - Auth Cloudflare Worker (login, register, TOTP, WebAuthn, OIDC)
- `packages/admin` - Admin Cloudflare Worker + admin frontend
- `e2e` - Playwright end-to-end tests

See `CLAUDE.md` for architecture notes, database schemas, and the critical invariants around auth, access checks, API keys, and custom domains. Read the relevant section before touching one of those systems.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/) with a **type and a scope**:

```
<type>(<scope>): <short imperative summary>
```

Examples:

```
feat(frontend): draft-first doc creation
fix(auth): continue 2FA step via short-lived pre-auth token
refactor(api): route all per-site access checks through lib/access.ts
test(e2e): cover org invite acceptance
docs(api): document the /v1 rate limits
chore(deps): bump wrangler to 4.101
```

**Types:** `feat`, `fix`, `refactor`, `perf`, `docs`, `test`, `style`, `chore`, `ci`, `build`.

**Scope** is the package or system you touched: `frontend`, `api`, `auth`, `admin`, `e2e`, or a feature area such as `files`, `docs`, `search`, `orgs`, `billing`, `collab`, `oidc`, `domains`, `demo`, `wrangler`, `deps`. Pick the narrowest scope that covers the change; use the package name when a change spans several areas within one package.

Keep the summary lowercase, imperative, and under ~72 characters. Use the body for the "why" when it isn't obvious. Mark breaking changes with `!` after the scope (`feat(api)!: ...`) and explain the break in the body.

## Tests

Run tests before opening a PR when your change is testable:

```sh
pnpm --filter <api|auth|frontend> test   # vitest, per package
pnpm test                                # all packages + e2e
pnpm test:e2e                            # Playwright (first run: pnpm --filter cubedocs-e2e install:browsers)
pnpm typecheck
```

When you add behavior in an area that already has a test suite, extend that suite rather than leaving the change untested.

## Pull requests

- Keep PRs focused on one change; separate refactors from behavior changes.
- Schema changes: migrations live only in `packages/api/migrations/` and `packages/auth/migrations/`. A change to auth-DB columns read by `loadCurrentSession` requires redeploying auth + api + admin, in that order - call this out in the PR description.
- If you add or remove a runtime dependency in `packages/frontend`, update `src/lib/acknowledgements.ts` to match.
