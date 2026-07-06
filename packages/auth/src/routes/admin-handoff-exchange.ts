import { normalizeAdminCallbackUrl, writeAdminHandoffAudit } from "../admin-handoff";
import { signJwt } from "../jwt";
import { errorResponse, Errors, okResponse } from "../lib";
import { checkModeration } from "./login";
import { createSession, ADMIN_SESSION_TTL_MS } from "../sessions";
import type { Env } from "../index";

export async function handleAdminHandoffExchange(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{ code?: string; callbackUrl?: string }>();
  if (!body.code || !body.callbackUrl) return errorResponse(Errors.BAD_REQUEST);

  const normalizedCallbackUrl = normalizeAdminCallbackUrl(body.callbackUrl, env);
  if (!normalizedCallbackUrl) return errorResponse(Errors.BAD_REQUEST);

  const now = Date.now();
  const handoff = await env.DB.prepare(
    "SELECT id, user_id FROM admin_handoffs WHERE id = ? AND return_to = ? AND consumed_at IS NULL AND expires_at > ?",
  ).bind(body.code, normalizedCallbackUrl, now).first<{ id: string; user_id: string }>();

  if (!handoff) return errorResponse(Errors.UNAUTHORIZED);

  const consumeResult = await env.DB.prepare(
    "UPDATE admin_handoffs SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL",
  ).bind(now, handoff.id).run();

  if ((consumeResult.meta.changes ?? 0) !== 1) {
    return errorResponse(Errors.UNAUTHORIZED);
  }

  const user = await env.DB.prepare(
    "SELECT id, email, moderation, force_password_change, is_admin FROM users WHERE id = ?",
  ).bind(handoff.user_id).first<{
    id: string;
    email: string;
    moderation: number;
    force_password_change: number;
    is_admin: number;
  }>();

  if (!user) return errorResponse(Errors.UNAUTHORIZED);

  if (!user.is_admin) {
    return Response.json({ ok: false, error: "not_admin" }, { status: 403 });
  }

  const moderationError = checkModeration(user.moderation);
  if (moderationError) return moderationError;

  if (user.force_password_change) {
    return errorResponse(Errors.UNAUTHORIZED);
  }

  // Deliberately short-lived (hours, not the standard 7 days): this token
  // carries full admin privilege. createSession stamps ip/device from the
  // X-Client-IP / User-Agent the admin worker forwards across the
  // service-binding hop.
  const expiresAt = Date.now() + ADMIN_SESSION_TTL_MS;
  const sid = await createSession(env, user.id, request, expiresAt);
  const token = await signJwt(
    {
      userId: user.id,
      email: user.email,
      expiresAt,
      isAdmin: true,
      sid,
    },
    env.JWT_SECRET,
  );

  // Record who obtained admin access, from where, and until when.
  await writeAdminHandoffAudit(env, { userId: user.id, email: user.email }, "admin.handoff.exchange", {
    sessionId: sid,
    expiresAt,
    ip: request.headers.get("CF-Connecting-IP") ?? request.headers.get("X-Client-IP"),
  });

  return okResponse({ token });
}
