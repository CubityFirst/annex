import { okResponse, normalizeEmail } from "../lib";
import { createVerificationToken } from "../verification";
import { sendVerificationEmail } from "../email";
import type { Env } from "../index";

export async function handleVerifyEmailResend(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{ email?: string }>();

  // Always return ok - don't leak whether an email exists or is already verified
  if (!body.email || typeof body.email !== "string") return okResponse({ sent: true });

  const email = normalizeEmail(body.email);

  const row = await env.DB.prepare(
    "SELECT id FROM users WHERE email = ? AND email_verified = 0",
  ).bind(email).first<{ id: string }>();

  if (row) {
    const token = await createVerificationToken(env, row.id);
    const verifyUrl = `${env.APP_ORIGIN}/verify-email?token=${token}`;
    await sendVerificationEmail(env, email, verifyUrl);
  }

  return okResponse({ sent: true });
}
