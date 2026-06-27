import { okResponse, errorResponse, Errors, ROLE_RANK, type Role, type Session } from "../lib";
import type { Env } from "../index";
import { loadMemberPlans } from "./members";

// ── Organizations: a level above sites ──────────────────────────────────────
//
// An org is a collection of sites (projects) with trickle-down roles: an org
// member's role applies to every site in the org (resolved at read time in
// lib/access.ts - NOT materialized here). This module owns org CRUD, org
// membership, the list of sites in an org, and attach/detach. Org roles are
// viewer/editor/admin/owner (never 'limited').
//
// IMPORTANT: org-level gates use getOrgRole (the org's own membership table).
// Site-level effective access still goes through resolveAccess elsewhere. The
// ONE place this module touches project_members directly is attach's site-owner
// check, which MUST be the caller's DIRECT site role - not their effective role
// (an effective-owner via some OTHER org must not be able to move the site).

// Org roles reuse the shared ROLE_RANK ladder (viewer/editor/admin/owner).
const ASSIGNABLE_ORG_ROLES: Role[] = ["viewer", "editor", "admin"];

interface OrgMemberRow {
  id: string; organization_id: string; user_id: string; email: string; name: string;
  role: Role; invited_by: string; created_at: string; accepted: number;
}

// Caller's accepted role in the org (org membership only - no trickle-down).
export async function getOrgRole(db: D1Database, orgId: string, userId: string): Promise<Role | null> {
  const row = await db.prepare(
    "SELECT role FROM organization_members WHERE organization_id = ? AND user_id = ? AND accepted = 1",
  ).bind(orgId, userId).first<{ role: Role }>();
  return row?.role ?? null;
}

// Mirror projects.ts: resolve the caller's display name from the auth worker,
// falling back to their email so a row is always created with *some* name.
async function callerDisplayName(env: Env, request: Request, user: Session): Promise<string> {
  const authHeader = request.headers.get("Authorization");
  const lookupRes = await env.AUTH.fetch("https://auth/lookup-by-id", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(authHeader ? { Authorization: authHeader } : {}) },
    body: JSON.stringify({ userId: user.userId }),
  });
  if (lookupRes.ok) {
    const data = await lookupRes.json<{ ok: boolean; data?: { name: string } }>();
    if (data.ok && data.data) return data.data.name;
  }
  return user.email;
}

