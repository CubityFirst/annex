import { okResponse, errorResponse, Errors, ROLE_RANK, type Role } from "../lib";
import { authenticate } from "../auth";
import type { Env } from "../index";
import type { Session } from "../lib";
import { resolveRole } from "../lib/access";

const VALID_INVITE_ROLES: Role[] = ["limited", "viewer", "editor", "admin"];

interface InviteLinkRow {
  id: string;
  project_id: string;
  role: Role;
  max_uses: number | null;
  use_count: number;
  expires_at: string | null;
  created_by: string;
  created_at: string;
  is_active: number;
}

function rowToLink(r: InviteLinkRow) {
  return {
    id: r.id,
    projectId: r.project_id,
    role: r.role,
    maxUses: r.max_uses,
    useCount: r.use_count,
    expiresAt: r.expires_at,
    createdBy: r.created_by,
    createdAt: r.created_at,
    isActive: r.is_active === 1,
  };
}

// Handles /projects/:projectId/invite-links[/:linkId] - requires project membership
export async function handleInviteLinks(
  request: Request,
  env: Env,
  user: Session,
  url: URL,
): Promise<Response> {
  const match = url.pathname.match(/^\/projects\/([^/]+)\/invite-links\/?([^/]*)$/);
  if (!match) return errorResponse(Errors.NOT_FOUND);
  const projectId = match[1];
  const linkId = match[2] || null;

  const callerRole = await resolveRole(env.DB, projectId, user.userId);
  if (callerRole === null) return errorResponse(Errors.NOT_FOUND);
  if (ROLE_RANK[callerRole] < ROLE_RANK["admin"]) return errorResponse(Errors.FORBIDDEN);

  // GET /projects/:id/invite-links
  if (!linkId && request.method === "GET") {
    const rows = await env.DB.prepare(
      "SELECT * FROM project_invite_links WHERE project_id = ? ORDER BY created_at DESC",
    ).bind(projectId).all<InviteLinkRow>();
    return okResponse(rows.results.map(rowToLink));
  }

  // POST /projects/:id/invite-links
  if (!linkId && request.method === "POST") {
    const body = await request.json<{ role: Role; maxUses?: number | null; expiresAt?: string | null }>();
    if (!body.role || !VALID_INVITE_ROLES.includes(body.role)) return errorResponse(Errors.BAD_REQUEST);

    // Admins cannot create links that grant admin role
    if (callerRole === "admin" && ROLE_RANK[body.role] >= ROLE_RANK["admin"]) {
      return errorResponse(Errors.FORBIDDEN);
    }

    const maxUses = body.maxUses != null && body.maxUses > 0 ? body.maxUses : null;
    // An unparseable date would compare as "never expires" at accept time.
    if (body.expiresAt != null && (typeof body.expiresAt !== "string" || Number.isNaN(Date.parse(body.expiresAt)))) {
      return errorResponse(Errors.BAD_REQUEST);
    }
    const expiresAt = body.expiresAt != null ? new Date(body.expiresAt).toISOString() : null;

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO project_invite_links (id, project_id, role, max_uses, use_count, expires_at, created_by, created_at, is_active) VALUES (?, ?, ?, ?, 0, ?, ?, ?, 1)",
    ).bind(id, projectId, body.role, maxUses, expiresAt, user.userId, now).run();

    return okResponse({
      id, projectId, role: body.role, maxUses, useCount: 0,
      expiresAt, createdBy: user.userId, createdAt: now, isActive: true,
    }, 201);
  }

  // DELETE /projects/:id/invite-links/:linkId
  if (linkId && request.method === "DELETE") {
    const row = await env.DB.prepare("SELECT id FROM project_invite_links WHERE id = ? AND project_id = ?")
      .bind(linkId, projectId).first();
    if (!row) return errorResponse(Errors.NOT_FOUND);

    await env.DB.prepare("UPDATE project_invite_links SET is_active = 0 WHERE id = ?")
      .bind(linkId).run();

    return okResponse({ revoked: true });
  }

  return errorResponse(Errors.NOT_FOUND);
}

