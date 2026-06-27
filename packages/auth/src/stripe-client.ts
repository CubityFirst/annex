import Stripe from "stripe";

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