export async function handleOrganizations(
  request: Request,
  env: Env,
  user: Session,
  url: URL,
): Promise<Response> {
  const parts = url.pathname.replace(/^\/organizations\/?/, "").split("/").filter(Boolean);
  const orgId = parts[0] ?? null;
  const sub = parts[1] ?? null;          // "members" | "projects"
  const subId = parts[2] ?? null;        // member userId | projectId
  const action = parts[3] ?? null;       // "attach"

  // ── /organizations ────────────────────────────────────────────────────────
  if (!orgId) {
    // GET /organizations - orgs the caller is an accepted member of.
    if (request.method === "GET") {
      const rows = await env.DB.prepare(
        `SELECT o.id, o.name, o.owner_id, o.created_at, om.role,
                (SELECT COUNT(*) FROM projects p WHERE p.organization_id = o.id) AS site_count,
                (SELECT COUNT(*) FROM organization_members m WHERE m.organization_id = o.id AND m.accepted = 1) AS member_count
         FROM organizations o
         INNER JOIN organization_members om ON om.organization_id = o.id
         WHERE om.user_id = ? AND om.accepted = 1
         ORDER BY o.created_at DESC`,
      ).bind(user.userId).all<{ id: string; name: string; owner_id: string; created_at: string; role: Role; site_count: number; member_count: number }>();
      return okResponse(rows.results);
    }

    // POST /organizations - create an org + the creator's owner membership.
    if (request.method === "POST") {
      const body = await request.json<{ name?: string }>().catch(() => ({} as { name?: string }));
      if (!body.name || !body.name.trim()) return errorResponse(Errors.BAD_REQUEST);
      const name = body.name.trim();

      const ownerName = await callerDisplayName(env, request, user);
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      await env.DB.prepare("INSERT INTO organizations (id, name, owner_id, created_at) VALUES (?, ?, ?, ?)")
        .bind(id, name, user.userId, now).run();
      await env.DB.prepare(
        "INSERT INTO organization_members (id, organization_id, user_id, email, name, role, invited_by, created_at, accepted) VALUES (?, ?, ?, ?, ?, 'owner', ?, ?, 1)",
      ).bind(crypto.randomUUID(), id, user.userId, user.email, ownerName, user.userId, now).run();

      return okResponse({ id, name, owner_id: user.userId, created_at: now, role: "owner", site_count: 0, member_count: 1 }, 201);
    }

    return errorResponse(Errors.NOT_FOUND);
  }

  // ── /organizations/:id/projects[...] ──────────────────────────────────────
  if (sub === "projects") {
    // POST/DELETE /organizations/:id/projects/:projectId/attach
    if (subId && action === "attach") {
      return handleAttach(request, env, user, orgId, subId);
    }
    // GET /organizations/:id/projects - sites in the org (any org member).
    if (!subId && request.method === "GET") {
      const orgRole = await getOrgRole(env.DB, orgId, user.userId);
      if (orgRole === null) return errorResponse(Errors.NOT_FOUND);
      const rows = await env.DB.prepare(
        `SELECT p.id, p.name, p.description, p.owner_id, p.created_at, p.published_at,
                p.ai_enabled, p.features, p.logo_square_updated_at,
                (SELECT COUNT(*) FROM docs WHERE project_id = p.id) AS doc_count,
                (SELECT COUNT(*) FROM project_members WHERE project_id = p.id AND accepted = 1) AS member_count
         FROM projects p
         WHERE p.organization_id = ?
         ORDER BY p.created_at DESC`,
      ).bind(orgId).all();
      return okResponse(rows.results);
    }
    return errorResponse(Errors.NOT_FOUND);
  }

  // ── /organizations/:id/members[...] ───────────────────────────────────────
  if (sub === "members") {
    return handleOrgMembers(request, env, user, orgId, subId);
  }

  // ── /organizations/:id ────────────────────────────────────────────────────
  if (!sub) {
    const callerRole = await getOrgRole(env.DB, orgId, user.userId);

    // GET /organizations/:id - detail (any member). 404 hides existence.
    if (request.method === "GET") {
      if (callerRole === null) return errorResponse(Errors.NOT_FOUND);
      const org = await env.DB.prepare("SELECT id, name, owner_id, created_at FROM organizations WHERE id = ?")
        .bind(orgId).first<{ id: string; name: string; owner_id: string; created_at: string }>();
      if (!org) return errorResponse(Errors.NOT_FOUND);
      return okResponse({ ...org, role: callerRole });
    }

    // PATCH /organizations/:id - rename (admin+).
    if (request.method === "PATCH") {
      if (callerRole === null) return errorResponse(Errors.NOT_FOUND);
      if (ROLE_RANK[callerRole] < ROLE_RANK["admin"]) return errorResponse(Errors.FORBIDDEN);
      const body = await request.json<{ name?: string }>().catch(() => ({} as { name?: string }));
      if (body.name === undefined || !body.name.trim()) return errorResponse(Errors.BAD_REQUEST);
      await env.DB.prepare("UPDATE organizations SET name = ? WHERE id = ?").bind(body.name.trim(), orgId).run();
      const updated = await env.DB.prepare("SELECT id, name, owner_id, created_at FROM organizations WHERE id = ?")
        .bind(orgId).first();
      return okResponse(updated);
    }

    // DELETE /organizations/:id - owner only. CASCADE wipes org_members; the
    // projects.organization_id FK is ON DELETE SET NULL, so member sites are
    // DETACHED (they survive), not deleted.
    if (request.method === "DELETE") {
      if (callerRole === null) return errorResponse(Errors.NOT_FOUND);
      if (callerRole !== "owner") return errorResponse(Errors.FORBIDDEN);
      await env.DB.prepare("DELETE FROM organizations WHERE id = ?").bind(orgId).run();
      return okResponse({ deleted: true });
    }

    return errorResponse(Errors.NOT_FOUND);
  }

  return errorResponse(Errors.NOT_FOUND);
}

