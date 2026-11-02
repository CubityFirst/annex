import { okResponse, errorResponse, Errors } from "../lib";
import { isEmailVerificationEnabled } from "../verification";
import type { Env } from "../index";

type LookupUserRow = {
  id: string;
  email: string;
  name: string;
  email_verified: number;
  created_at: string;
  timezone: string | null;
  badges: number | null;
  bio: string | null;
  handle: string | null;
  handle_locked: number | null;
};

export async function handleLookupById(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{ userId?: string }>();
  if (!body.userId) return errorResponse(Errors.BAD_REQUEST);

  // One round trip for both reads. The pending-email query binds the
  // requested id directly; it matches `u.id = ?` exactly, so for an unknown
  // user it simply returns no row and we 404 below.
  const [userResult, pendingResult] = await env.DB.batch([
    env.DB.prepare(
      `SELECT u.id, u.email, u.name, u.email_verified, u.created_at,
              p.timezone, p.badges, p.bio, p.handle, p.handle_locked
       FROM users u
       LEFT JOIN user_preferences p ON p.user_id = u.id
       WHERE u.id = ?`,
    ).bind(body.userId),
    // In-flight email change (confirm-first flow): the newest unconsumed,
    // unexpired change token's target address, or null.
    env.DB.prepare(
      "SELECT email FROM email_verification_tokens WHERE user_id = ? AND email IS NOT NULL AND consumed_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 1",
    ).bind(body.userId, Date.now()),
  ]);

  const user = (userResult.results as LookupUserRow[])[0];
  if (!user) return errorResponse(Errors.NOT_FOUND);
  const pending = (pendingResult.results as { email: string }[])[0];

  const emailVerificationEnabled = await isEmailVerificationEnabled(env, user.id);

  return okResponse({ userId: user.id, email: user.email, name: user.name, emailVerified: user.email_verified === 1, emailVerificationEnabled, pendingEmail: pending?.email ?? null, createdAt: user.created_at, timezone: user.timezone, badges: user.badges ?? 0, bio: user.bio, handle: user.handle ?? null, handleLocked: !!user.handle_locked });
}
