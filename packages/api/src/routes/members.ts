import { okResponse, errorResponse, Errors, ROLE_RANK, type Role, type Member } from "../lib";
import type { Env } from "../index";
import { resolveRole } from "../lib/access";
import type { Session } from "../lib";
import { resolvePersonalPlan, type PersonalPlan } from "../../../auth/src/plan";

const VALID_ROLES: Role[] = ["limited", "viewer", "editor", "admin", "owner"];

interface MemberRow {
  id: string; project_id: string; user_id: string; email: string; name: string;
  role: Role; invited_by: string; created_at: string; accepted: number;
}

interface AuthPlanRow {
  id: string;
  personal_plan: string | null;
  personal_plan_status: string | null;
  personal_plan_started_at: number | null;
  personal_plan_cancel_at: number | null;
  personal_plan_style: string | null;
  personal_presence_color: string | null;
  personal_crit_sparkles: number | null;
  granted_plan: string | null;
  granted_plan_expires_at: number | null;
  granted_plan_started_at: number | null;
}

interface MemberPlanInfo {
  plan: PersonalPlan;
  style: string | null;
}

// One D1 read against AUTH_DB returns the plan columns for every user
// id in the list. Empty list short-circuits - D1 doesn't accept zero
// placeholders in IN(). Map keys are user ids; values include the
// resolved plan plus the chosen ring style so the members list can
// render each supporter's customised avatar.
export async function loadMemberPlans(env: Env, userIds: string[]): Promise<Map<string, MemberPlanInfo>> {
  const plans = new Map<string, MemberPlanInfo>();
  if (userIds.length === 0) return plans;

  const placeholders = userIds.map(() => "?").join(",");
  const rows = await env.AUTH_DB.prepare(
    `SELECT u.id, p.personal_plan_style, p.personal_presence_color, p.personal_crit_sparkles,
            b.personal_plan, b.personal_plan_status, b.personal_plan_started_at,
            b.personal_plan_cancel_at,
            b.granted_plan, b.granted_plan_expires_at, b.granted_plan_started_at
     FROM users u
     LEFT JOIN user_billing b ON b.user_id = u.id
     LEFT JOIN user_preferences p ON p.user_id = u.id
     WHERE u.id IN (${placeholders})`,
  ).bind(...userIds).all<AuthPlanRow>();

  for (const r of rows.results) {
    const resolved = resolvePersonalPlan({
      granted_plan: r.granted_plan,
      granted_plan_expires_at: r.granted_plan_expires_at,
      granted_plan_started_at: r.granted_plan_started_at,
      personal_plan: r.personal_plan,
      personal_plan_status: r.personal_plan_status,
      personal_plan_started_at: r.personal_plan_started_at,
      personal_plan_cancel_at: r.personal_plan_cancel_at,
      personal_plan_style: r.personal_plan_style,
      personal_presence_color: r.personal_presence_color,
      personal_crit_sparkles: r.personal_crit_sparkles,
    });
    plans.set(r.id, { plan: resolved.plan, style: resolved.style });
  }
  return plans;
}

