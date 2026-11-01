import { errorResponse, Errors } from "../lib";
import { normalizeHandle, handleProblem } from "../../../auth/src/handle";
import type { Env } from "../index";

// GET /users/by-handle/:handle - resolve an opt-in profile handle (the
// `/@<handle>` link) to a user id. Authenticated by the caller (same audience
// as GET /users/:userId, which the frontend then loads for the profile body).
//
// Reads AUTH_DB directly (read-only). A handle only exists while its owner has
// the profile link switched on, so "not found" covers both "never claimed"
// and "turned off". The case-insensitive match comes from storing the handle
// pre-normalized; we normalize the lookup the same way.
export async function handleUserByHandle(env: Env, rawHandle: string): Promise<Response> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawHandle);
  } catch {
    return errorResponse(Errors.NOT_FOUND);
  }
  const handle = normalizeHandle(decoded);
  // Malformed handles can't exist in the table; skip the query. Reserved
  // names still resolve - admins may assign them (users can't claim them).
  const problem = handleProblem(handle);
  if (problem === "length" || problem === "characters") return errorResponse(Errors.NOT_FOUND);

  const row = await env.AUTH_DB.prepare(
    `SELECT u.id, u.name, p.handle
     FROM user_preferences p
     JOIN users u ON u.id = p.user_id
     WHERE p.handle = ?`,
  ).bind(handle).first<{ id: string; name: string; handle: string }>();
  if (!row) return errorResponse(Errors.NOT_FOUND);

  return Response.json({ ok: true, data: { userId: row.id, name: row.name, handle: row.handle } });
}
