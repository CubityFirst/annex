import { ROLE_RANK, type Role } from "../lib";
import type { Env } from "../index";

// ── Scoped API keys for the public /v1 API ──────────────────────────────────
//
// A key is a Bearer credential, but it is DELIBERATELY never routed through the
// shared JWT authenticate(). authenticateApiKey() below is the only acceptor,
// and it is wired in exclusively for the /v1 surface (see routes/v1.ts). A key
// sent to any other (JWT-only) route fails JWT parsing and yields 401 - it can
// never reach /me, /projects, /docs, etc., so its site/scope ceiling cannot be
// bypassed by aiming it at a broader handler.

export const API_KEY_PREFIX = "annx_";

export type ApiKeyScope = "read" | "readwrite";

// Roles a key may assign when inviting. Owner is never assignable via the API.
export const ASSIGNABLE_ROLES: Role[] = ["limited", "viewer", "editor", "admin"];

export interface ApiKeyAuth {
  keyId: string;
  userId: string;   // the owning user - all live permission checks run as them
  projectId: string; // the single site this key is bound to
  scope: ApiKeyScope;
  canInvite: boolean;
}

// A token is an API key (vs a JWT) iff it carries our prefix. JWTs are exactly
// three dot-separated base64url segments and never contain this prefix, so the
// two credential types are unambiguous.
export function isApiKeyToken(token: string): boolean {
  return token.startsWith(API_KEY_PREFIX);
}

// 32 bytes (~256 bits) of CSPRNG entropy, base64url-encoded, behind the prefix.
// Guess-/collision-proof; the prefix makes leaked keys greppable in logs/repos.
export function generateApiKeySecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const b64 = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  return API_KEY_PREFIX + b64;
}

// Display label: the literal prefix + first 6 chars of the random part
// (e.g. "annx_AbC123"). Lets the settings UI tell keys apart without ever
// storing or re-revealing the full secret.
export function keyDisplayPrefix(secret: string): string {
  return secret.slice(0, API_KEY_PREFIX.length + 6);
}

// SHA-256 hex of the secret. The secret itself is never stored. A single fast
// hash is correct here (not a slow KDF): keys are high-entropy, so there is
// nothing to brute-force, and every authenticated API request would otherwise
// pay the KDF cost. Lookup is by exact hash match against a UNIQUE index, so
// the raw secret never participates in a timing-sensitive comparison.
export async function hashApiKey(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

// True when this scope permits document mutations (create / edit / move /
// delete). Read keys are strictly read-only regardless of the owner's role.
export function scopeAllowsWrite(scope: ApiKeyScope): boolean {
  return scope === "readwrite";
}

// Pure authorization rule for inviting/assigning a role via an API key.
// Hardens the members.ts admin gate for the programmatic surface: the caller
// must be admin+, the target role must be assignable (never owner), and the
// caller can never assign a role above their own - so a leaked key cannot be
// used to escalate privilege beyond what its owner already holds.
export function apiKeyInviteRoleAllowed(callerRole: Role, targetRole: Role): boolean {
  if (ROLE_RANK[callerRole] < ROLE_RANK["admin"]) return false;
  if (!ASSIGNABLE_ROLES.includes(targetRole)) return false;
  if (ROLE_RANK[targetRole] > ROLE_RANK[callerRole]) return false;
  return true;
}

// Pure authorization rule for removing a member / revoking an invite via an API
// key. Mirrors members.ts: caller must be admin+, owner can never be removed,
// and an admin cannot remove another admin (only an owner can).
export function apiKeyRemoveAllowed(callerRole: Role, targetRole: Role): boolean {
  if (ROLE_RANK[callerRole] < ROLE_RANK["admin"]) return false;
  if (targetRole === "owner") return false;
  if (callerRole === "admin" && ROLE_RANK[targetRole] >= ROLE_RANK["admin"]) return false;
  return true;
}

interface ApiKeyRow {
  id: string;
  user_id: string;
  project_id: string;
  scope: ApiKeyScope;
  can_invite: number;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
}

// How stale last_used_at may get before a refresh write. Matches the sessions
// throttle so heavy key usage doesn't turn every call into a DB write.
const LAST_USED_REFRESH_MS = 10 * 60 * 1000;

// Resolves a Bearer API key to its scope, or null if the token is not a
// well-formed, existing, unrevoked, unexpired key. Always returns null on any
// failure (never distinguishes "no such key" from "revoked"/"expired") so the
// 401 it maps to leaks nothing about key existence or state.
export async function authenticateApiKey(token: string, env: Env): Promise<ApiKeyAuth | null> {
  if (!isApiKeyToken(token)) return null;

  const keyHash = await hashApiKey(token);
  const row = await env.DB.prepare(
    "SELECT id, user_id, project_id, scope, can_invite, last_used_at, expires_at, revoked_at FROM api_keys WHERE key_hash = ?",
  ).bind(keyHash).first<ApiKeyRow>();
  if (!row) return null;
  if (row.revoked_at !== null) return null;

  const nowMs = Date.now();
  if (row.expires_at !== null && Date.parse(row.expires_at) <= nowMs) return null;

  // Lazy "last used" bookkeeping. The API worker's fetch handler has no
  // ExecutionContext, so this is a cheap awaited write (throttled to one per
  // key per ~10 min) rather than a waitUntil. Best-effort: never fail the
  // request over bookkeeping.
  const lastMs = row.last_used_at ? Date.parse(row.last_used_at) : 0;
  if (nowMs - lastMs > LAST_USED_REFRESH_MS) {
    try {
      await env.DB.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?")
        .bind(new Date(nowMs).toISOString(), row.id).run();
    } catch { /* non-fatal */ }
  }

  return {
    keyId: row.id,
    userId: row.user_id,
    projectId: row.project_id,
    scope: row.scope,
    canInvite: row.can_invite === 1,
  };
}
