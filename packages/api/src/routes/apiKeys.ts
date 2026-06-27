import { okResponse, errorResponse, Errors, ROLE_RANK, type Session } from "../lib";
import type { Env } from "../index";
import { resolveAccess } from "../lib/access";
import { generateApiKeySecret, hashApiKey, keyDisplayPrefix, type ApiKeyScope } from "../lib/apiKeys";

// JWT-authenticated management of a user's OWN scoped API keys, under a site
// they belong to (the settings UI). A key is owned by its creator and bound to
// exactly one site; because the /v1 surface re-checks the owner's live role on
// every request, a key is only ever a CEILING and grants no access the owner
// doesn't already have - so any accepted member may mint one. Listing and
// revocation are restricted to the caller's own keys, so one member can never
// see or revoke another's. (Removing a member from the site separately neuters
// their keys, since /v1 requires live membership.)

const VALID_SCOPES: ApiKeyScope[] = ["read", "readwrite"];
// Bound the per-(user, site) key count so the surface can't be flooded.
const MAX_KEYS_PER_USER_SITE = 20;

interface ApiKeyMetaRow {
  id: string;
  name: string;
  key_prefix: string;
  scope: ApiKeyScope;
  can_invite: number;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
}

function serializeKey(r: ApiKeyMetaRow) {
  return {
    id: r.id,
    name: r.name,
    keyPrefix: r.key_prefix,
    scope: r.scope,
    canInvite: r.can_invite === 1,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    expiresAt: r.expires_at,
  };
}

export async function handleApiKeys(request: Request, env: Env, user: Session, url: URL): Promise<Response> {
  const match = url.pathname.match(/^\/projects\/([^/]+)\/api-keys\/?([^/]*)$/);
  if (!match) return errorResponse(Errors.NOT_FOUND);
  const projectId = match[1];
  const keyId = match[2] || null;

  // Caller must be an accepted member of the site to manage keys for it. 404
  // (not 403) matches how the rest of the API hides sites you're not in.
  const membership = await resolveAccess(env.DB, projectId, user.userId);
  if (!membership) return errorResponse(Errors.NOT_FOUND);

  // GET /projects/:id/api-keys - list the caller's OWN active keys for this site.
  if (!keyId && request.method === "GET") {
    const rows = await env.DB.prepare(
      `SELECT id, name, key_prefix, scope, can_invite, created_at, last_used_at, expires_at
       FROM api_keys
       WHERE project_id = ? AND user_id = ? AND revoked_at IS NULL
       ORDER BY created_at DESC`,
    ).bind(projectId, user.userId).all<ApiKeyMetaRow>();
    return okResponse(rows.results.map(serializeKey));
  }

  // POST /projects/:id/api-keys - mint a key. The full secret is returned ONCE.
  if (!keyId && request.method === "POST") {
    const body = await request.json<{ name?: unknown; scope?: unknown; canInvite?: unknown; expiresAt?: unknown }>().catch(() => null);
    if (!body) return errorResponse(Errors.BAD_REQUEST);

    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 100) return errorResponse(Errors.BAD_REQUEST);

    const scope = body.scope;
    if (typeof scope !== "string" || !VALID_SCOPES.includes(scope as ApiKeyScope)) return errorResponse(Errors.BAD_REQUEST);

    const canInvite = body.canInvite === true;
    // Member-management keys may only be minted by users who can actually manage
    // members (admin+). Non-admins never see the toggle in the UI; this enforces
    // it server-side too, so the raw API can't mint a misleadingly invite-flagged
    // key. (The /v1 surface independently re-checks live admin on every invite,
    // so this is defence in depth, not the only gate.)
    if (canInvite && ROLE_RANK[membership.role] < ROLE_RANK["admin"]) {
      return errorResponse(Errors.FORBIDDEN);
    }

    let expiresAt: string | null = null;
    if (body.expiresAt != null) {
      if (typeof body.expiresAt !== "string") return errorResponse(Errors.BAD_REQUEST);
      const t = Date.parse(body.expiresAt);
      if (Number.isNaN(t) || t <= Date.now()) return errorResponse(Errors.BAD_REQUEST);
      expiresAt = new Date(t).toISOString();
    }

    const countRow = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM api_keys WHERE project_id = ? AND user_id = ? AND revoked_at IS NULL",
    ).bind(projectId, user.userId).first<{ n: number }>();
    if (countRow && countRow.n >= MAX_KEYS_PER_USER_SITE) return errorResponse(Errors.CONFLICT);

    const secret = generateApiKeySecret();
    const prefix = keyDisplayPrefix(secret);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO api_keys (id, user_id, project_id, name, key_hash, key_prefix, scope, can_invite, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, user.userId, projectId, name, await hashApiKey(secret), prefix, scope, canInvite ? 1 : 0, now, expiresAt).run();

    return okResponse({
      id,
      name,
      keyPrefix: prefix,
      scope,
      canInvite,
      createdAt: now,
      lastUsedAt: null,
      expiresAt,
      // The plaintext secret. Shown exactly once - never stored or retrievable again.
      secret,
    }, 201);
  }

  // DELETE /projects/:id/api-keys/:keyId - revoke one of the caller's OWN keys.
  if (keyId && request.method === "DELETE") {
    const res = await env.DB.prepare(
      "UPDATE api_keys SET revoked_at = ? WHERE id = ? AND project_id = ? AND user_id = ? AND revoked_at IS NULL",
    ).bind(new Date().toISOString(), keyId, projectId, user.userId).run();
    if (!res.meta.changes) return errorResponse(Errors.NOT_FOUND);
    return okResponse({ revoked: true });
  }

  return errorResponse(Errors.NOT_FOUND);
}
