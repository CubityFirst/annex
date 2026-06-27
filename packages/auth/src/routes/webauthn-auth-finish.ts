import { okResponse, errorResponse, Errors, normalizeEmail } from "../lib";
import { verifyWebauthnAssertion } from "../webauthn";
import { signJwt } from "../jwt";
import { checkModeration } from "./login";
import { createSession, SESSION_TTL_MS } from "../sessions";
import type { Env } from "../index";

export async function handleWebauthnAuthFinish(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{
    userId: string;
    challengeId: string;
    response: Record<string, unknown>;
    email: string;
  }>();

  if (!body.userId || !body.challengeId || !body.response || !body.email) {
    return errorResponse(Errors.BAD_REQUEST);
  }

  const user = await env.DB.prepare(
    "SELECT id, email, name, created_at, moderation, force_password_change, is_admin FROM users WHERE id = ? AND email = ?",
  )
    .bind(body.userId, normalizeEmail(body.email))
    .first<{ id: string; email: string; name: string; created_at: string; moderation: number; force_password_change: number; is_admin: number }>();
  if (!user) return errorResponse(Errors.UNAUTHORIZED);

  const moderationResponse = checkModeration(user.moderation);
  if (moderationResponse) return moderationResponse;

  const assertionError = await verifyWebauthnAssertion(env, body.userId, body.challengeId, body.response, "webauthn-auth-finish");
  if (assertionError) return assertionError;

  if (user.force_password_change) {
    // Same single-use nonce flow as /login - see that handler for context.
    const cti = crypto.randomUUID();
    await env.DB.prepare("UPDATE users SET change_token_id = ? WHERE id = ?")
      .bind(cti, user.id).run();
    const changeToken = await signJwt(
      { userId: user.id, email: user.email, expiresAt: Date.now() + 15 * 60 * 1000, isAdmin: Boolean(user.is_admin), forcePasswordChange: true, cti },
      env.JWT_SECRET,
    );
    return Response.json({ ok: false, error: "password_change_required", changeToken }, { status: 200 });
  }

  const expiresAt = Date.now() + SESSION_TTL_MS;
  const sid = await createSession(env, user.id, request, expiresAt);
  const token = await signJwt(
    { userId: user.id, email: user.email, expiresAt, isAdmin: Boolean(user.is_admin), sid },
    env.JWT_SECRET,
  );

  return okResponse({
    token,
    user: { id: user.id, email: user.email, name: user.name, createdAt: user.created_at },
  });
}