export async function handleMembers(
  request: Request,
  env: Env,
  user: Session,
  url: URL,
): Promise<Response> {
  // URL pattern: /projects/:projectId/members[/:userId]
  const match = url.pathname.match(/^\/projects\/([^/]+)\/members\/?([^/]*)$/);
  if (!match) return errorResponse(Errors.NOT_FOUND);
  const projectId = match[1];
  const targetUserId = match[2] || null;

  const callerRole = await resolveRole(env.DB, projectId, user.userId);
  if (callerRole === null) return errorResponse(Errors.NOT_FOUND);

  // GET /projects/:id/members - admin/owner can list
  if (!targetUserId && request.method === "GET") {
    if (ROLE_RANK[callerRole] < ROLE_RANK["admin"]) return errorResponse(Errors.FORBIDDEN);

    const rows = await env.DB.prepare(
      "SELECT * FROM project_members WHERE project_id = ? ORDER BY created_at ASC",
    ).bind(projectId).all<MemberRow>();

    const plans = await loadMemberPlans(env, rows.results.map(r => r.user_id));

    return okResponse(rows.results.map(r => {
      const info = plans.get(r.user_id);
      return {
        id: r.id,
        projectId: r.project_id,
        userId: r.user_id,
        email: r.email,
        name: r.name,
        role: r.role,
        accepted: r.accepted === 1,
        invitedBy: r.invited_by,
        createdAt: r.created_at,
        personalPlan: info?.plan ?? "free",
        personalPlanStyle: info?.style ?? null,
      };
    }));
  }

  // POST /projects/:id/members - admin/owner can invite
  if (!targetUserId && request.method === "POST") {
    if (ROLE_RANK[callerRole] < ROLE_RANK["admin"]) return errorResponse(Errors.FORBIDDEN);

    const body = await request.json<{ email: string; role: Role }>();
    if (!body.email || !body.role) return errorResponse(Errors.BAD_REQUEST);
    if (!VALID_ROLES.includes(body.role) || body.role === "owner") return errorResponse(Errors.BAD_REQUEST);

    // Per-user rate limit on the email→user lookup. The auth worker enforces
    // a coarser IP-keyed limit; this one stops any single account from
    // scraping the email map even from many IPs.
    const { success } = await env.RATE_LIMITER_INVITE_LOOKUP.limit({ key: user.userId });
    if (!success) return errorResponse(Errors.RATE_LIMITED);

    // Look up the user by email from auth worker
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

    // Check if already a member (covers the owner case too)
    const existing = await env.DB.prepare("SELECT id FROM project_members WHERE project_id = ? AND user_id = ?")
      .bind(projectId, inviteeId).first();
    if (existing) return errorResponse(Errors.CONFLICT);

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO project_members (id, project_id, user_id, email, name, role, invited_by, created_at, accepted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)",
    ).bind(id, projectId, inviteeId, inviteeEmail, inviteeName, body.role, user.userId, now).run();

    return okResponse({ id, projectId, userId: inviteeId, email: inviteeEmail, name: inviteeName, role: body.role, accepted: false, invitedBy: user.userId, createdAt: now }, 201);
  }

  // PATCH /projects/:id/members/:userId - admin/owner can change roles
  if (targetUserId && request.method === "PATCH") {
    if (ROLE_RANK[callerRole] < ROLE_RANK["admin"]) return errorResponse(Errors.FORBIDDEN);

    const body = await request.json<{ role: Role }>();
    if (!body.role || !VALID_ROLES.includes(body.role) || body.role === "owner") return errorResponse(Errors.BAD_REQUEST);

    const row = await env.DB.prepare("SELECT id, role FROM project_members WHERE project_id = ? AND user_id = ?")
      .bind(projectId, targetUserId).first<{ id: string; role: Role }>();
    if (!row) return errorResponse(Errors.NOT_FOUND);
    if (row.role === "owner") return errorResponse(Errors.FORBIDDEN);

    // Admins cannot promote to admin or above
    if (callerRole === "admin" && ROLE_RANK[body.role] >= ROLE_RANK["admin"]) {
      return errorResponse(Errors.FORBIDDEN);
    }
    // Admins cannot change another admin's role
    if (callerRole === "admin" && ROLE_RANK[row.role] >= ROLE_RANK["admin"]) {
      return errorResponse(Errors.FORBIDDEN);
    }

    const stmts = [
      env.DB.prepare("UPDATE project_members SET role = ? WHERE project_id = ? AND user_id = ?")
        .bind(body.role, projectId, targetUserId),
    ];
    // Promotion to editor or above makes any per-doc share inert (project-wide
    // access supersedes it). Drop the rows so the share dialog doesn't show
    // them and so a future demotion doesn't silently re-grant old access.
    if (ROLE_RANK[body.role] >= ROLE_RANK["editor"]) {
      stmts.push(env.DB.prepare("DELETE FROM doc_shares WHERE project_id = ? AND user_id = ?")
        .bind(projectId, targetUserId));
    }
    await env.DB.batch(stmts);

    const updated = await env.DB.prepare("SELECT * FROM project_members WHERE project_id = ? AND user_id = ?")
      .bind(projectId, targetUserId).first<MemberRow>();
    if (!updated) return errorResponse(Errors.NOT_FOUND);

    return okResponse({
      id: updated.id, projectId: updated.project_id, userId: updated.user_id,
      email: updated.email, name: updated.name, role: updated.role,
      invitedBy: updated.invited_by, createdAt: updated.created_at,
    });
  }

  // DELETE /projects/:id/members/:userId - admin/owner can remove; any non-owner can remove themselves
  if (targetUserId && request.method === "DELETE") {
    const isSelf = targetUserId === user.userId;

    if (isSelf) {
      // Allow any member to leave, except the owner
      if (callerRole === "owner") return errorResponse(Errors.FORBIDDEN);
      await env.DB.prepare("DELETE FROM project_members WHERE project_id = ? AND user_id = ?")
        .bind(projectId, targetUserId).run();
      return okResponse({ deleted: true });
    }

    if (ROLE_RANK[callerRole] < ROLE_RANK["admin"]) return errorResponse(Errors.FORBIDDEN);

    const row = await env.DB.prepare("SELECT id, role FROM project_members WHERE project_id = ? AND user_id = ?")
      .bind(projectId, targetUserId).first<{ id: string; role: Role }>();
    if (!row) return errorResponse(Errors.NOT_FOUND);
    if (row.role === "owner") return errorResponse(Errors.FORBIDDEN);

    // Admins cannot remove other admins
    if (callerRole === "admin" && ROLE_RANK[row.role] >= ROLE_RANK["admin"]) {
      return errorResponse(Errors.FORBIDDEN);
    }

    await env.DB.prepare("DELETE FROM project_members WHERE project_id = ? AND user_id = ?")
      .bind(projectId, targetUserId).run();

    return okResponse({ deleted: true });
  }

  return errorResponse(Errors.NOT_FOUND);
}
