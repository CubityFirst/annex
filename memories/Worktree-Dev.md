# Parallel Worktrees for Dev Review

Run many feature branches at once - each on its own git worktree and reviewable live in a
browser on its own port - while a single shared backend serves them all. Driven by
`scripts/worktree.mjs`.

## The model

```
main checkout  G:\Scripts\cubedocs        →  pnpm dev   (frontend 5173 + api 8787 + auth 8788
                                              + admin 8789 + the shared .wrangler/state D1)  ── full
                                              stack; the api/auth/admin here are the ONE backend
worktree A     ..\cubedocs-worktrees\feat-x  (branch feat-x)  →  vite --port 5200 ─┐
worktree B     ..\cubedocs-worktrees\feat-y  (branch feat-y)  →  vite --port 5201 ─┼─ all proxy /api → :8787
worktree C     ...                                            →  vite --port 5202 ─┘
```

The main checkout's `pnpm dev` also serves its own frontend on 5173 (the default review URL);
worktree frontends are *additional* frontends on 5200+, all sharing that one backend.

**Why it needs no code changes:** the frontend reaches the backend *only* through the Vite
`/api` proxy (`packages/frontend/vite.config.ts`), hardcoded to `http://localhost:8787` with
`ws:true`. App code never makes absolute-URL calls to the workers. So any frontend, on any
port, in any worktree, automatically talks to whatever single backend is on 8787 - and the
`ws:true` proxy carries the Yjs collab socket there too, so realtime collab works in worktree
frontends against the shared backend.

**Why installs are cheap on Windows:** the pnpm store is `G:\.pnpm-store` - same drive as the
repo. `pnpm install` in a worktree on `G:` **hardlinks** from that warm store (no re-download,
near-zero extra disk), and pnpm uses **junctions** (not symlinks) for its internal
`node_modules/.pnpm` links, so no admin/Developer-Mode is needed. This is why each worktree
gets its own `node_modules` (the gitignored, per-worktree way) rather than a shared/symlinked
one - it's both correct and fast.

## Commands

```
node scripts/worktree.mjs new <name> [--base main] [--start]
node scripts/worktree.mjs serve [--port <n>]
node scripts/worktree.mjs list
node scripts/worktree.mjs rm <name> [--force]
```

- **new** - `git worktree add` at `..\cubedocs-worktrees\<name>` (sibling of the repo, on the
  same drive; warns if cross-drive), `pnpm install --frozen-lockfile` (falls back to a plain
  install if the branch adds a brand-new dep not yet in the store - note `minimumReleaseAge:
  10080` in `pnpm-workspace.yaml`), assigns a stable port from 5200–5299, then prints the dev
  command (or with `--start` runs it). Validates the name (safe git-branch chars only) and
  refuses to install into a path that exists but isn't a real worktree.
- **serve** - runs the frontend from the *current* checkout (creates no worktree, no registry),
  auto-picking a free port in 5200–5299 (or `--port <n>`, guarded to 1–65535). Installs deps
  first if missing. This is the one-liner an isolated agent runs to expose a review port - see
  "Agent view" below.
- **list** - parses `git worktree list --porcelain`, cross-references the registry, and probes
  each port (concurrently, both IPv4+IPv6) for serving status.
- **rm** - `git worktree remove`, then force-deletes the leftover dir (Windows leaves it) and
  prunes; frees the port. With `--force`, cleanup runs even if the git remove fails. The branch
  is left intact (merge/delete it separately).

The dev server is launched as **`pnpm exec vite --port <port> --strictPort`** run from the
frontend package dir - *not* `pnpm <script> -- <args>`, whose `--` was observed leaking through
to vite (so `--port` was ignored and Vite drifted to another port). `--strictPort` makes a taken
port fail loudly. Ports are persisted in `.worktree-ports.json` at the repo root (gitignored),
keyed by name, so a feature keeps the same review port across restarts.

## Caveats (and why)

- **Shared dev DB is the boundary.** Every worktree frontend reads/writes the one
  `.wrangler/state` D1. Fine for UI/frontend work, but **a schema migration on one branch hits
  everyone's shared DB.** If a feature needs isolated schema changes, run a separate backend
  manually (its own `--persist-to <dir>` + `pnpm migrate`) and point that worktree's proxy at it
  - that's the deliberate escape hatch, not built into the script.
- **Only one backend at a time.** Local D1 is SQLite; never start a second `wrangler dev`
  against the same state dir. The model relies on exactly one backend (the main checkout's
  `pnpm dev`).
- **Login is per-port.** The JWT lives in `localStorage`, which is per-origin, so `:5200` and
  `:5201` are separate browser sessions - log in on each port (same credentials, same backend).
  Clean isolation for review, not a bug.
- **PWA service worker is on in dev** (`vite.config.ts` `devOptions.enabled:true`,
  `registerType:"prompt"`). Per-origin scopes don't collide, but cached assets can show stale
  content while reviewing - use a private/incognito window or hard-reload.

## Which worktree mechanism to use

- **Ephemeral agent edits → the Agent/Workflow tools' built-in `isolation: "worktree"`**
  (lands under the gitignored `.claude/worktrees/`, auto-cleaned, no running server). Use when a
  subagent should produce a diff in isolation, not a reviewable server.
- **Long-lived, human-reviewable features → `scripts/worktree.mjs new`.** Persistent branch +
  worktree + a frontend on a fixed port to open and review, then commit/merge and `rm`.

## Agent view (`claude agents`)

Agent view already isolates each background session in its own worktree under
`.claude/worktrees/` (before the first edit) and its review model is **PR-centric** - there is
no built-in dev-server/port/preview concept. So agents do **not** auto-expose a frontend. To get
a reviewable port:

1. Keep the one backend up in the main checkout (`pnpm dev` → `:8787` + shared DB).
2. In the agent's prompt, tell it to **`node scripts/worktree.mjs serve`** (auto-port) or
   `serve --port <n>` after editing, and to report the `http://localhost:<port>` URL. `serve`
   runs from the agent's own checkout, so **don't tell it to run `new`** (it's already isolated).
3. **Pin the session (`Ctrl+T`)** - a dev server keeps the session alive, but an unattached idle
   session is reaped after ~1 h unless pinned.
4. Open the reported URL, review, merge the PR/branch.

Gotchas specific to agent view: each agent-view worktree has its *own* `.worktree-ports.json`, so
the registry can't coordinate ports across agents - `serve`'s live port-probe handles collisions
instead (assign explicit `--port`s in prompts if you want fixed URLs). Deleting a session **deletes
its worktree** (merge/push first), and N parallel agents burn ~N× usage quota.
