import { okResponse, errorResponse, Errors } from "../lib";
import { isEmailVerificationEnabled } from "../verification";
import type { Env } from "../index";

export async function handleLookupById(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{ userId?: string }>();
  if (!body.userId) return errorResponse(Errors.BAD_REQUEST);

  const user = await env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.email_verified, u.created_at,
            p.timezone, p.badges, p.bio
     FROM users u
     LEFT JOIN user_preferences p ON p.user_id = u.id
     WHERE u.id = ?`,
  ).bind(body.userId).first<{ id: string; email: string; name: string; email_verified: number; created_at: string; timezone: string | null; badges: number | null; bio: string | null }>();

  if (!user) return errorResponse(Errors.NOT_FOUND);

  const emailVerificationEnabled = await isEmailVerificationEnabled(env, user.id);

  // In-flight email change (confirm-first flow): the newest unconsumed,
  // unexpired change token's target address, or null.
  const pending = await env.DB.prepare(
    "SELECT email FROM email_verification_tokens WHERE user_id = ? AND email IS NOT NULL AND consumed_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 1",
  ).bind(user.id, Date.now()).first<{ email: string }>();

  return okResponse({ userId: user.id, email: user.email, name: user.name, emailVerified: user.email_verified === 1, emailVerificationEnabled, pendingEmail: pending?.email ?? null, createdAt: user.created_at, timezone: user.timezone, badges: user.badges ?? 0, bio: user.bio });
}
