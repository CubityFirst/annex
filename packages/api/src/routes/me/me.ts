// GET/PATCH /me and GET /users/:userId, served from cubedocs-main.
//
// Identity facts (name, email, verification) come from the users mirror,
// which the identity service owns: Annex no longer changes them. Annex-only
// facts (timezone, bio, handle, badges, fonts, theme, Ink) come from
// user_preferences / user_billing.

import { errorResponse, Errors, okResponse, type Session } from "../../lib";
import { resolvePersonalPlan } from "../../account/plan";
import type { Env } from "../../index";

// Where the identity service's own account pages live, for the settings
// page's "Manage your account" links.
export function identityAccountUrls(env: Pick<Env, "OIDC_ISSUER">): { accountUrl: string; securityUrl: string } {
  const issuer = (env.OIDC_ISSUER ?? "https://auth.cubityfir.st").replace(/\/+$/, "");
  return { accountUrl: `${issuer}/account`, securityUrl: `${issuer}/account/security` };
}

export async function handleGetMe(env: Env, session: Session): Promise<Response> {
  const [row, customThemingEnabled] = await Promise.all([
    env.DB.prepare(
      `SELECT u.name, u.email, u.email_verified, p.timezone, p.bio, p.handle, p.handle_locked
       FROM users u LEFT JOIN user_preferences p ON p.user_id = u.id
       WHERE u.id = ?`,
    ).bind(session.userId).first<{
      name: string; email: string; email_verified: number;
      timezone: string | null; bio: string | null; handle: string | null; handle_locked: number | null;
    }>(),
    env.FLAGS
      ? env.FLAGS.getBooleanValue("custom-theming", false, { userId: session.userId })
      : Promise.resolve(true),
  ]);
  if (!row) return errorResponse(Errors.UNAUTHORIZED);

  return okResponse({
    name: row.name,
    email: row.email,
    emailVerified: row.email_verified === 1,
    userId: session.userId,
    timezone: row.timezone,
    bio: row.bio,
    handle: row.handle ?? null,
    handleLocked: !!row.handle_locked,
    personalPlan: session.personalPlan ?? "free",
    personalPlanSince: session.personalPlanSince ?? null,
    personalPlanStatus: session.personalPlanStatus ?? null,
    personalPlanCancelAt: session.personalPlanCancelAt ?? null,
    personalPlanStyle: session.personalPlanStyle ?? null,
    personalPresenceColor: session.personalPresenceColor ?? null,
    personalCritSparkles: session.personalCritSparkles ?? true,
    readingFont: session.readingFont ?? null,
    editingFont: session.editingFont ?? null,
    uiFont: session.uiFont ?? null,
    isAdmin: session.isAdmin ?? false,
    themeMode: session.themeMode ?? null,
    themeCustomColor: session.themeCustomColor ?? null,
    customThemingEnabled,
    ...identityAccountUrls(env),
  });
}

// PATCH /me - timezone only. The display name belongs to the identity
// service now (auth.cubityfir.st/account); Annex picks changes up from it.
export async function handlePatchMe(request: Request, env: Env, session: Session): Promise<Response> {
  const body = await request.json<{ name?: unknown; timezone?: string | null }>().catch(() => null);
  if (!body || typeof body !== "object") return errorResponse(Errors.BAD_REQUEST);
  if ("name" in body) {
    return Response.json(
      { ok: false, error: "name_managed_by_identity", status: 400, ...identityAccountUrls(env) },
      { status: 400 },
    );
  }
  if (!("timezone" in body)) return errorResponse(Errors.BAD_REQUEST);

  const timezone = body.timezone ?? null;
  if (timezone !== null) {
    if (typeof timezone !== "string") return errorResponse(Errors.BAD_REQUEST);
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    } catch {
      return errorResponse(Errors.BAD_REQUEST);
    }
  }
  await env.DB.prepare(
    `INSERT INTO user_preferences (user_id, timezone) VALUES (?, ?)
     ON CONFLICT(user_id) DO UPDATE SET timezone = excluded.timezone`,
  ).bind(session.userId, timezone).run();
  return okResponse({ timezone });
}

