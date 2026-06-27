# Annex Ink + Stripe Integration

The Annex Ink personal supporter subscription, its Stripe billing integration, and admin controls. Read this before touching anything in `billing.ts`, `stripe-webhook.ts`, the `user_billing` table, the cosmetic-pref columns on `user_preferences`, the billing section of `UserSettingsPage.tsx`, or `InkBillingCard` in the admin panel.

## What it is

**Annex Ink** is a per-user $5/mo supporter tier (separate from any per-workspace plan). Cosmetic-only perks for v1:

- Animated conic-gradient "shiny" ring around the user's avatar (`packages/frontend/src/styles/ink-border.css`, applied via `UserAvatar`'s `personalPlan` prop). Supporters can pick between ring variants via `personalPlanStyle` (`shimmer` default | `aurora` | `ember` | `mono` | `none` to disable the ring entirely).
- "Supporter since {Xth of Month, Year}" tenure flag in `UserSettingsPage` billing card and `UserProfileCard` tooltip
- Animated rainbow Sparkles icon next to the user's name on the profile card
- Custom presence colour for collab cursors. Free users get a deterministic per-user HSL from `userColor()`; supporters can override it via `personalPresenceColor` and the picked colour is broadcast through Yjs awareness to other clients.
- Sparkle burst on dice critical successes - a short animated burst of `lucide` Sparkles emitted by `DiceRoll` when the rolled total hits the max possible total or a `cs` condition succeeds. Gated by the *viewer* being Ink (not the doc author), threaded through `RendererCtx.showInkCritSparkles` from `DocPage` / `DocsLayout`. Supporters can opt out via the `personalCritSparkles` toggle in user settings (default on). Keyframes/colour variants in `ink-border.css` (`.ink-crit-sparkles`, `.ink-crit-sparkle-1..5`).

Free users render with a deterministic per-user color ring in collab presence (`EditorPresence.tsx`); Ink supporters render with the animated ring **instead** (the two are mutually exclusive - see `EditorPresence.PresenceAvatar`).

## Schema

Ink state is split across two 1:1 satellite tables on the **auth DB**, both keyed by `user_id` with `ON DELETE CASCADE` back to `users`. A row in either satellite only exists once the user has interacted with that feature - reads everywhere use `LEFT JOIN`, NULL = "default / not set / free user."

Migrations: `0014_add_stripe_columns.sql` (initial billing columns on users), `0015_add_personal_plan_cancel_at.sql` (pending-cancellation tracking), `0016_add_granted_plan_started_at.sql` (grant tenure), `0018_add_ink_cosmetic_prefs.sql` (ring style + presence colour), `0022_add_personal_crit_sparkles.sql` (dice crit sparkle toggle), `0023_split_user_billing.sql` (moved Stripe/plan columns off `users`), `0024_split_user_preferences.sql` (moved cosmetic prefs + fonts + timezone + bio + badges off `users`).

### `user_billing` - Stripe / plan state

Indexed on `stripe_subscription_id` for the `invoice.paid` / `invoice.payment_failed` webhook lookups.

- `stripe_customer_id`, `stripe_subscription_id` - set by `checkout.session.completed` and `subscription.created` webhooks
- `personal_plan` - `'ink'` when active via Stripe, NULL otherwise
- `personal_plan_status` - `active | trialing | past_due | canceled | unpaid | incomplete | incomplete_expired`
- `personal_period_end` - Unix ms; current billing cycle's end
- `personal_plan_started_at` - Unix ms; **preserved across cancel/resub cycles** so "supporter since" reflects the original date (uses `COALESCE` in the upsert)
- `personal_plan_cancel_at` - Unix ms; non-null when `cancel_at_period_end=true` is set on the Stripe sub. UI surfaces this as "Cancels on X."
- `granted_plan`, `granted_plan_expires_at`, `granted_plan_reason`, `granted_plan_started_at` - manual override (admin grants). Takes precedence over Stripe-managed plan.

### `user_preferences` - cosmetic prefs + general user state (Ink-relevant columns only listed here)