// Handles /invites/:token - GET is public, POST requires auth
export async function handleInvitePublic(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  const match = url.pathname.match(/^\/invites\/([^/]+)(\/accept)?$/);
  if (!match) return errorResponse(Errors.NOT_FOUND);
  const token = match[1];
  const isAccept = match[2] === "/accept";

  // GET /invites/:token - public, returns invite metadata
  if (!isAccept && request.method === "GET") {
    const link = await env.DB.prepare(
      "SELECT pil.*, p.name as project_name FROM project_invite_links pil JOIN projects p ON p.id = pil.project_id WHERE pil.id = ?",
    ).bind(token).first<InviteLinkRow & { project_name: string }>();

    if (!link) return errorResponse(Errors.NOT_FOUND);

    // Get owner name from project_members
    const owner = await env.DB.prepare(
      "SELECT name FROM project_members WHERE project_id = ? AND role = 'owner'",
    ).bind(link.project_id).first<{ name: string }>();

    return okResponse({
      projectId: link.project_id,
      projectName: link.project_name,
      ownerName: owner?.name ?? "Unknown",
      role: link.role,
      maxUses: link.max_uses,
      useCount: link.use_count,
      expiresAt: link.expires_at,
      isActive: link.is_active === 1,
    });
  }

  // POST /invites/:token/accept - requires auth
  if (isAccept && request.method === "POST") {
    const result = await authenticate(request, env);
    if (result === null) return errorResponse(Errors.UNAUTHORIZED);
    if (result instanceof Response) return result;
    const session = result;

    const link = await env.DB.prepare(
      "SELECT * FROM project_invite_links WHERE id = ?",
    ).bind(token).first<InviteLinkRow>();

    if (!link) return errorResponse(Errors.NOT_FOUND);
    if (link.is_active === 0) {
      return Response.json({ ok: false, error: "This invite link has been revoked.", status: 410 }, { status: 410 });
    }
    if (link.expires_at && new Date(link.expires_at) < new Date()) {
      return Response.json({ ok: false, error: "This invite link has expired.", status: 410 }, { status: 410 });
    }
    if (link.max_uses !== null && link.use_count >= link.max_uses) {
      return Response.json({ ok: false, error: "This invite link has reached its maximum uses.", status: 410 }, { status: 410 });
    }

    // Re-validate the creator's CURRENT authority to grant this link's role.
    // Without this, a link created by an admin who is later demoted or removed
    // keeps minting its original role - letting a removed admin re-grant
    // themselves access. Managing invite links requires admin+, and an admin
    // may not grant admin (mirrors the POST creation rule above).
    const creatorRole = await resolveRole(env.DB, link.project_id, link.created_by);
    if (
      creatorRole === null ||
      ROLE_RANK[creatorRole] < ROLE_RANK["admin"] ||
      ROLE_RANK[creatorRole] < ROLE_RANK[link.role] ||
      (creatorRole === "admin" && ROLE_RANK[link.role] >= ROLE_RANK["admin"])
    ) {
      return Response.json({ ok: false, error: "This invite link is no longer valid.", status: 410 }, { status: 410 });
    }

    // Check if already a member (accepted or pending email invite)
    const existing = await env.DB.prepare("SELECT id, role, accepted FROM project_members WHERE project_id = ? AND user_id = ?")
      .bind(link.project_id, session.userId).first<{ id: string; role: Role; accepted: number }>();
    if (existing) {
      if (existing.accepted === 1) {
        return Response.json({ ok: true, data: { projectId: link.project_id, alreadyMember: true, role: existing.role } });
      }
      // Pending email invite - accept it via the link. Keep the role an admin
      // explicitly provisioned for this user; a link must NOT silently raise
      // (or change) it, otherwise a more-permissive link would undo a
      // deliberate lower-privilege invite. The link only flips `accepted`.
      if (!(await claimLinkUse(env, token))) return linkExhausted();
      await env.DB.prepare("UPDATE project_members SET accepted = 1 WHERE id = ?")
        .bind(existing.id).run();
      return okResponse({ projectId: link.project_id, role: existing.role }, 201);
    }

    // Look up user info from auth worker
    const lookupRes = await env.AUTH.fetch("https://auth/lookup-by-id", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: session.userId }),
    });
    if (!lookupRes.ok) return errorResponse(Errors.INTERNAL);
    const lookupData = await lookupRes.json<{ ok: boolean; data?: { name: string; email: string } }>();
    if (!lookupData.ok || !lookupData.data) return errorResponse(Errors.INTERNAL);

    if (!(await claimLinkUse(env, token))) return linkExhausted();
    const memberId = crypto.randomUUID();
    const now = new Date().toISOString();
    try {
      await env.DB.prepare(
        "INSERT INTO project_members (id, project_id, user_id, email, name, role, invited_by, created_at, accepted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)",
      ).bind(memberId, link.project_id, session.userId, lookupData.data.email, lookupData.data.name, link.role, link.created_by, now).run();
    } catch (err) {
      // e.g. UNIQUE(project_id, user_id) when the same user accepts from two
      // tabs at once - give back the use we claimed so it isn't wasted.
      await env.DB.prepare("UPDATE project_invite_links SET use_count = use_count - 1 WHERE id = ? AND use_count > 0")
        .bind(token).run();
      throw err;
    }

    return okResponse({ projectId: link.project_id, role: link.role }, 201);
  }

  return errorResponse(Errors.NOT_FOUND);
}

// Atomically take one use of the link. The max_uses check above is only a
// fast path: parallel accepts can all pass it, so the increment itself must
// be conditional or a capped link could admit more members than allowed.
async function claimLinkUse(env: Env, linkId: string): Promise<boolean> {
  const res = await env.DB.prepare(
    "UPDATE project_invite_links SET use_count = use_count + 1 WHERE id = ? AND is_active = 1 AND (max_uses IS NULL OR use_count < max_uses)",
  ).bind(linkId).run();
  return (res.meta?.changes ?? 0) === 1;
}

function linkExhausted(): Response {
  return Response.json({ ok: false, error: "This invite link has reached its maximum uses.", status: 410 }, { status: 410 });
}
