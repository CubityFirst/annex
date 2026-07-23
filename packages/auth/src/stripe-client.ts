import Stripe from "stripe";
import type { Env } from "./index";

// Stripe SDK initialized for the Workers runtime. The default Node http
// client + crypto won't work even with nodejs_compat - we have to plug
// in fetch and SubtleCrypto explicitly.
let cached: Stripe | null = null;
let cachedKey: string | null = null;

export function getStripe(secretKey: string): Stripe {
  if (cached && cachedKey === secretKey) return cached;
  cached = new Stripe(secretKey, {
    httpClient: Stripe.createFetchHttpClient(),
  });
  cachedKey = secretKey;
  return cached;
}

export function getStripeWebhookCryptoProvider(): Stripe.CryptoProvider {
  return Stripe.createSubtleCryptoProvider();
}

// Best-effort: keep the Stripe customer's email in sync when the account email
// changes, so receipts/dunning mail follows the user. stripe_customer_id is the
// durable link - a failure here never blocks the email change itself.
export async function syncStripeCustomerEmail(env: Env, userId: string, newEmail: string): Promise<void> {
  if (!env.STRIPE_SECRET_KEY) return;
  try {
    const row = await env.DB.prepare(
      "SELECT stripe_customer_id FROM user_billing WHERE user_id = ?",
    ).bind(userId).first<{ stripe_customer_id: string | null }>();
    if (!row?.stripe_customer_id) return;
    await getStripe(env.STRIPE_SECRET_KEY).customers.update(row.stripe_customer_id, { email: newEmail });
  } catch (err) {
    console.error("syncStripeCustomerEmail failed", { userId, err });
  }
}