- `personal_plan_style` - chosen ring variant (`shimmer` default | `aurora` | `ember` | `mono` | `none`). NULL = default (shimmer). `none` opts out of the ring. Allowed list lives in `INK_RING_STYLES` in `plan.ts`.
- `personal_presence_color` - supporter override for the deterministic per-user collab cursor colour. Strict `#rrggbb`. NULL = use `userColor()`. Validated server-side; the colour is rendered into a CSS box-shadow / caret-color so the format is locked down.
- `personal_crit_sparkles` - INTEGER tri-state for the dice crit sparkle burst. NULL = "use default" (on), `1` = explicit on, `0` = off. The resolver normalises to a `critSparkles: boolean` and **forces it false for non-Ink users** so a free user with a stale `1` from a lapsed sub doesn't keep the perk.

The table also holds `reading_font`, `editing_font`, `ui_font`, `timezone`, `bio`, `badges` - not Ink-specific but lives on the same satellite. Writes use upserts like `INSERT INTO user_preferences (user_id, <col>) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET <col> = excluded.<col>`. Multi-column writes (`update-ink-prefs.ts`, `update-reading-font.ts`) build the column / placeholder / update lists dynamically.

Plus `webhook_events (event_id PRIMARY KEY, type, processed_at)` for idempotency.

## Plan resolution

**Always go through `resolvePersonalPlan` in `packages/auth/src/plan.ts`.** Never read the columns directly to determine plan state. The resolver is a pure function with this precedence:

1. `granted_plan` set AND (`granted_plan_expires_at` is NULL OR in the future) → `via: 'granted'`, `status: 'granted'`
2. `personal_plan` set AND `personal_plan_status` ∈ `{active, trialing, past_due}` → `via: 'paid'`
3. otherwise → `via: 'free'`

Returns `{ plan, via, since, status, cancelAt, style, presenceColor, critSparkles }`. `since` comes from `personal_plan_started_at` for paid and from `granted_plan_started_at` for granted (added in migration 0016 - older grants pre-dating that column will still be null). `past_due` keeps perks active during Stripe's smart-retry grace; UI surfaces a banner. Cosmetic prefs (`style`, `presenceColor`, `critSparkles`) are normalised by the resolver - invalid persisted values become null/default, and for free users `critSparkles` is forced false regardless of the column value.

The resolver's input row mixes columns from BOTH satellite tables (`personal_plan_*` / `granted_plan_*` from `user_billing`, cosmetic prefs from `user_preferences`). Every caller builds a flat `PlanRow` by LEFT-JOINing both satellites onto `users` and aliasing the columns through unchanged - see `loadCurrentSession` (`session.ts`), `loadMemberPlans` (`members.ts`), `update-bio.ts`, `update-ink-prefs.ts`, the API `/users/:id` handler, and admin `loadUserDetails` for examples. Each consumer's `tsconfig.json` includes `../auth/src/plan.ts` in its `include` array.

## Cross-package consideration

The API worker reads `users`, `user_billing`, and `user_preferences` directly via the `AUTH_DB` binding (read-only by convention) for `loadCurrentSession`, member-list plan info, and `/users/:id` profile responses. The admin worker also reads them for the user details panel.

**A schema change to any column the resolver touches requires redeploying auth + api + admin** in that order, AND every reader must continue to use LEFT JOIN so older code transitioning to a missing-satellite world still behaves. The migrations live in `packages/auth/migrations/` only.

## Stripe webhook flow

`packages/auth/src/routes/stripe-webhook.ts`. Public endpoint, signature-verified. Reached via `https://docs.cubityfir.st/stripe/webhook` - the frontend worker proxies `/stripe/webhook` to auth via service binding (see `packages/frontend/worker/index.ts`). Stripe doesn't see the auth worker directly because it has no public hostname.

Handler contract (load-bearing):

- **Raw body first** - must `await request.text()` before any `.json()`. Signature is over the bytes; the frontend proxy passes the request unchanged so this works through the hop.
- **Idempotency** - `INSERT OR IGNORE INTO webhook_events VALUES (event_id, ...)` first; if `meta.changes === 0`, return 200 immediately (already handled). To force a reprocess after a code fix, manually `DELETE FROM webhook_events WHERE event_id = '...'`.
- **Always 200 on handler errors** - caught exceptions are logged and we still return 200. Rationale: Stripe's retry won't fix a code bug, so 500'ing creates noise. Bad signatures still return 400 (those *should* be retried by Stripe, then dropped).
- **userId resolution** - `checkout.session.completed` uses `client_reference_id`. All `customer.subscription.*` events use `metadata.userId`, which is stamped on the subscription via `subscription_data: { metadata: { userId } }` in `billing.ts`'s Checkout creation. **A subscription created before that line was deployed has empty metadata** and the webhook handler will silently no-op - fix by manually adding `userId` metadata in the Stripe Dashboard, then resending the event (after clearing webhook_events).
- **invoice.* events** look up the user by `stripe_subscription_id` in our DB, since invoices don't carry metadata.

