import { okResponse, errorResponse, Errors, type Session } from "../lib";
import { getStripe } from "../account/stripe-client";

// What the billing routes and the Stripe webhook need from the API worker's
// Env. Billing moved here from the retired auth worker with the identity
// split; Stripe customers are still keyed by Annex user id.
export interface BillingEnv {
  DB: D1Database;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_INK_PRICE_ID?: string;
  APP_ORIGIN?: string;
}

function appOrigin(env: BillingEnv): string {
  return (env.APP_ORIGIN ?? "https://docs.cubityfir.st").replace(/\/+$/, "");
}

interface UserBillingRow {
  email: string;
  name: string;
  stripe_customer_id: string | null;
}

// POST /billing/checkout
// Creates a Stripe Checkout Session for the Annex Ink subscription and
// returns the redirect URL. The browser navigates to it; on success
// Stripe sends us back to /settings#billing and the webhook fires
// checkout.session.completed which links the customer + sub to the user.
export async function handleBillingCheckout(env: BillingEnv, session: Session): Promise<Response> {
  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_INK_PRICE_ID) {
    return errorResponse(Errors.INTERNAL);
  }

  const user = await env.DB.prepare(
    `SELECT u.email, u.name, b.stripe_customer_id
     FROM users u
     LEFT JOIN user_billing b ON b.user_id = u.id
     WHERE u.id = ?`,
  ).bind(session.userId).first<UserBillingRow>();
  if (!user) return errorResponse(Errors.NOT_FOUND);

  const stripe = getStripe(env.STRIPE_SECRET_KEY);
  const returnUrl = `${appOrigin(env)}/settings#billing`;

  // Reuse an existing customer when we have one (resub case); otherwise
  // let Checkout create a new customer and we'll link it on webhook.
  const customerArgs = user.stripe_customer_id
    ? { customer: user.stripe_customer_id }
    : { customer_email: user.email };

  const checkout = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: env.STRIPE_INK_PRICE_ID, quantity: 1 }],
    client_reference_id: session.userId,
    // Stripe doesn't guarantee event ordering. Stamping userId into the
    // subscription metadata means every customer.subscription.* event
    // can resolve back to a user even if checkout.session.completed
    // hasn't been processed yet.
    subscription_data: { metadata: { userId: session.userId } },
    success_url: returnUrl,
    cancel_url: returnUrl,
    allow_promotion_codes: true,
    ...customerArgs,
  });

  if (!checkout.url) return errorResponse(Errors.INTERNAL);
  return okResponse({ url: checkout.url });
}

// POST /billing/portal
// Creates a Stripe Customer Portal session so the user can manage their
// subscription (update card, cancel, view invoices). Requires that we've
// already linked a stripe_customer_id - i.e. they've completed at least
// one Checkout. Free users get a 400.
export async function handleBillingPortal(env: BillingEnv, session: Session): Promise<Response> {
  if (!env.STRIPE_SECRET_KEY) return errorResponse(Errors.INTERNAL);

  const user = await env.DB.prepare(
    "SELECT stripe_customer_id FROM user_billing WHERE user_id = ?",
  ).bind(session.userId).first<{ stripe_customer_id: string | null }>();
  if (!user?.stripe_customer_id) return errorResponse(Errors.BAD_REQUEST);

  const stripe = getStripe(env.STRIPE_SECRET_KEY);
  const portal = await stripe.billingPortal.sessions.create({
    customer: user.stripe_customer_id,
    return_url: `${appOrigin(env)}/settings#billing`,
  });

  return okResponse({ url: portal.url });
}
