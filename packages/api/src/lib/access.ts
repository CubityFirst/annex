import { ROLE_RANK, type Role } from "../lib";

// ── The single per-site access-check boundary ───────────────────────────────
//
// Every authenticated per-site authorization gate resolves a caller's EFFECTIVE
// role here, instead of querying project_members directly. The effective role
// is the higher-ranked (by ROLE_RANK) of:
//   (a) the caller's direct, accepted project_members row, and
//   (b) the caller's accepted organization_members role for the site's
//       organization_id (org membership trickles down to every site in the org).
//
// Org roles never include 'limited' (a per-doc-share concept with no org
// meaning), so a direct-'limited' member who is ALSO an org viewer+ is correctly
// elevated out of the per-doc-share gate - exactly the intended trickle-down.
//
// Resolved at read time (NOT materialized into project_members rows): one
// source of truth, no fan-out writes on membership/attach changes, and
// project_members row semantics (favourite/hidden/accepted/invited_by, the
// members list, doc_shares) stay meaning "directly invited here".
//
// DO NOT re-introduce a local getCallerRole / inline project_members role query
// for a caller-access gate. Direct project_members queries remain ONLY for:
// target-row escalation guards (members/docShares), attribution joins
// (author_id/uploaded_by), the GET /projects "Your Sites" list, the site
// members-list CONTENTS, and attach's site-owner check (which must be direct,
// not effective - see routes/organizations.ts).

export interface EffectiveAccess {
  /** Higher-ranked of the direct vs. org role. */
  role: Role;
  /** Display name for attribution; falls back to the userId. */
  name: string;
  /** Raw direct project_members role (null if the caller has no direct row). */
  projectRole: Role | null;
  /** Raw organization_members role (null if the caller has no org row). */
  orgRole: Role | null;
  /** Which membership won (ties resolve to org - identical effect). */
  source: "project" | "org";
}

// ONE D1 read: projects is the anchor (PK lookup), both memberships are LEFT
// JOINs on indexed columns. Same cost class as the old single-table query -
// don't split this into two reads.
export async function resolveAccess(
  db: D1Database,
  projectId: string,
  userId: string,
): Promise<EffectiveAccess | null> {
  const row = await db.prepare(
    `SELECT pm.role AS project_role, pm.name AS project_name,
            om.role AS org_role,     om.name AS org_name
       FROM projects p
       LEFT JOIN project_members pm
              ON pm.project_id = p.id AND pm.user_id = ? AND pm.accepted = 1
       LEFT JOIN organization_members om
              ON om.organization_id = p.organization_id AND om.user_id = ? AND om.accepted = 1
      WHERE p.id = ?`,
  ).bind(userId, userId, projectId).first<{
    project_role: Role | null; project_name: string | null;
    org_role: Role | null;     org_name: string | null;
  }>();

  if (!row) return null;                                  // project doesn't exist
  const pr = row.project_role;
  const orr = row.org_role;
  if (pr === null && orr === null) return null;           // no membership either way

  const prRank = pr === null ? -Infinity : ROLE_RANK[pr];
  const orRank = orr === null ? -Infinity : ROLE_RANK[orr];
  const useOrg = orRank >= prRank;                        // tie -> org (same effect)

  return {
    role: useOrg ? orr! : pr!,
    name: (useOrg ? row.org_name : row.project_name) ?? userId,
    projectRole: pr,
    orgRole: orr,
    source: useOrg ? "org" : "project",
  };
}

// Role-only convenience - the drop-in replacement for every former
// getCallerRole(db, projectId, userId): Promise<Role | null>.
export async function resolveRole(
  db: D1Database,
  projectId: string,
  userId: string,
): Promise<Role | null> {
  return (await resolveAccess(db, projectId, userId))?.role ?? null;
}
