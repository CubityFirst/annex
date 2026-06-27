#!/usr/bin/env node
// Parallel-worktree dev helper for Annex.
//
// Model: the main checkout runs the full stack via `pnpm dev` (frontend 5173 + api 8787
// + auth 8788 + admin 8789), owning the shared .wrangler/state D1 - that's the ONE backend.
// Each worktree adds ANOTHER frontend `vite` on its own port; the Vite /api proxy (hardcoded
// to :8787) makes every worktree frontend talk to that single backend and share the one dev DB.
//
// Worktrees live on the same drive as the repo so `pnpm install` hardlinks from the
// warm pnpm store (no re-download, near-zero disk; junctions, not symlinks, on Windows).
//
//   node scripts/worktree.mjs new <name> [--base <branch>] [--start]
//   node scripts/worktree.mjs serve [--port <n>]   (run frontend from the current checkout)
//   node scripts/worktree.mjs list
//   node scripts/worktree.mjs rm <name> [--force]

import { execSync, spawnSync } from "child_process";
import { resolve, dirname, parse as parsePath } from "path";
import { fileURLToPath } from "url";
import { readFileSync, writeFileSync, existsSync } from "fs";
import net from "net";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const REGISTRY = resolve(root, ".worktree-ports.json");
const WORKTREE_PARENT = resolve(root, "..", "cubedocs-worktrees");
const DEFAULT_BASE = "main";
const PORT_MIN = 5200;
const PORT_MAX = 5299;
const BACKEND_PORT = 8787;

// ---------- shell + logging ----------

function sh(cmd, cwd) {
  execSync(cmd, { cwd, stdio: "inherit" });
}

function step(label, cmd, cwd) {
  console.log(`\n→ ${label}`);
  sh(cmd, cwd);
  console.log(`✓ ${label}`);
}

function git(args) {
  return execSync(`git ${args}`, { cwd: root, encoding: "utf8" });
}

// Force-delete a directory tree. Uses `rmdir /s /q` on Windows, which removes junction
// reparse points WITHOUT following them into the pnpm store (so deleting a worktree's
// node_modules never touches the shared store). `git worktree remove` sometimes leaves
// the physical dir behind on Windows when node_modules is present.
function forceRemoveDir(p) {
  if (!existsSync(p)) return;
  if (process.platform === "win32") {
    execSync(`cmd /c rmdir /s /q "${p}"`, { stdio: "ignore" });
  } else {
    execSync(`rm -rf "${p}"`, { stdio: "ignore" });
  }
}

