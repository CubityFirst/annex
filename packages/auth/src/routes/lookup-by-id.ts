import { okResponse, errorResponse, Errors } from "../lib";
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

  const emailVerificationEnabled = env.FLAGS
    ? await env.FLAGS.getBooleanValue("email-verification", false, { userId: user.id })
    : false;
  return okResponse({ userId: user.id, email: user.email, name: user.name, emailVerified: user.email_verified === 1, emailVerificationEnabled, createdAt: user.created_at, timezone: user.timezone, badges: user.badges ?? 0, bio: user.bio });
}
