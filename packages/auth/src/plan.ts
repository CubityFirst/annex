// Per-user plan resolution. Three sources of truth, in priority order:
//
//   1. granted_plan (set via wrangler one-liner for comps) - wins if it
//      either has no expiry or hasn't expired yet
//   2. personal_plan (Stripe-managed) - active when status is one of
//      active|trialing|past_due (past_due gets a grace period; the UI
//      shows a banner but the perks stay on)
//   3. free
//
// Keep this a pure function so the api worker can import it via the
// same cross-package path it already uses for loadCurrentSession.

export type PersonalPlan = "free" | "ink";

// Allowed ring style ids. Default ('shimmer') is what every supporter gets
// before customising; null on the row means "use the default". 'none'
// opts out of the animated ring entirely. Adding a new style: append the
// id here, add a CSS variant in ink-border.css, and add it to
// INK_PRESENCE_RING_STYLES below.
export const INK_RING_STYLES = ["shimmer", "aurora", "ember", "mono", "none"] as const;
export type InkRingStyle = typeof INK_RING_STYLES[number];

export function isInkRingStyle(value: unknown): value is InkRingStyle {
  return typeof value === "string" && (INK_RING_STYLES as readonly string[]).includes(value);
}

// Strict #rrggbb. We render the colour straight into a CSS box-shadow /
// caret-color, so we lock the input down to a known-safe shape.
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
export function isInkPresenceColor(value: unknown): value is string {
  return typeof value === "string" && HEX_COLOR.test(value);
}

export type PlanRow = {
  granted_plan: string | null;
  granted_plan_expires_at: number | null;
  granted_plan_started_at: number | null;
  personal_plan: string | null;
  personal_plan_status: string | null;
  personal_plan_started_at: number | null;
  personal_plan_cancel_at: number | null;
  personal_plan_style: string | null;
  personal_presence_color: string | null;
  personal_crit_sparkles: number | null;
};

export type ResolvedPlan = {
  plan: PersonalPlan;
  via: "granted" | "paid" | "free";
  since: number | null;
  status: string | null;
  // When non-null, the active sub has been set to cancel and access
  // ends at this Unix-ms timestamp. Stays in 'active' status until
  // then; UI uses this to show "expires on X".
  cancelAt: null | number;
  // Cosmetic prefs. null on a free user (no Ink → no perks); for an Ink
  // user, null means "use the default" (style: 'shimmer', presence colour:
  // deterministic from userColor()). Persisted values that fail validation
  // are normalised to null here so callers don't have to re-validate.
  style: InkRingStyle | null;
  presenceColor: string | null;
  // Whether to render the dice crit sparkle burst for this user. Ink-only
  // perk: false for free users. For Ink users, NULL on the row means "use
  // the default" which is true; an explicit 0 turns it off.
  critSparkles: boolean;
};

const ACTIVE_STATUSES = new Set(["active", "trialing", "past_due"]);

function asPlan(value: string | null): PersonalPlan {
  return value === "ink" ? "ink" : "free";
}

function readStyle(row: PlanRow): InkRingStyle | null {
  return isInkRingStyle(row.personal_plan_style) ? row.personal_plan_style : null;
}

function readPresenceColor(row: PlanRow): string | null {
  return isInkPresenceColor(row.personal_presence_color) ? row.personal_presence_color : null;
}

// NULL → default (on); explicit 0 → off; anything else → on.
function readCritSparkles(row: PlanRow): boolean {
  return row.personal_crit_sparkles !== 0;
}

export function resolvePersonalPlan(row: PlanRow, now: number = Date.now()): ResolvedPlan {
  if (row.granted_plan && (row.granted_plan_expires_at === null || row.granted_plan_expires_at > now)) {
    return {
      plan: asPlan(row.granted_plan),
      via: "granted",
      since: row.granted_plan_started_at,
      status: "granted",
      cancelAt: null,
      style: readStyle(row),
      presenceColor: readPresenceColor(row),
      critSparkles: readCritSparkles(row),
    };
  }

  if (row.personal_plan && row.personal_plan_status && ACTIVE_STATUSES.has(row.personal_plan_status)) {
    return {
      plan: asPlan(row.personal_plan),
      via: "paid",
      since: row.personal_plan_started_at,
      status: row.personal_plan_status,
      cancelAt: row.personal_plan_cancel_at,
      style: readStyle(row),
      presenceColor: readPresenceColor(row),
      critSparkles: readCritSparkles(row),
    };
  }

  return { plan: "free", via: "free", since: null, status: null, cancelAt: null, style: null, presenceColor: null, critSparkles: false };
}
