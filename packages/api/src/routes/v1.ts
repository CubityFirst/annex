import { okResponse, errorResponse, Errors, ROLE_RANK, folderInProject, type Role } from "../lib";
import type { Env } from "../index";
import {
  authenticateApiKey,
  scopeAllowsWrite,
  apiKeyInviteRoleAllowed,
  apiKeyRemoveAllowed,
  ASSIGNABLE_ROLES,
  type ApiKeyAuth,
} from "../lib/apiKeys";
import { createDoc, applyDocUpdate, deleteDoc, type DocUpdateRow, type DocUpdatePatch } from "../lib/docOps";
import { parseFrontmatter } from "../lib/frontmatter";

// ── Public, API-key-authenticated surface (/v1) ─────────────────────────────
//
// This router is the ONLY acceptor of scoped API keys (see lib/apiKeys.ts).
// Keys are never routed through the shared JWT authenticate(), so they can only
// ever act here, on the single site they are bound to.
//
// Authorization is layered, and EVERY layer must pass:
//   1. Killswitch  — the Flagship "api" flag can disable the whole surface.
//   2. Key         — valid, unrevoked, unexpired key resolves to its owner +
//                    site + scope (read|readwrite) + canInvite.
//   3. Scope ceiling — read keys can never mutate; member ops need canInvite.
//   4. Live role floor — the owner's CURRENT project_members role is re-checked
//                    on every request. The key is only a ceiling: it can never
//                    grant more than its owner currently has, and removing the
//                    owner from the site instantly neuters the key.

interface CallerInfo {
  role: Role;
  name: string;
}

// The owner's live membership on the key's site (accepted members only — a
// pending invite grants nothing). This is the authorization floor.
async function liveCaller(env: Env, projectId: string, userId: string): Promise<CallerInfo | null> {
  const row = await env.DB.prepare(
    "SELECT role, name FROM project_members WHERE project_id = ? AND user_id = ? AND accepted = 1",
  ).bind(projectId, userId).first<{ role: Role; name: string }>();
  return row ? { role: row.role, name: row.name } : null;
}

async function readJson<T>(request: Request): Promise<T | null> {
  try {
    return await request.json<T>();
  } catch {
    return null;
  }
}

interface DocRowForApi {
  id: string;
  title: string;
  folder_id: string | null;
  published_at: string | null;
  tags: string | null;
  created_at: string;
  updated_at: string;
}

