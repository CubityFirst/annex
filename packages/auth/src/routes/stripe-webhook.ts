import type Stripe from "stripe";
import { Errors, errorResponse } from "../lib";
import { getStripe, getStripeWebhookCryptoProvider } from "../stripe-client";
import type { Env } from "../index";

// POST /stripe/webhook
//
// Public endpoint, signature-verified. Bad-signature requests get 400.
// Logical no-ops (event references an unknown user, unsubscribed event
// type, etc.) are acknowledged with 200 - retrying won't help and the
// event is genuinely unprocessable. A *thrown* handler error returns 500
// so Stripe redelivers; transient failures (a D1 blip) must not be
// silently dropped.
//
// Idempotency: we record event.id in webhook_events only AFTER the
// handler succeeds, and skip early when that row already exists. Stripe
// replays events during outages: a replay after a successful handle is a
// no-op, while a replay after a FAILED handle still reprocesses because
// the marker was never written.
export async function handleStripeWebhook(request: Request, env: Env): Promise<Response> {
  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET) {
    console.error("Stripe webhook reached but STRIPE_SECRET_KEY or STRIPE_WEBHOOK_SECRET is unset");
    return errorResponse(Errors.INTERNAL);
  }

  const sig = request.headers.get("stripe-signature");
  if (!sig) return errorResponse(Errors.BAD_REQUEST);

  // MUST read raw body before any .json() - signature is over the bytes.
  const rawBody = await request.text();

  const stripe = getStripe(env.STRIPE_SECRET_KEY);
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      rawBody,
      sig,
      env.STRIPE_WEBHOOK_SECRET,
      undefined,
      getStripeWebhookCryptoProvider(),
    );
  } catch (err) {
    console.error("Stripe webhook signature verification failed:", err);
    return errorResponse(Errors.BAD_REQUEST);
  }

  // Idempotency: skip if we've already fully processed this event id.
  // The marker is written only after the handler succeeds (below), so a
  // failed attempt leaves no row and Stripe's redelivery reprocesses.
  const alreadyProcessed = await env.DB.prepare(
    "SELECT 1 FROM webhook_events WHERE event_id = ?",
  ).bind(event.id).first();
  if (alreadyProcessed) {
    return new Response("ok", { status: 200 });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed":
        await handleCheckoutCompleted(env, event.data.object as Stripe.Checkout.Session);
        break;
      case "customer.subscription.created":
      case "customer.subscription.updated":
        await handleSubscriptionUpsert(env, event.data.object as Stripe.Subscription);
        break;
      case "customer.subscription.deleted":
        await handleSubscriptionDeleted(env, event.data.object as Stripe.Subscription);
        break;
      case "invoice.payment_failed":
        await handleInvoicePaymentFailed(env, event.data.object as Stripe.Invoice);
        break;
      case "invoice.paid":
        await handleInvoicePaid(env, event.data.object as Stripe.Invoice);
        break;
      default:
        // Unsubscribed event types are fine - Stripe sends what it's
        // configured to send. Just acknowledge and move on.
        break;
    }
  } catch (err) {
    // Most handler failures are transient (a D1 hiccup, a brief blip).
    // We have NOT recorded this event as processed, so 500 and let Stripe
    // redeliver - the retry reprocesses cleanly. A deterministic handler
    // bug will retry uselessly for Stripe's retry window then give up,
    // which is still far better than silently and permanently dropping a
    // billing state change.
    console.error(`Stripe webhook handler for ${event.type} failed:`, err);
    return errorResponse(Errors.INTERNAL);
  }

  // Handler succeeded - record the event so any later replay is a no-op.
  await env.DB.prepare(
    "INSERT OR IGNORE INTO webhook_events (event_id, type, processed_at) VALUES (?, ?, ?)",
  ).bind(event.id, event.type, Date.now()).run();

  return new Response("ok", { status: 200 });
}

// checkout.session.completed: links the Stripe customer + subscription
// IDs to our user row. The actual plan flip happens on the subsequent
// customer.subscription.created event.
async function handleCheckoutCompleted(env: Env, sessionObj: Stripe.Checkout.Session): Promise<void> {
  const userId = sessionObj.client_reference_id;
  if (!userId) {
    console.warn("checkout.session.completed missing client_reference_id", sessionObj.id);
    return;
  }
  const customerId = typeof sessionObj.customer === "string" ? sessionObj.customer : sessionObj.customer?.id ?? null;
  const subscriptionId = typeof sessionObj.subscription === "string" ? sessionObj.subscription : sessionObj.subscription?.id ?? null;

  if (!customerId) return;

  // The two COALESCE clauses are intentionally asymmetric (preserved from
  // pre-split behavior, see migration 0023):
  //   - stripe_customer_id: prefer the EXISTING value. Once we've linked a
  //     customer, it should never get overwritten by a later checkout (e.g. a
  //     duplicate/replayed event), since a different customer id would
  //     orphan all subsequent invoice lookups.
  //   - stripe_subscription_id: prefer the INCOMING value. A new checkout
  //     means a new subscription; the old sub id (if any) is by definition
  //     stale at this point.
  await env.DB.prepare(
    `INSERT INTO user_billing (user_id, stripe_customer_id, stripe_subscription_id)
     VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       stripe_customer_id = COALESCE(user_billing.stripe_customer_id, excluded.stripe_customer_id),
       stripe_subscription_id = COALESCE(excluded.stripe_subscription_id, user_billing.stripe_subscription_id)`,
  ).bind(userId, customerId, subscriptionId).run();
}

