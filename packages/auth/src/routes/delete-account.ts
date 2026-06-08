import { requireAuthenticatedSession } from "../auth-session";
import { okResponse, errorResponse, Errors, rateLimitUser } from "../lib";
import { verifyPassword } from "../password";
import { requireMFA } from "../mfa";
import { getStripe } from "../stripe-client";
import type { Env } from "../index";

export async function handleDeleteAccount(request: Request, env: Env): Promise<Response> {
  const session = await requireAuthenticatedSession(request, env);
  if (session instanceof Response) return session;

  const body = await request.json<{
    currentPassword?: string;
    totpCode?: string;
    challengeId?: string;
    webauthnResponse?: unknown;
    backupCode?: string;
  }>();

  // Step-up re-auth for an irreversible, cascading delete. requireMFA below is a
  // no-op for accounts without TOTP/WebAuthn, so without this gate a single
  // stolen session could destroy an MFA-less account. Mirror change-password and
  // demand the current password regardless of MFA state.
  if (!body.currentPassword) return errorResponse(Errors.BAD_REQUEST);

  const limited = await rateLimitUser(env.RATE_LIMITER_AUTH, `delete-account:${session.userId}`);
  if (limited) return limited;

  const user = await env.DB.prepare(
    "SELECT password_hash FROM users WHERE id = ?",
  ).bind(session.userId).first<{ password_hash: string }>();
  if (!user) return errorResponse(Errors.NOT_FOUND);

  const valid = await verifyPassword(body.currentPassword, user.password_hash);
  if (!valid) return errorResponse(Errors.UNAUTHORIZED);

  const mfaError = await requireMFA(env, session.userId, {
    totpCode: body.totpCode,
    challengeId: body.challengeId,
    webauthnResponse: body.webauthnResponse,
    backupCode: body.backupCode,
  });
  if (mfaError) return mfaError;

  // If the user has a Stripe customer, delete it before removing their
  // row. Deleting a customer auto-cancels every active subscription on
  // it, so this single call handles both the cancel and the GDPR-ish
  // cleanup of customer-side personal data (email, payment methods).
  // We swallow Stripe failures rather than block account deletion —
  // worst case is an orphan customer in Stripe that the user can't
  // reach. If STRIPE_SECRET_KEY isn't set we skip the call entirely
  // (e.g. in environments where billing isn't configured).
  if (env.STRIPE_SECRET_KEY) {
    const billingRow = await env.DB.prepare(
      "SELECT stripe_customer_id FROM user_billing WHERE user_id = ?",
    ).bind(session.userId).first<{ stripe_customer_id: string | null }>();

    if (billingRow?.stripe_customer_id) {
      try {
        const stripe = getStripe(env.STRIPE_SECRET_KEY);
        await stripe.customers.del(billingRow.stripe_customer_id);
      } catch (err) {
        console.error("Stripe customer delete during account deletion failed:", err);
      }
    }
  }

  await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(session.userId).run();

  return okResponse({});
}