function branchExists(name) {
  try {
    execSync(`git rev-parse --verify --quiet "refs/heads/${name}"`, {
      cwd: root,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

// Reject names that aren't safe git branch names. Also closes the shell-quoting hole:
// `name` is interpolated into `git ... "${name}"`, so a quote/metachar must not get through.
function assertSafeName(name) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name) || name.includes("..") || name.endsWith("/")) {
    console.error(
      `✗ Invalid name "${name}". Use letters, digits, and . _ / - (no spaces, quotes, or "..").`
    );
    process.exit(1);
  }
}

// Resolved paths of all current git worktrees (so we can tell a real worktree from a
// leftover/foreign directory sitting at the target path).
function worktreePaths() {
  const set = new Set();
  for (const line of git("worktree list --porcelain").split("\n")) {
    if (line.startsWith("worktree ")) set.add(resolve(line.slice("worktree ".length).trim()));
  }
  return set;
}

// ---------- registry ----------

function loadRegistry() {
  if (!existsSync(REGISTRY)) return {};
  try {
    return JSON.parse(readFileSync(REGISTRY, "utf8"));
  } catch {
    return {};
  }
}

function saveRegistry(reg) {
  writeFileSync(REGISTRY, JSON.stringify(reg, null, 2) + "\n");
}

// ---------- ports ----------

// Is something currently serving on the port (accepts connections)? Try both IPv4
// and IPv6 loopback - Vite binds `localhost`, which is `::1` on Windows.
function isPortServing(port) {
  const tryHost = (host) =>
    new Promise((res) => {
      const sock = net.connect({ port, host });
      const done = (v) => {
        sock.destroy();
        res(v);
      };
      sock.setTimeout(400);
      sock.once("connect", () => done(true));
      sock.once("timeout", () => done(false));
      sock.once("error", () => done(false));
    });
  return Promise.all([tryHost("127.0.0.1"), tryHost("::1")]).then((r) => r.some(Boolean));
}

async function allocPort(reg, name) {
  if (reg[name]?.port) return reg[name].port; // stable port per feature
  const taken = new Set(Object.values(reg).map((e) => e.port));
  for (let p = PORT_MIN; p <= PORT_MAX; p++) {
    if (taken.has(p)) continue;
    // not in the registry and nothing already serving on it (either IP family)
    if (!(await isPortServing(p))) return p;
  }
  throw new Error(`No free port in ${PORT_MIN}-${PORT_MAX}; remove an old worktree first.`);
}

// Registry-free: first port in range with nothing serving on it. Used by `serve`, which
// runs from any checkout (incl. an agent's own worktree) where the root registry can't
// coordinate ports - the live probe avoids collisions across independent checkouts.
async function findFreePort() {
  for (let p = PORT_MIN; p <= PORT_MAX; p++) {
    if (!(await isPortServing(p))) return p;
  }
  return null;
}

function storeDrive() {
  try {
    const p = execSync("pnpm store path", { cwd: root, encoding: "utf8" }).trim();
    return parsePath(p).root.toUpperCase();
  } catch {
    return parsePath(root).root.toUpperCase();
  }
}

// Robust frontend-dev invocation: run vite directly from the frontend package dir via
// `pnpm exec`, which passes args straight to vite. Avoids `pnpm <script> -- <args>`, whose
// `--` was observed leaking through to vite (so --port was ignored and Vite drifted ports).
function frontendDir(checkout) {
  return resolve(checkout, "packages", "frontend");
}
function viteCmd(port) {
  return `pnpm exec vite --port ${port} --strictPort`;
}

// ---------- commands ----------

async function cmdNew(name, opts) {
  if (!name) {
    console.error("Usage: node scripts/worktree.mjs new <name> [--base <branch>] [--start]");
    process.exit(1);
  }

  assertSafeName(name);
  const reg = loadRegistry();
  const known = worktreePaths();
  // Reuse the registry's path only if it's still a live worktree; otherwise (stale entry
  // after a move/manual delete) fall back to the default location.
  const regPath = reg[name]?.path ? resolve(reg[name].path) : null;
  const wtPath = regPath && known.has(regPath) ? regPath : resolve(WORKTREE_PARENT, name);

  if (process.platform === "win32") {
    const wtDrive = parsePath(wtPath).root.toUpperCase();
    const sd = storeDrive();
    if (wtDrive !== sd) {
      console.warn(
        `⚠ Worktree drive ${wtDrive} != pnpm store drive ${sd}: install will COPY ` +
          `(slow, more disk) instead of hardlink. Put worktrees on the store's drive.`
      );
    }
  }

  if (!existsSync(wtPath)) {
    const base = opts.base || DEFAULT_BASE;
    if (branchExists(name)) {
      step(`git worktree add (existing branch ${name})`, `git worktree add "${wtPath}" "${name}"`, root);
    } else {
      step(
        `git worktree add -b ${name} (from ${base})`,
        `git worktree add "${wtPath}" -b "${name}" "${base}"`,
        root
      );
    }
  } else if (known.has(wtPath)) {
    console.log(`→ Worktree already exists, reusing: ${wtPath}`);
  } else {
    console.error(
      `✗ ${wtPath} exists but is not a git worktree (leftover/foreign dir).\n` +
        `  Run \`node scripts/worktree.mjs rm ${name}\` or delete it, then retry.`
    );
    process.exit(1);
  }

  try {
    step("pnpm install --frozen-lockfile", "pnpm install --frozen-lockfile", wtPath);
  } catch {
    console.warn("⚠ frozen install failed - branch may add new deps. Retrying with a normal install…");
    step("pnpm install", "pnpm install", wtPath);
  }

  // Re-read the registry right before writing so a concurrent `new` (e.g. another agent)
  // that finished during this install isn't clobbered; `--strictPort` below makes any
  // residual port collision fail loudly rather than silently.
  const latest = loadRegistry();
  const port = await allocPort(latest, name);
  latest[name] = { port, path: wtPath };
  saveRegistry(latest);

  const feDir = frontendDir(wtPath);
  const cmd = viteCmd(port);
  console.log(`\n✓ Worktree ready: ${name}`);
  console.log(`  path:   ${wtPath}`);
  console.log(`  branch: ${name}`);
  console.log(`  review: http://localhost:${port}  (proxies /api → http://localhost:${BACKEND_PORT})`);
  console.log(`\n  Make sure the backend is up in the main checkout (\`pnpm dev\`), then:`);
  console.log(`    cd "${feDir}"`);
  console.log(`    ${cmd}`);

  if (opts.start) {
    console.log(`\n→ Starting frontend (Ctrl-C to stop)…\n`);
    const r = spawnSync(cmd, { cwd: feDir, stdio: "inherit", shell: true });
    process.exit(r.status ?? (r.signal ? 1 : 0));
  }
}

async function cmdList() {
  const reg = loadRegistry();
  const byPath = {};
  for (const [name, e] of Object.entries(reg)) byPath[resolve(e.path)] = { name, port: e.port };

  const entries = [];
  let cur = null;
  for (const line of git("worktree list --porcelain").split("\n")) {
    if (line.startsWith("worktree ")) {
      if (cur) entries.push(cur);
      cur = { path: line.slice("worktree ".length).trim() };
    } else if (cur && line.startsWith("branch ")) {
      cur.branch = line.slice("branch ".length).trim().replace("refs/heads/", "");
    } else if (cur && line === "detached") {
      cur.branch = "(detached)";
    }
  }
  if (cur) entries.push(cur);

  // Probe all ports concurrently so `list` stays fast with many worktrees.
  const rows = await Promise.all(
    entries.map(async (e) => {
      const port = byPath[resolve(e.path)]?.port;
      const portStr = port ? `:${port}` : "(backend/main)";
      const status = port ? ((await isPortServing(port)) ? "● serving" : "○ stopped") : "";
      return `  ${(e.branch || "?").padEnd(24)} ${portStr.padEnd(16)} ${status.padEnd(11)} ${e.path}`;
    })
  );

  console.log("\n  branch                   port             status      path");
  console.log("  " + "-".repeat(78));
  console.log(rows.join("\n"));
  console.log("");
}

function cmdRm(name, opts) {
  if (!name) {
    console.error("Usage: node scripts/worktree.mjs rm <name> [--force]");
    process.exit(1);
  }
  assertSafeName(name);
  const reg = loadRegistry();
  const wtPath = reg[name]?.path ? resolve(reg[name].path) : resolve(WORKTREE_PARENT, name);
  try {
    step(`git worktree remove ${name}`, `git worktree remove${opts.force ? " --force" : ""} "${wtPath}"`, root);
  } catch {
    if (!opts.force) {
      console.error("✗ git worktree remove failed. If the worktree is dirty, re-run with --force.");
      process.exit(1);
    }
    // --force was given: fall through and force the cleanup below regardless.
    console.warn("⚠ git worktree remove failed; forcing directory cleanup…");
  }
  // git worktree remove can leave the physical dir on Windows (open handles / node_modules);
  // clean it up and prune any stale admin entry so the path can be reused. Runs even when
  // the git remove failed under --force, so `rm --force` never leaves a half-removed state.
  try {
    forceRemoveDir(wtPath);
  } catch {
    console.warn(`⚠ Could not fully delete ${wtPath} - remove it manually if it lingers.`);
  }
  try {
    sh("git worktree prune", root);
  } catch {}
  if (reg[name]) {
    delete reg[name];
    saveRegistry(reg);
    console.log(`✓ Freed port from registry. (Branch "${name}" still exists - delete/merge it separately.)`);
  }
}

// Run the frontend for review from the CURRENT checkout (this worktree), against the
// shared backend on :8787. Creates no worktree and touches no registry - meant to be the
// one-liner an isolated agent (e.g. an agent-view session in its own .claude/worktrees/
// checkout) runs to expose a reviewable port. Auto-picks a free port unless --port is given.
async function cmdServe(opts) {
  let port = opts.port;
  if (port != null) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      console.error(`✗ Invalid --port ${opts.port}. Use an integer 1-65535.`);
      process.exit(1);
    }
  } else {
    port = await findFreePort();
    if (!port) {
      console.error(`✗ No free port in ${PORT_MIN}-${PORT_MAX}. Pass --port <n> to override.`);
      process.exit(1);
    }
  }

  // Self-contained: a fresh agent worktree may not have deps yet. Install if missing
  // (hardlinked from the warm store when on the same drive).
  if (!existsSync(resolve(root, "node_modules"))) {
    try {
      step("pnpm install --frozen-lockfile", "pnpm install --frozen-lockfile", root);
    } catch {
      console.warn("⚠ frozen install failed - retrying with a normal install…");
      step("pnpm install", "pnpm install", root);
    }
  }

  const cmd = viteCmd(port);
  console.log(`\n✓ Serving frontend for review`);
  console.log(`  checkout: ${root}`);
  console.log(`  review:   http://localhost:${port}  (proxies /api → http://localhost:${BACKEND_PORT})`);
  console.log(`  note:     needs the shared backend up (\`pnpm dev\` in the main checkout) for /api calls.`);
  console.log(`\n→ Starting (Ctrl-C to stop)…\n`);
  const r = spawnSync(cmd, { cwd: frontendDir(root), stdio: "inherit", shell: true });
  process.exit(r.status ?? (r.signal ? 1 : 0));
}

