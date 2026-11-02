import { requireAuthenticatedSession } from "../auth-session";
import { okResponse, errorResponse, Errors, isUniqueConstraintError } from "../lib";
import { normalizeHandle, handleProblem } from "../handle";
import type { Env } from "../index";

// Set or clear the caller's public profile handle (the opt-in `/@<handle>`
// link). `{ handle: null }` (or an empty string) turns the link off and
// releases the name. Not plan-gated. Refused (403, reason "locked") while an
// admin has locked the user's handle.
//
// Uniqueness is enforced by the partial unique index on
// user_preferences.handle (0035), so a concurrent claim of the same name loses
// with a 409 rather than racing a SELECT-then-write check.
export async function handleUpdateHandle(request: Request, env: Env): Promise<Response> {
  const session = await requireAuthenticatedSession(request, env);
  if (session instanceof Response) return session;

  let body: { handle?: unknown };
  try {
    body = await request.json<{ handle?: unknown }>();
  } catch {
    return errorResponse(Errors.BAD_REQUEST);
  }
  if (!body || typeof body !== "object" || !("handle" in body)) return errorResponse(Errors.BAD_REQUEST);

  let handle: string | null;
  if (body.handle === null) {
    handle = null;
  } else if (typeof body.handle === "string") {
    const normalized = normalizeHandle(body.handle);
    if (normalized.length === 0) {
      handle = null;
    } else {
      const problem = handleProblem(normalized);
      if (problem) {
        return Response.json({ ok: false, ...Errors.BAD_REQUEST, reason: problem }, { status: 400 });
      }
      handle = normalized;
    }
  } else {
    return errorResponse(Errors.BAD_REQUEST);
  }

  // Admin lock (0035 handle_locked): the user can't change their handle at
  // all - neither claim one nor rename/clear an admin-assigned one. The
  // guard is repeated inside each write's WHERE so a lock applied between
  // this read and the write still wins.
  if (await isLocked(env, session.userId)) return lockedResponse();

  if (handle === null) {
    // Clearing never needs to create a satellite row. Zero changes is normal
    // (no row / already clear) unless a lock landed since the read above.
    const res = await env.DB.prepare("UPDATE user_preferences SET handle = NULL WHERE user_id = ? AND handle_locked = 0")
      .bind(session.userId).run();
    if (res.meta.changes === 0 && await isLocked(env, session.userId)) return lockedResponse();
    return okResponse({ handle: null });
  }

  let changes: number;
  try {
    const res = await env.DB.prepare(
      `INSERT INTO user_preferences (user_id, handle) VALUES (?, ?)
       ON CONFLICT(user_id) DO UPDATE SET handle = excluded.handle
       WHERE user_preferences.handle_locked = 0`,
    ).bind(session.userId, handle).run();
    changes = res.meta.changes;
  } catch (err) {
    if (isUniqueConstraintError(err)) return errorResponse(Errors.CONFLICT);
    throw err;
  }
  // The upsert always touches one row unless the DO UPDATE's lock guard held.
  if (changes === 0) return lockedResponse();

  return okResponse({ handle });
}

async function isLocked(env: Env, userId: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT handle_locked FROM user_preferences WHERE user_id = ?")
    .bind(userId).first<{ handle_locked: number }>();
  return !!row?.handle_locked;
}

function lockedResponse(): Response {
  return Response.json({ ok: false, ...Errors.FORBIDDEN, reason: "locked" }, { status: 403 });
}