// POST   /organizations/:id/projects/:projectId/attach - attach an existing site
// DELETE /organizations/:id/projects/:projectId/attach - detach it
async function handleAttach(
  request: Request, env: Env, user: Session, orgId: string, projectId: string,
): Promise<Response> {
  const orgRole = await getOrgRole(env.DB, orgId, user.userId);

  // The caller's DIRECT site role (NOT resolveAccess): attach/detach hinge on
  // genuine ownership of THIS site, not an effective-owner role inherited via
  // some other org.
  const directRole = await env.DB.prepare(
    "SELECT role FROM project_members WHERE project_id = ? AND user_id = ? AND accepted = 1",
  ).bind(projectId, user.userId).first<{ role: Role }>();
  const isSiteOwner = directRole?.role === "owner";
  const isOrgAdmin = orgRole !== null && ROLE_RANK[orgRole] >= ROLE_RANK["admin"];

  // Hide the org from total strangers (neither an org member nor the site's
  // owner). A direct site owner who is NOT an org member is still allowed
  // through so they can DETACH their own site (e.g. after being removed from
  // the org) - the per-method gates below enforce who may do what.
  if (orgRole === null && !isSiteOwner) return errorResponse(Errors.NOT_FOUND);

  if (request.method === "POST") {
    // Attach requires org admin+ AND direct site ownership.
    if (!isOrgAdmin || !isSiteOwner) return errorResponse(Errors.FORBIDDEN);
    const proj = await env.DB.prepare("SELECT organization_id FROM projects WHERE id = ?")
      .bind(projectId).first<{ organization_id: string | null }>();
    if (!proj) return errorResponse(Errors.NOT_FOUND);
    if (proj.organization_id === orgId) return okResponse({ attached: true }); // idempotent
    if (proj.organization_id !== null) return errorResponse(Errors.CONFLICT);  // detach first
    await env.DB.prepare("UPDATE projects SET organization_id = ? WHERE id = ?").bind(orgId, projectId).run();
    return okResponse({ attached: true });
  }

  if (request.method === "DELETE") {
    // Detach allowed for org admin+ OR the site's owner.
    if (!isOrgAdmin && !isSiteOwner) return errorResponse(Errors.FORBIDDEN);
    await env.DB.prepare("UPDATE projects SET organization_id = NULL WHERE id = ? AND organization_id = ?")
      .bind(projectId, orgId).run();
    return okResponse({ detached: true });
  }

  return errorResponse(Errors.NOT_FOUND);
}