function usage() {
  console.log(
    `Annex worktree helper - parallel frontend dev servers against the shared backend on :${BACKEND_PORT}\n` +
      `\nUsage:\n` +
      `  node scripts/worktree.mjs new <name> [--base <branch>] [--start]\n` +
      `  node scripts/worktree.mjs serve [--port <n>]\n` +
      `  node scripts/worktree.mjs list\n` +
      `  node scripts/worktree.mjs rm <name> [--force]\n` +
      `\n  new   Create a worktree on the repo's drive, install (hardlinked from the warm\n` +
      `        pnpm store), assign a stable frontend port, and print/run the dev command.\n` +
      `  serve Run the frontend from the CURRENT checkout on a free (or --port) port - no\n` +
      `        worktree created. The one-liner for an isolated agent to expose a review port.\n` +
      `  list  Show worktrees, assigned ports, and whether each port is serving.\n` +
      `  rm    Remove a worktree and free its port (--force for a dirty worktree).\n` +
      `\n  Run exactly ONE backend (the main checkout's \`pnpm dev\`); every worktree\n` +
      `  frontend proxies /api → :${BACKEND_PORT} and shares the one dev DB.`
  );
}

// ---------- entry ----------

const [, , sub, ...rest] = process.argv;
const opts = { base: undefined, start: false, force: false, port: undefined };
const positional = [];
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (a === "--base") opts.base = rest[++i];
  else if (a === "--start") opts.start = true;
  else if (a === "--force") opts.force = true;
  else if (a === "--port") opts.port = Number(rest[++i]);
  else positional.push(a);
}

switch (sub) {
  case "new":
    await cmdNew(positional[0], opts);
    break;
  case "serve":
    await cmdServe(opts);
    break;
  case "list":
  case "ls":
    await cmdList();
    break;
  case "rm":
  case "remove":
    cmdRm(positional[0], opts);
    break;
  default:
    usage();
    process.exit(sub ? 1 : 0);
}
