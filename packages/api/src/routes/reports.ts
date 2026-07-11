import { okResponse, errorResponse, Errors, Session } from "../lib";
import { MAX_REPORT_NOTE_LENGTH } from "./public";
import type { Env } from "../index";

// POST /users/:userId/report - file an abuse report against a user from the
// profile card. Authenticated (unlike the public site report): the card only
// renders inside the app, and requiring a session gives every user report a
// real reporter. Same note rules and limiter as site reports, but keyed by
// the reporting user rather than IP - a signed-in caller shouldn't get extra
// throws by rotating IPs.
export async function handleUserReport(
  request: Request,
  env: Env,
  session: Session,
  targetUserId: string,
): Promise<Response> {
  if (env.RATE_LIMITER_REPORT) {
    const { success } = await env.RATE_LIMITER_REPORT.limit({ key: `report:user:${session.userId}` });
    if (!success) return errorResponse(Errors.RATE_LIMITED);
  }

  // Reporting yourself is always a misclick.
  if (targetUserId === session.userId) return errorResponse(Errors.BAD_REQUEST);

  let body: { note?: unknown };
  try {
    body = await request.json();
  } catch {
    return errorResponse(Errors.BAD_REQUEST);
  }
  const note = typeof body.note === "string" ? body.note.trim() : "";
  if (!note || note.length > MAX_REPORT_NOTE_LENGTH) return errorResponse(Errors.BAD_REQUEST);

  // Target must be a real account (AUTH_DB is read-only by convention).
  const target = await env.AUTH_DB.prepare("SELECT id FROM users WHERE id = ?")
    .bind(targetUserId).first<{ id: string }>();
  if (!target) return errorResponse(Errors.NOT_FOUND);

  const ip = request.headers.get("CF-Connecting-IP") ?? request.headers.get("X-Client-IP");
  await env.DB.prepare(
    "INSERT INTO user_reports (id, reported_user_id, reporter_user_id, reporter_ip, note) VALUES (?, ?, ?, ?, ?)",
  ).bind(crypto.randomUUID(), targetUserId, session.userId, ip, note).run();

  return okResponse({ submitted: true }, 201);
}