// /organizations/:id/members[/:userId] - mirrors routes/members.ts, including
// the privilege-escalation guards, against organization_members.
async function handleOrgMembers(
  request: Request, env: Env, user: Session, orgId: string, targetUserId: string | null,
): Promise<Response> {
  const callerRole = await getOrgRole(env.DB, orgId, user.userId);
  if (callerRole === null) return errorResponse(Errors.NOT_FOUND);

  // GET /organizations/:id/members - admin+ can list.
  if (!targetUserId && request.method === "GET") {
    if (ROLE_RANK[callerRole] < ROLE_RANK["admin"]) return errorResponse(Errors.FORBIDDEN);
    const rows = await env.DB.prepare(
      "SELECT * FROM organization_members WHERE organization_id = ? ORDER BY created_at ASC",
    ).bind(orgId).all<OrgMemberRow>();
    const plans = await loadMemberPlans(env, rows.results.map(r => r.user_id));
    return okResponse(rows.results.map(r => {
      const info = plans.get(r.user_id);
      return {
        id: r.id, organizationId: r.organization_id, userId: r.user_id,
        email: r.email, name: r.name, role: r.role, accepted: r.accepted === 1,
        invitedBy: r.invited_by, createdAt: r.created_at,
        personalPlan: info?.plan ?? "free", personalPlanStyle: info?.style ?? null,
      };
    }));
  }

  // POST /organizations/:id/members - admin+ can invite by email.
  if (!targetUserId && request.method === "POST") {
    if (ROLE_RANK[callerRole] < ROLE_RANK["admin"]) return errorResponse(Errors.FORBIDDEN);
    const body = await request.json<{ email?: string; role?: Role }>().catch(() => ({} as { email?: string; role?: Role }));
    if (!body.email || !body.role) return errorResponse(Errors.BAD_REQUEST);
    if (!ASSIGNABLE_ORG_ROLES.includes(body.role)) return errorResponse(Errors.BAD_REQUEST);

    // Per-user rate limit on the email->user lookup (shared with site invites).
    const { success } = await env.RATE_LIMITER_INVITE_LOOKUP.limit({ key: user.userId });
    if (!success) return errorResponse(Errors.RATE_LIMITED);

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

    const existing = await env.DB.prepare("SELECT id FROM organization_members WHERE organization_id = ? AND user_id = ?")
      .bind(orgId, inviteeId).first();
    if (existing) return errorResponse(Errors.CONFLICT);

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO organization_members (id, organization_id, user_id, email, name, role, invited_by, created_at, accepted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)",
    ).bind(id, orgId, inviteeId, inviteeEmail, inviteeName, body.role, user.userId, now).run();

    return okResponse({ id, organizationId: orgId, userId: inviteeId, email: inviteeEmail, name: inviteeName, role: body.role, accepted: false, invitedBy: user.userId, createdAt: now }, 201);
  }

  // PATCH /organizations/:id/members/:userId - admin+ can change roles.
  if (targetUserId && request.method === "PATCH") {
    if (ROLE_RANK[callerRole] < ROLE_RANK["admin"]) return errorResponse(Errors.FORBIDDEN);
    const body = await request.json<{ role?: Role }>().catch(() => ({} as { role?: Role }));
    if (!body.role || !ASSIGNABLE_ORG_ROLES.includes(body.role)) return errorResponse(Errors.BAD_REQUEST);

    const row = await env.DB.prepare("SELECT id, role FROM organization_members WHERE organization_id = ? AND user_id = ?")
      .bind(orgId, targetUserId).first<{ id: string; role: Role }>();
    if (!row) return errorResponse(Errors.NOT_FOUND);
    if (row.role === "owner") return errorResponse(Errors.FORBIDDEN);
    // Admins cannot promote to admin+ or modify another admin/owner.
    if (callerRole === "admin" && ROLE_RANK[body.role] >= ROLE_RANK["admin"]) return errorResponse(Errors.FORBIDDEN);
    if (callerRole === "admin" && ROLE_RANK[row.role] >= ROLE_RANK["admin"]) return errorResponse(Errors.FORBIDDEN);

    await env.DB.prepare("UPDATE organization_members SET role = ? WHERE organization_id = ? AND user_id = ?")
      .bind(body.role, orgId, targetUserId).run();
    const updated = await env.DB.prepare("SELECT * FROM organization_members WHERE organization_id = ? AND user_id = ?")
      .bind(orgId, targetUserId).first<OrgMemberRow>();
    if (!updated) return errorResponse(Errors.NOT_FOUND);
    return okResponse({
      id: updated.id, organizationId: updated.organization_id, userId: updated.user_id,
      email: updated.email, name: updated.name, role: updated.role,
      invitedBy: updated.invited_by, createdAt: updated.created_at,
    });
  }

  // DELETE /organizations/:id/members/:userId - admin+ removes; any non-owner self-leaves.
  if (targetUserId && request.method === "DELETE") {
    const isSelf = targetUserId === user.userId;
    if (isSelf) {
      if (callerRole === "owner") return errorResponse(Errors.FORBIDDEN);
      await env.DB.prepare("DELETE FROM organization_members WHERE organization_id = ? AND user_id = ?")
        .bind(orgId, targetUserId).run();
      return okResponse({ deleted: true });
    }

    if (ROLE_RANK[callerRole] < ROLE_RANK["admin"]) return errorResponse(Errors.FORBIDDEN);
    const row = await env.DB.prepare("SELECT id, role FROM organization_members WHERE organization_id = ? AND user_id = ?")
      .bind(orgId, targetUserId).first<{ id: string; role: Role }>();
    if (!row) return errorResponse(Errors.NOT_FOUND);
    if (row.role === "owner") return errorResponse(Errors.FORBIDDEN);
    if (callerRole === "admin" && ROLE_RANK[row.role] >= ROLE_RANK["admin"]) return errorResponse(Errors.FORBIDDEN);

    await env.DB.prepare("DELETE FROM organization_members WHERE organization_id = ? AND user_id = ?")
      .bind(orgId, targetUserId).run();
    return okResponse({ deleted: true });
  }

  return errorResponse(Errors.NOT_FOUND);
}
