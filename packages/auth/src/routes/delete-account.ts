import { requireAuthenticatedSession } from "../auth-session";
import { okResponse } from "../lib";
import { requireMFA } from "../mfa";
import { getStripe } from "../stripe-client";
import type { Env } from "../index";

export async function handleDeleteAccount(request: Request, env: Env): Promise<Response> {
  const session = await requireAuthenticatedSession(request, env);
  if (session instanceof Response) return session;

  const body = await request.json<{
    totpCode?: string;
    challengeId?: string;
    webauthnResponse?: unknown;
    backupCode?: string;
  }>();

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
  // We swallow Stripe failures rather than block account deletion -
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
