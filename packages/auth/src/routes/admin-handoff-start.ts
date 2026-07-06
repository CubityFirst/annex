import { requireAuthenticatedSession } from "../auth-session";
import { normalizeAdminCallbackUrl, writeAdminHandoffAudit } from "../admin-handoff";
import { errorResponse, Errors, okResponse } from "../lib";
import type { Env } from "../index";

const HANDOFF_TTL_MS = 5 * 60 * 1000;

export async function handleAdminHandoffStart(request: Request, env: Env): Promise<Response> {
  const session = await requireAuthenticatedSession(request, env);
  if (session instanceof Response) return session;

  if (!session.isAdmin) {
    return Response.json({ ok: false, error: "not_admin" }, { status: 403 });
  }

  const body = await request.json<{ returnTo?: string }>();
  if (!body.returnTo) return errorResponse(Errors.BAD_REQUEST);

  const normalizedReturnTo = normalizeAdminCallbackUrl(body.returnTo, env);
  if (!normalizedReturnTo) return errorResponse(Errors.BAD_REQUEST);

  const now = Date.now();
  const expiresAt = now + HANDOFF_TTL_MS;
  const code = crypto.randomUUID();

  await env.DB.prepare(
    "DELETE FROM admin_handoffs WHERE expires_at <= ? OR consumed_at IS NOT NULL",
  ).bind(now).run();

  await env.DB.prepare(
    "INSERT INTO admin_handoffs (id, user_id, return_to, created_at, expires_at, consumed_at) VALUES (?, ?, ?, ?, ?, NULL)",
  ).bind(code, session.userId, normalizedReturnTo, now, expiresAt).run();

  // Record that an admin handoff was initiated (the exchange writes its own
  // row when the code is redeemed - a start with no matching exchange is
  // itself a useful signal).
  await writeAdminHandoffAudit(env, { userId: session.userId, email: session.email }, "admin.handoff.start", {
    returnTo: normalizedReturnTo,
  });

  const redirectUrl = new URL(normalizedReturnTo);
  redirectUrl.searchParams.set("code", code);

  return okResponse({
    redirectTo: redirectUrl.toString(),
    expiresAt,
  });
}
