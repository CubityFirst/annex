import { okResponse, errorResponse, Errors, type Role } from "../lib";
import type { Env } from "../index";
import type { Session } from "../lib";

// A user's invitation inbox spans BOTH site (project) and org invites. The list
// is unioned and each item is tagged with `type` so the page can render and
// accept/decline either kind. Accept/decline disambiguate via ?type=org.

interface PendingProjectRow {
  id: string;
  project_id: string;
  role: Role;
  invited_by: string;
  created_at: string;
  project_name: string;
  project_description: string | null;
  inviter_name: string | null;
}

interface PendingOrgRow {
  id: string;
  organization_id: string;
  role: Role;
  invited_by: string;
  created_at: string;
  org_name: string;
  inviter_name: string | null;
}

export async function handlePendingInvites(
  request: Request,
  env: Env,
  user: Session,
  url: URL,
): Promise<Response> {
  // GET /pending-invites - site + org invites, merged, newest first.
  if (request.method === "GET" && url.pathname === "/pending-invites") {
    const [projectRes, orgRes] = await env.DB.batch([
      env.DB.prepare(
        `SELECT pm.id, pm.project_id, pm.role, pm.invited_by, pm.created_at,
                p.name as project_name, p.description as project_description,
                COALESCE(pm_inv.name, 'Unknown') as inviter_name
         FROM project_members pm
         JOIN projects p ON p.id = pm.project_id
         LEFT JOIN project_members pm_inv ON pm_inv.project_id = pm.project_id AND pm_inv.user_id = pm.invited_by AND pm_inv.accepted = 1
         WHERE pm.user_id = ? AND pm.accepted = 0`,
      ).bind(user.userId),
      env.DB.prepare(
        `SELECT om.id, om.organization_id, om.role, om.invited_by, om.created_at,
                o.name as org_name,
                COALESCE(om_inv.name, 'Unknown') as inviter_name
         FROM organization_members om
         JOIN organizations o ON o.id = om.organization_id
         LEFT JOIN organization_members om_inv ON om_inv.organization_id = om.organization_id AND om_inv.user_id = om.invited_by AND om_inv.accepted = 1
         WHERE om.user_id = ? AND om.accepted = 0`,
      ).bind(user.userId),
    ]);

    const projectRows = (projectRes as D1Result<PendingProjectRow>).results;
    const orgRows = (orgRes as D1Result<PendingOrgRow>).results;

    const projectInvites = projectRows.map(r => ({
      id: r.id,
      type: "site" as const,
      role: r.role,
      invitedBy: r.invited_by,
      inviterName: r.inviter_name ?? "Unknown",
      createdAt: r.created_at,
      projectId: r.project_id,
      projectName: r.project_name,
      projectDescription: r.project_description,
    }));

    const orgInvites = orgRows.map(r => ({
      id: r.id,
      type: "org" as const,
      role: r.role,
      invitedBy: r.invited_by,
      inviterName: r.inviter_name ?? "Unknown",
      createdAt: r.created_at,
      organizationId: r.organization_id,
      organizationName: r.org_name,
    }));

    const merged = [...projectInvites, ...orgInvites].sort(
      (a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0),
    );
    return okResponse(merged);
  }

  const isOrg = url.searchParams.get("type") === "org";

  // POST /pending-invites/:id/accept[?type=org]
  const acceptMatch = url.pathname.match(/^\/pending-invites\/([^/]+)\/accept$/);
  if (acceptMatch && request.method === "POST") {
    const inviteId = acceptMatch[1];
    const table = isOrg ? "organization_members" : "project_members";
    const row = await env.DB.prepare(
      `SELECT id FROM ${table} WHERE id = ? AND user_id = ? AND accepted = 0`,
    ).bind(inviteId, user.userId).first();
    if (!row) return errorResponse(Errors.NOT_FOUND);

    await env.DB.prepare(`UPDATE ${table} SET accepted = 1 WHERE id = ?`).bind(inviteId).run();
    return okResponse({ accepted: true });
  }

  // DELETE /pending-invites/:id[?type=org] (decline)
  const declineMatch = url.pathname.match(/^\/pending-invites\/([^/]+)$/);
  if (declineMatch && request.method === "DELETE") {
    const inviteId = declineMatch[1];
    const table = isOrg ? "organization_members" : "project_members";
    const row = await env.DB.prepare(
      `SELECT id FROM ${table} WHERE id = ? AND user_id = ? AND accepted = 0`,
    ).bind(inviteId, user.userId).first();
    if (!row) return errorResponse(Errors.NOT_FOUND);

    await env.DB.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(inviteId).run();
    return okResponse({ declined: true });
  }

  return errorResponse(Errors.NOT_FOUND);
}