function serializeDocSummary(r: DocRowForApi) {
  return {
    id: r.id,
    title: r.title,
    folderId: r.folder_id,
    publishedAt: r.published_at,
    tags: r.tags ? safeParseTags(r.tags) : [],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function safeParseTags(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

export async function handlePublicApi(request: Request, env: Env, url: URL): Promise<Response> {
  // 1. Killswitch. Checked before any auth/DB work so a kill takes effect with
  // zero load. Defaults to enabled when the flag/binding is unavailable (local
  // dev or a flag-service outage) — this is a deliberate-off switch, not
  // fail-closed.
  const apiEnabled = env.FLAGS ? await env.FLAGS.getBooleanValue("api", true) : true;
  if (!apiEnabled) {
    return Response.json({ ok: false, error: "api_disabled", status: 503 }, { status: 503 });
  }

  // 2. Key auth. Any failure (missing/garbage token, JWT, unknown/revoked/
  // expired key) collapses to a single opaque 401 that leaks no key state.
  const authHeader = request.headers.get("Authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const auth = token ? await authenticateApiKey(token, env) : null;
  if (!auth) return errorResponse(Errors.UNAUTHORIZED);

  // Per-key rate limit across the entire /v1 surface.
  if (env.RATE_LIMITER_API) {
    const { success } = await env.RATE_LIMITER_API.limit({ key: `apikey:${auth.keyId}` });
    if (!success) return errorResponse(Errors.RATE_LIMITED);
  }

  // The site is ALWAYS taken from the key (auth.projectId), never from the URL,
  // so a key can never be aimed at a different site.
  const parts = url.pathname.replace(/^\/v1\/?/, "").split("/").filter(Boolean);

  if (parts[0] === "docs") return handleV1Docs(request, env, auth, parts.slice(1));
  if (parts[0] === "members") return handleV1Members(request, env, auth, parts.slice(1));
  return errorResponse(Errors.NOT_FOUND);
}

async function handleV1Docs(request: Request, env: Env, auth: ApiKeyAuth, rest: string[]): Promise<Response> {
  const docId = rest[0] ?? null;
  // No sub-resources are exposed on the public API (revisions, collab, etc.).
  if (rest.length > 1) return errorResponse(Errors.NOT_FOUND);

  const caller = await liveCaller(env, auth.projectId, auth.userId);
  if (caller === null) return errorResponse(Errors.FORBIDDEN);

  // ── Collection ──
  if (!docId) {
    if (request.method === "GET") {
      const lv = caller.role === "limited";
      const sql =
        `SELECT d.id, d.title, d.folder_id, d.published_at, d.tags, d.created_at, d.updated_at
         FROM docs d
         ${lv ? "JOIN doc_shares ds ON ds.doc_id = d.id AND ds.user_id = ?" : ""}
         WHERE d.project_id = ?
         ORDER BY d.created_at DESC`;
      const rows = lv
        ? await env.DB.prepare(sql).bind(auth.userId, auth.projectId).all<DocRowForApi>()
        : await env.DB.prepare(sql).bind(auth.projectId).all<DocRowForApi>();
      return okResponse(rows.results.map(serializeDocSummary));
    }

    if (request.method === "POST") {
      if (!scopeAllowsWrite(auth.scope)) return errorResponse(Errors.FORBIDDEN);
      if (ROLE_RANK[caller.role] < ROLE_RANK["editor"]) return errorResponse(Errors.FORBIDDEN);
      const body = await readJson<{ title?: unknown; content?: unknown; folderId?: unknown }>(request);
      if (!body || typeof body.title !== "string" || !body.title.trim()) return errorResponse(Errors.BAD_REQUEST);
      if (body.content !== undefined && typeof body.content !== "string") return errorResponse(Errors.BAD_REQUEST);
      const folderId = body.folderId == null ? null : String(body.folderId);
      if (!(await folderInProject(env.DB, folderId, auth.projectId, "docs"))) return errorResponse(Errors.BAD_REQUEST);

      const created = await createDoc(env, {
        projectId: auth.projectId,
        authorId: auth.userId,
        title: body.title,
        content: typeof body.content === "string" ? body.content : "",
        folderId,
      });
      return okResponse(
        serializeDocSummary({
          id: created.id,
          title: created.title,
          folder_id: created.folderId,
          published_at: created.publishedAt,
          // Tags are derived from the body's frontmatter at create time.
          tags: JSON.stringify(parseFrontmatter(created.content).tags ?? []),
          created_at: created.createdAt,
          updated_at: created.updatedAt,
        }),
        201,
      );
    }

    return errorResponse(Errors.NOT_FOUND);
  }

  // ── Item ── The doc MUST belong to the key's site; this single guard makes
  // cross-site read/write/delete impossible regardless of how the id was
  // discovered.
  const doc = await env.DB.prepare("SELECT * FROM docs WHERE id = ? AND project_id = ?")
    .bind(docId, auth.projectId).first<DocUpdateRow & DocRowForApi>();
  if (!doc) return errorResponse(Errors.NOT_FOUND);

  if (request.method === "GET") {
    // limited owners only see docs explicitly shared with them (mirrors the app).
    if (caller.role === "limited") {
      const share = await env.DB.prepare("SELECT id FROM doc_shares WHERE doc_id = ? AND user_id = ?")
        .bind(docId, auth.userId).first();
      if (!share) return errorResponse(Errors.FORBIDDEN);
    }
    const r2 = await env.ASSETS.get(`${auth.projectId}/${docId}`);
    const content = r2 ? await r2.text() : "";
    return okResponse({ ...serializeDocSummary(doc), content });
  }

  if (request.method === "PATCH") {
    if (!scopeAllowsWrite(auth.scope)) return errorResponse(Errors.FORBIDDEN);
    if (ROLE_RANK[caller.role] < ROLE_RANK["editor"]) return errorResponse(Errors.FORBIDDEN);

    const body = await readJson<{ title?: unknown; content?: unknown; folderId?: unknown; published?: unknown }>(request);
    if (!body) return errorResponse(Errors.BAD_REQUEST);

    const patch: DocUpdatePatch = {};
    if (body.title !== undefined) {
      if (typeof body.title !== "string" || !body.title.trim()) return errorResponse(Errors.BAD_REQUEST);
      patch.title = body.title;
    }
    if (body.content !== undefined) {
      if (typeof body.content !== "string") return errorResponse(Errors.BAD_REQUEST);
      patch.content = body.content;
    }
    if (body.folderId !== undefined) {
      const folderId = body.folderId == null ? null : String(body.folderId);
      if (!(await folderInProject(env.DB, folderId, auth.projectId, "docs"))) return errorResponse(Errors.BAD_REQUEST);
      patch.folderId = folderId;
    }
    if (body.published !== undefined) {
      if (typeof body.published !== "boolean") return errorResponse(Errors.BAD_REQUEST);
      // Keep an existing publish timestamp when re-publishing; stamp now on first
      // publish; clear on unpublish.
      patch.publishedAt = body.published ? (doc.published_at ?? new Date().toISOString()) : null;
    }

    const { updated, savedContent } = await applyDocUpdate(env, doc, auth.userId, caller.name, patch);
    const summary = {
      id: updated.id,
      title: updated.title,
      folderId: updated.folder_id,
      publishedAt: updated.published_at,
      // Tags live in the body's frontmatter, so they only change when content does.
      tags: patch.content !== undefined
        ? (parseFrontmatter(patch.content).tags ?? [])
        : (doc.tags ? safeParseTags(doc.tags) : []),
      createdAt: updated.created_at,
      updatedAt: updated.updated_at,
    };
    return okResponse(savedContent !== undefined ? { ...summary, content: savedContent } : summary);
  }

  if (request.method === "DELETE") {
    if (!scopeAllowsWrite(auth.scope)) return errorResponse(Errors.FORBIDDEN);
    if (ROLE_RANK[caller.role] < ROLE_RANK["editor"]) return errorResponse(Errors.FORBIDDEN);
    const proj = await env.DB.prepare("SELECT home_doc_id FROM projects WHERE id = ?")
      .bind(auth.projectId).first<{ home_doc_id: string | null }>();
    if (proj?.home_doc_id === docId) return errorResponse(Errors.FORBIDDEN);
    await deleteDoc(env, docId, auth.projectId);
    return okResponse({ deleted: true });
  }

  return errorResponse(Errors.NOT_FOUND);
}

async function handleV1Members(request: Request, env: Env, auth: ApiKeyAuth, rest: string[]): Promise<Response> {
  const targetUserId = rest[0] ?? null;
  if (rest.length > 1) return errorResponse(Errors.NOT_FOUND);

  // Member management is the "invite" capability: it requires the key's
  // can_invite flag AND the owner being admin+ on the site right now. Either
  // missing → 403. (A key without can_invite cannot even see the member list.)
  const caller = await liveCaller(env, auth.projectId, auth.userId);
  if (caller === null) return errorResponse(Errors.FORBIDDEN);
  if (!auth.canInvite) return errorResponse(Errors.FORBIDDEN);
  if (ROLE_RANK[caller.role] < ROLE_RANK["admin"]) return errorResponse(Errors.FORBIDDEN);

  // GET /v1/members — list members + pending invites
  if (!targetUserId && request.method === "GET") {
    const rows = await env.DB.prepare(
      "SELECT user_id, email, name, role, accepted, created_at FROM project_members WHERE project_id = ? ORDER BY created_at ASC",
    ).bind(auth.projectId).all<{ user_id: string; email: string; name: string; role: Role; accepted: number; created_at: string }>();
    return okResponse(rows.results.map(r => ({
      userId: r.user_id,
      email: r.email,
      name: r.name,
      role: r.role,
      accepted: r.accepted === 1,
      createdAt: r.created_at,
    })));
  }

  // POST /v1/members — invite a user by email
  if (!targetUserId && request.method === "POST") {
    const body = await readJson<{ email?: unknown; role?: unknown }>(request);
    if (!body || typeof body.email !== "string" || typeof body.role !== "string") return errorResponse(Errors.BAD_REQUEST);
    if (!ASSIGNABLE_ROLES.includes(body.role as Role)) return errorResponse(Errors.BAD_REQUEST);
    // Caller must be allowed to assign this role (admin+, never above own role).
    if (!apiKeyInviteRoleAllowed(caller.role, body.role as Role)) return errorResponse(Errors.FORBIDDEN);

    // Per-owner rate limit on the email→user lookup (reuse the members limiter),
    // so a leaked key can't be used to scrape the email→user map.
    if (env.RATE_LIMITER_INVITE_LOOKUP) {
      const { success } = await env.RATE_LIMITER_INVITE_LOOKUP.limit({ key: auth.userId });
      if (!success) return errorResponse(Errors.RATE_LIMITED);
    }

    const lookupRes = await env.AUTH.fetch("https://auth/lookup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: body.email }),
    });
    if (!lookupRes.ok) {
      if (lookupRes.status === 404) {
        return Response.json({ ok: false, error: "No user found with that email address.", status: 404 }, { status: 404 });
      }
      return errorResponse(Errors.INTERNAL);
    }
    const lookupData = await lookupRes.json<{ ok: boolean; data?: { userId: string; email: string; name: string } }>();
    if (!lookupData.ok || !lookupData.data) return errorResponse(Errors.INTERNAL);
    const { userId: inviteeId, email: inviteeEmail, name: inviteeName } = lookupData.data;

    const existing = await env.DB.prepare("SELECT id FROM project_members WHERE project_id = ? AND user_id = ?")
      .bind(auth.projectId, inviteeId).first();
    if (existing) return errorResponse(Errors.CONFLICT);

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO project_members (id, project_id, user_id, email, name, role, invited_by, created_at, accepted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)",
    ).bind(id, auth.projectId, inviteeId, inviteeEmail, inviteeName, body.role, auth.userId, now).run();

    return okResponse({
      userId: inviteeId,
      email: inviteeEmail,
      name: inviteeName,
      role: body.role,
      accepted: false,
      invitedBy: auth.userId,
      createdAt: now,
    }, 201);
  }

  // DELETE /v1/members/:userId — revoke a pending invite or remove a member
  if (targetUserId && request.method === "DELETE") {
    const row = await env.DB.prepare("SELECT role FROM project_members WHERE project_id = ? AND user_id = ?")
      .bind(auth.projectId, targetUserId).first<{ role: Role }>();
    if (!row) return errorResponse(Errors.NOT_FOUND);
    if (!apiKeyRemoveAllowed(caller.role, row.role)) return errorResponse(Errors.FORBIDDEN);
    await env.DB.prepare("DELETE FROM project_members WHERE project_id = ? AND user_id = ?")
      .bind(auth.projectId, targetUserId).run();
    return okResponse({ deleted: true });
  }

  return errorResponse(Errors.NOT_FOUND);
}