// GET /users/:userId - profile card: name, plan, badges, bio (Ink only),
// handle, timezone, shared sites and favourites.
export async function handleUserProfile(env: Env, session: Session, targetUserId: string): Promise<Response> {
  const user = await env.DB.prepare(
    `SELECT u.id, u.name, u.created_at,
            p.timezone, p.badges, p.bio, p.handle,
            p.personal_plan_style, p.personal_presence_color, p.personal_crit_sparkles,
            b.personal_plan, b.personal_plan_status, b.personal_plan_started_at,
            b.personal_plan_cancel_at,
            b.granted_plan, b.granted_plan_expires_at, b.granted_plan_started_at
     FROM users u
     LEFT JOIN user_billing b ON b.user_id = u.id
     LEFT JOIN user_preferences p ON p.user_id = u.id
     WHERE u.id = ?`,
  ).bind(targetUserId).first<{
    id: string; name: string; created_at: string;
    timezone: string | null; badges: number | null; bio: string | null; handle: string | null;
    personal_plan: string | null; personal_plan_status: string | null; personal_plan_started_at: number | null;
    personal_plan_cancel_at: number | null; personal_plan_style: string | null; personal_presence_color: string | null;
    personal_crit_sparkles: number | null; granted_plan: string | null; granted_plan_expires_at: number | null;
    granted_plan_started_at: number | null;
  }>();
  if (!user) return errorResponse(Errors.NOT_FOUND);

  const [sharedRows, favouriteRows] = await Promise.all([
    env.DB.prepare(
      `SELECT p.id, p.name, target.role as their_role
       FROM projects p
       JOIN project_members caller ON caller.project_id = p.id AND caller.user_id = ? AND caller.accepted = 1
       JOIN project_members target ON target.project_id = p.id AND target.user_id = ? AND target.accepted = 1
       ORDER BY p.name ASC`,
    ).bind(session.userId, targetUserId).all<{ id: string; name: string; their_role: string }>(),
    env.DB.prepare(
      `SELECT p.id, p.name, p.vanity_slug, p.logo_square_updated_at, p.logo_wide_updated_at, ufp.note
       FROM user_favourite_projects ufp
       JOIN projects p ON p.id = ufp.project_id
       WHERE ufp.user_id = ? AND p.published_at IS NOT NULL
       ORDER BY ufp.created_at DESC`,
    ).bind(targetUserId).all<{ id: string; name: string; vanity_slug: string | null; logo_square_updated_at: string | null; logo_wide_updated_at: string | null; note: string | null }>(),
  ]);

  const resolvedPlan = resolvePersonalPlan(user);
  const profile: Record<string, unknown> = {
    userId: user.id,
    name: user.name,
    createdAt: user.created_at,
    sharedProjects: sharedRows.results.map(r => ({ id: r.id, name: r.name, theirRole: r.their_role })),
    favouriteSites: favouriteRows.results.map(r => ({
      id: r.id,
      name: r.name,
      vanitySlug: r.vanity_slug,
      logoSquareUpdatedAt: r.logo_square_updated_at,
      logoWideUpdatedAt: r.logo_wide_updated_at,
      note: r.note,
    })),
    personalPlan: resolvedPlan.plan,
    personalPlanSince: resolvedPlan.since,
    personalPlanStyle: resolvedPlan.style,
    badges: user.badges ?? 0,
  };
  if (user.timezone) profile.timezone = user.timezone;
  if (user.handle) profile.handle = user.handle;
  // Bio is supporter-gated on display: only shown while the user holds Ink.
  // The column persists across cancel/resub so it comes back on resubscribe.
  if (resolvedPlan.plan === "ink" && user.bio) profile.bio = user.bio;
  return okResponse(profile);
}
