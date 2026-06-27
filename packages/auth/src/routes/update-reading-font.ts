import { requireAuthenticatedSession } from "../auth-session";
import { okResponse, errorResponse, Errors } from "../lib";
import { isFontChoice } from "../fonts";
import type { Env } from "../index";

// Patch the user's prose-font choices for reading and editing modes. Both
// fields are optional in the body; pass `null` to reset to the default
// (NULL on the row → frontend falls back to the default sans stack).
//
// Unlike update-ink-prefs, this is NOT gated on the Ink plan - OpenDyslexic
// in particular is an accessibility feature, so every user can pick it.
export async function handleUpdateReadingFont(request: Request, env: Env): Promise<Response> {
  const session = await requireAuthenticatedSession(request, env);
  if (session instanceof Response) return session;

  const body = await request.json<{ readingFont?: string | null; editingFont?: string | null; uiFont?: string | null }>();

  if (!("readingFont" in body) && !("editingFont" in body) && !("uiFont" in body)) return errorResponse(Errors.BAD_REQUEST);

  if ("readingFont" in body && body.readingFont !== null && !isFontChoice(body.readingFont)) {
    return errorResponse(Errors.BAD_REQUEST);
  }
  if ("editingFont" in body && body.editingFont !== null && !isFontChoice(body.editingFont)) {
    return errorResponse(Errors.BAD_REQUEST);
  }
  if ("uiFont" in body && body.uiFont !== null && !isFontChoice(body.uiFont)) {
    return errorResponse(Errors.BAD_REQUEST);
  }

  // Build an upsert that only touches the columns the caller actually sent.
  // INSERT supplies values for those columns (user_id always first); ON CONFLICT
  // mirrors the same SET clause so existing rows aren't clobbered for unrelated
  // pref columns.
  const cols: string[] = [];
  const placeholders: string[] = [];
  const updates: string[] = [];
  const values: unknown[] = [];
  if ("readingFont" in body) {
    cols.push("reading_font"); placeholders.push("?");
    updates.push("reading_font = excluded.reading_font");
    values.push(body.readingFont ?? null);
  }
  if ("editingFont" in body) {
    cols.push("editing_font"); placeholders.push("?");
    updates.push("editing_font = excluded.editing_font");
    values.push(body.editingFont ?? null);
  }
  if ("uiFont" in body) {
    cols.push("ui_font"); placeholders.push("?");
    updates.push("ui_font = excluded.ui_font");
    values.push(body.uiFont ?? null);
  }

  await env.DB.prepare(
    `INSERT INTO user_preferences (user_id, ${cols.join(", ")}) VALUES (?, ${placeholders.join(", ")})
     ON CONFLICT(user_id) DO UPDATE SET ${updates.join(", ")}`,
  ).bind(session.userId, ...values).run();

  return okResponse({
    readingFont: "readingFont" in body ? (body.readingFont ?? null) : undefined,
    editingFont: "editingFont" in body ? (body.editingFont ?? null) : undefined,
    uiFont: "uiFont" in body ? (body.uiFont ?? null) : undefined,
  });
}
