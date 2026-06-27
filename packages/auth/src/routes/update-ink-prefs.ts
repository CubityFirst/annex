import { requireAuthenticatedSession } from "../auth-session";
import { okResponse, errorResponse, Errors } from "../lib";
import { resolvePersonalPlan, isInkRingStyle, isInkPresenceColor } from "../plan";
import type { Env } from "../index";

// Patch Ink supporter cosmetic prefs: ring style + presence colour. Both
// fields are optional in the body; pass `null` to reset back to default
// (NULL on the row means "use the deterministic default" - see plan.ts).
//
// Gated on the caller having an active Ink plan via resolvePersonalPlan, so
// expired-grant or canceled-paid users can't keep tweaking. Refusing here
// rather than just hiding the UI in the frontend stops a pre-emptive
// downgrade race (sub canceled mid-session, user submits update before the
// JWT refresh) from silently writing.
export async function handleUpdateInkPrefs(request: Request, env: Env): Promise<Response> {
  const session = await requireAuthenticatedSession(request, env);
  if (session instanceof Response) return session;

  const body = await request.json<{ style?: string | null; presenceColor?: string | null; critSparkles?: boolean | null }>();

  if (!("style" in body) && !("presenceColor" in body) && !("critSparkles" in body)) return errorResponse(Errors.BAD_REQUEST);

  if ("style" in body && body.style !== null && !isInkRingStyle(body.style)) {
    return errorResponse(Errors.BAD_REQUEST);
  }
  if ("presenceColor" in body && body.presenceColor !== null && !isInkPresenceColor(body.presenceColor)) {
    return errorResponse(Errors.BAD_REQUEST);
  }
  if ("critSparkles" in body && body.critSparkles !== null && typeof body.critSparkles !== "boolean") {
    return errorResponse(Errors.BAD_REQUEST);
  }

  const planRow = await env.DB.prepare(
    `SELECT p.personal_plan_style, p.personal_presence_color, p.personal_crit_sparkles,
            b.personal_plan, b.personal_plan_status, b.personal_plan_started_at,
            b.personal_plan_cancel_at,
            b.granted_plan, b.granted_plan_expires_at, b.granted_plan_started_at
     FROM users u
     LEFT JOIN user_billing b ON b.user_id = u.id
     LEFT JOIN user_preferences p ON p.user_id = u.id
     WHERE u.id = ?`,
  ).bind(session.userId).first<{
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
  }>();
  if (!planRow) return errorResponse(Errors.NOT_FOUND);

  const resolved = resolvePersonalPlan(planRow);
  if (resolved.plan !== "ink") return errorResponse(Errors.FORBIDDEN);

  // Upsert only the touched columns into user_preferences (see update-reading-font.ts
  // for the same pattern).
  const cols: string[] = [];
  const placeholders: string[] = [];
  const updates: string[] = [];
  const values: unknown[] = [];
  if ("style" in body) {
    cols.push("personal_plan_style"); placeholders.push("?");
    updates.push("personal_plan_style = excluded.personal_plan_style");
    values.push(body.style ?? null);
  }
  if ("presenceColor" in body) {
    cols.push("personal_presence_color"); placeholders.push("?");
    updates.push("personal_presence_color = excluded.personal_presence_color");
    values.push(body.presenceColor ?? null);
  }
  if ("critSparkles" in body) {
    cols.push("personal_crit_sparkles"); placeholders.push("?");
    updates.push("personal_crit_sparkles = excluded.personal_crit_sparkles");
    // NULL means "use the default" (on). Persist 0/1 for explicit values.
    values.push(body.critSparkles === null ? null : body.critSparkles ? 1 : 0);
  }

  await env.DB.prepare(
    `INSERT INTO user_preferences (user_id, ${cols.join(", ")}) VALUES (?, ${placeholders.join(", ")})
     ON CONFLICT(user_id) DO UPDATE SET ${updates.join(", ")}`,
  ).bind(session.userId, ...values).run();

  return okResponse({
    style: "style" in body ? (body.style ?? null) : resolved.style,
    presenceColor: "presenceColor" in body ? (body.presenceColor ?? null) : resolved.presenceColor,
    critSparkles: "critSparkles" in body ? (body.critSparkles ?? true) : resolved.critSparkles,
  });
}