// customer.subscription.created/updated: source of truth for plan,
// status, and period end. We resolve the user by metadata.userId
// (stamped during Checkout) so this works even if it arrives before
// checkout.session.completed.
async function handleSubscriptionUpsert(env: Env, sub: Stripe.Subscription): Promise<void> {
  const userId = sub.metadata?.userId;
  if (!userId) {
    console.warn("subscription event missing metadata.userId", sub.id);
    return;
  }

  // Bind the Ink grant to the actual product purchased. Without this, ANY
  // priced subscription carrying metadata.userId (a future second product, a
  // sub created out-of-band on a different price) would flip the user to Ink.
  // Only the configured Ink price grants the plan. (A promo/100%-off code on
  // the Ink price itself still counts - that's a legitimate Ink subscription.)
  const inkPriceId = env.STRIPE_INK_PRICE_ID;
  if (inkPriceId && !sub.items.data.some(item => item.price?.id === inkPriceId)) {
    console.warn(`subscription ${sub.id} for user ${userId} is not the Ink price; not granting Ink`);
    return;
  }

  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
  // Stripe moved current_period_end from the subscription to per-item in
  // newer api versions. Try both - older SDK type defs still expose it
  // on Subscription, newer payloads only have it on items.
  const periodEnd =
    (sub as unknown as { current_period_end?: number }).current_period_end
    ?? (sub.items.data[0] as unknown as { current_period_end?: number } | undefined)?.current_period_end
    ?? null;
  const status = sub.status;
  const plan = "ink";
  const now = Date.now();

  // sub.cancel_at is populated when the user has scheduled a
  // cancel-at-period-end via Customer Portal; null when not pending or
  // when they've resumed. Status remains 'active' until Stripe actually
  // transitions to canceled (which fires subscription.deleted).
  const cancelAt = sub.cancel_at ? sub.cancel_at * 1000 : null;

  // Only set personal_plan_started_at if it's not already populated -
  // preserves the original supporter date across cancel/resub cycles.
  await env.DB.prepare(
    `INSERT INTO user_billing (
       user_id, stripe_customer_id, stripe_subscription_id,
       personal_plan, personal_plan_status, personal_period_end,
       personal_plan_cancel_at, personal_plan_started_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       stripe_customer_id = excluded.stripe_customer_id,
       stripe_subscription_id = excluded.stripe_subscription_id,
       personal_plan = excluded.personal_plan,
       personal_plan_status = excluded.personal_plan_status,
       personal_period_end = excluded.personal_period_end,
       personal_plan_cancel_at = excluded.personal_plan_cancel_at,
       personal_plan_started_at = COALESCE(user_billing.personal_plan_started_at, excluded.personal_plan_started_at)`,
  ).bind(
    userId,
    customerId,
    sub.id,
    plan,
    status,
    periodEnd ? periodEnd * 1000 : null,
    cancelAt,
    now,
  ).run();
}

// customer.subscription.deleted: clear plan + status. Keep
// stripe_customer_id and personal_plan_started_at so a resubscribe
// preserves the supporter-since date.
async function handleSubscriptionDeleted(env: Env, sub: Stripe.Subscription): Promise<void> {
  const userId = sub.metadata?.userId;
  if (!userId) return;

  await env.DB.prepare(
    `UPDATE user_billing
     SET personal_plan = NULL,
         personal_plan_status = 'canceled',
         personal_period_end = NULL,
         personal_plan_cancel_at = NULL,
         stripe_subscription_id = NULL
     WHERE user_id = ?`,
  ).bind(userId).run();
}

// invoice.payment_failed: flip status to past_due. The plan resolver
// keeps perks active during past_due so users get a grace period; the
// frontend banners them to update their payment method.
async function handleInvoicePaymentFailed(env: Env, invoice: Stripe.Invoice): Promise<void> {
  const subscriptionId = extractSubscriptionId(invoice);
  if (!subscriptionId) return;

  await env.DB.prepare(
    `UPDATE user_billing
     SET personal_plan_status = 'past_due'
     WHERE stripe_subscription_id = ?`,
  ).bind(subscriptionId).run();
}

// invoice.paid: confirm active status and refresh period_end. This is
// also the renewal heartbeat - fired every billing cycle on success.
async function handleInvoicePaid(env: Env, invoice: Stripe.Invoice): Promise<void> {
  const subscriptionId = extractSubscriptionId(invoice);
  if (!subscriptionId) return;

  // invoice.lines exposes the period the invoice covers; the latest
  // line's period.end is the new period_end.
  const lastPeriodEnd = invoice.lines.data
    .map(l => l.period?.end ?? 0)
    .reduce((a, b) => Math.max(a, b), 0);

  await env.DB.prepare(
    `UPDATE user_billing
     SET personal_plan_status = 'active',
         personal_period_end = ?
     WHERE stripe_subscription_id = ?`,
  ).bind(lastPeriodEnd ? lastPeriodEnd * 1000 : null, subscriptionId).run();
}

// Stripe types put `subscription` in different places across Invoice
// shapes / api versions; this normalizes it to a string id or null.
function extractSubscriptionId(invoice: Stripe.Invoice): string | null {
  const direct = (invoice as unknown as { subscription?: string | { id: string } | null }).subscription;
  if (typeof direct === "string") return direct;
  if (direct && typeof direct === "object" && "id" in direct) return direct.id;

  // Newer api versions may put it on the parent.subscription_details:
  const parent = (invoice as unknown as { parent?: { subscription_details?: { subscription?: string | { id: string } } } }).parent;
  const fromParent = parent?.subscription_details?.subscription;
  if (typeof fromParent === "string") return fromParent;
  if (fromParent && typeof fromParent === "object" && "id" in fromParent) return fromParent.id;

  return null;
}