## Admin panel

`packages/admin/frontend/src/pages/UsersPage.tsx` (search "InkBillingCard"). For any user, admin can:

- **Grant Ink** - sets `granted_plan='ink'` with reason + duration (Forever / 30 days / 1 year). Optionally checkbox "Also cancel their paid Stripe subscription" - calls Stripe `POST /v1/subscriptions/:id` with `cancel_at_period_end=true` so they stop being billed (the grant keeps them on Ink).
- **Revoke grant** - clears the override columns. Doesn't touch Stripe-managed plan.
- **Cancel paid subscription** - direct Stripe API call. Two modes: at-period-end (recommended) or immediate. The webhook fires asynchronously and updates the row via the existing handler; admin endpoint never writes to the DB directly.

Admin worker calls Stripe REST directly with its own `STRIPE_SECRET_KEY` (set per-environment). No service-binding hop to auth - keeps the cancel-on-grant path on a single worker.

## Local dev setup

`.dev.vars` files (gitignored) hold local secrets:

- `packages/auth/.dev.vars` needs `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_INK_PRICE_ID`, `APP_ORIGIN=http://localhost:5173`
- `packages/admin/.dev.vars` needs `STRIPE_SECRET_KEY` only

Forward Stripe webhook events to the local auth worker:

```
stripe listen --forward-to http://localhost:8788/stripe/webhook
```

The CLI prints a `whsec_...` at startup - that's what goes in `STRIPE_WEBHOOK_SECRET` for local dev. (Live mode uses a different `whsec_` from the registered webhook in Stripe Dashboard.) Restart the auth worker after editing `.dev.vars` - wrangler only reads it on startup.

## Production setup

- `STRIPE_INK_PRICE_ID` is in `packages/auth/wrangler.toml` `[vars]` (live price id - committed). `.dev.vars` overrides locally to the test-mode price id.
- `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` set via `wrangler secret put` on the auth worker. `STRIPE_SECRET_KEY` also on admin worker.
- Webhook endpoint URL in Stripe Dashboard: `https://docs.cubityfir.st/stripe/webhook`. Subscribed events: `checkout.session.completed`, `customer.subscription.created/updated/deleted`, `invoice.paid`, `invoice.payment_failed`.
- Customer Portal must be configured separately in **live** mode (Settings → Billing → Customer portal). Test mode and live mode have different portal configs.

## Operations cheatsheet

All Stripe / plan state writes target `user_billing`. Use an upsert so users without an existing row get one created:

```sql
-- Comp a user without going through Stripe (admin panel does this with reason auto-set)
INSERT INTO user_billing (user_id, granted_plan, granted_plan_reason, granted_plan_started_at)
SELECT id, 'ink', 'early supporter', strftime('%s', 'now') * 1000
FROM users WHERE email='friend@example.com'
ON CONFLICT(user_id) DO UPDATE SET
  granted_plan = excluded.granted_plan,
  granted_plan_reason = excluded.granted_plan_reason,
  granted_plan_started_at = COALESCE(user_billing.granted_plan_started_at, excluded.granted_plan_started_at);

-- Force-process a stuck webhook after fixing a bug
DELETE FROM webhook_events WHERE event_id='evt_...';
-- then resend the event from Stripe Dashboard

-- Reset a user fully back to free (testing) - just delete the satellite row.
-- CASCADE wipes it automatically if you delete the user; otherwise:
DELETE FROM user_billing WHERE user_id = (SELECT id FROM users WHERE email='you@example.com');
```

The "force" path is rarely needed - the always-200 webhook policy means failed events stay in `webhook_events` and need manual clearing to re-attempt. By design.

## Stripe customer emails

Test mode: nothing is ever emailed.
Live mode: defaults to receipts on, invoice emails off - toggle at https://dashboard.stripe.com/settings/emails. Admin-driven cancellations don't trigger Stripe's user-facing cancellation email by default; if you want users notified, enable that toggle or send your own email.
