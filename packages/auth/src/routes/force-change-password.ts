import zxcvbn from "zxcvbn";
import { okResponse, errorResponse, Errors } from "../lib";
import { hashPassword } from "../password";
import { signJwt, verifyJwt } from "../jwt";
import { createSession, revokeAllSessions, SESSION_TTL_MS } from "../sessions";
import type { Env } from "../index";

export async function handleForceChangePassword(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{
    changeToken: string;
    newPassword: string;
  }>();

  if (!body.changeToken || !body.newPassword) {
    return errorResponse(Errors.BAD_REQUEST);
  }

  const session = await verifyJwt(body.changeToken, env.JWT_SECRET);
  if (!session || !session.forcePasswordChange || !session.cti) {
    return errorResponse(Errors.UNAUTHORIZED);
  }

  if (zxcvbn(body.newPassword).score < 3) {
    return Response.json({ ok: false, error: "password_too_weak" }, { status: 400 });
  }

  const user = await env.DB.prepare(
    "SELECT id, email, name, created_at, is_admin FROM users WHERE id = ? AND force_password_change = 1",
  ).bind(session.userId).first<{ id: string; email: string; name: string; created_at: string; is_admin: number }>();
  if (!user) return errorResponse(Errors.NOT_FOUND);

  // Single statement performs the consume: matches `change_token_id` to the
  // JWT's `cti` claim, writes the new hash, clears the flag, and clears the
  // nonce - atomically. If 0 rows change, the token was either never the
  // current one, or has already been consumed by a concurrent request.
  const newHash = await hashPassword(body.newPassword);
  const updateResult = await env.DB.prepare(
    "UPDATE users SET password_hash = ?, force_password_change = 0, change_token_id = NULL WHERE id = ? AND force_password_change = 1 AND change_token_id = ?",
  ).bind(newHash, user.id, session.cti).run();
  if ((updateResult.meta.changes ?? 0) !== 1) {
    return errorResponse(Errors.UNAUTHORIZED);
  }

  // The forced-reset path is for "your password was leaked / your account
  // is compromised" scenarios - kill every existing session, no exceptions.
  await revokeAllSessions(env, user.id);

  const expiresAt = Date.now() + SESSION_TTL_MS;
  const sid = await createSession(env, user.id, request, expiresAt);
  const token = await signJwt(
    { userId: user.id, email: user.email, expiresAt, isAdmin: Boolean(user.is_admin), sid },
    env.JWT_SECRET,
  );

  return okResponse({ token, user: { id: user.id, email: user.email, name: user.name, createdAt: user.created_at } });
}
