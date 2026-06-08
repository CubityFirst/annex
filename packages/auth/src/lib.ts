export interface Session {
  userId: string;
  email: string;
  expiresAt: number;
  isAdmin?: boolean;
  forcePasswordChange?: true;
  // Server-side session row id. Required for normal sessions; absent on
  // the short-lived "force password change" token.
  sid?: string;
  // Force-change-token nonce. Set only on `forcePasswordChange: true`
  // tokens; mirrored on `users.change_token_id`. Re-issuing the token
  // overwrites the row, invalidating any prior unused token.
  cti?: string;
  // Resolved per-user plan, computed by resolvePersonalPlan() when the
  // session is loaded. Optional so JWT-only consumers (no DB hit) and
  // the api worker's filtered session don't need to populate them.
  personalPlan?: "free" | "ink";
  personalPlanSince?: number | null;
  personalPlanStatus?: string | null;
  personalPlanCancelAt?: number | null;
  personalPlanStyle?: string | null;
  personalPresenceColor?: string | null;
  personalCritSparkles?: boolean;
  // User-picked prose fonts for reading vs editing modes. NULL means the
  // frontend falls back to the default sans stack. Not gated on plan.
  readingFont?: string | null;
  editingFont?: string | null;
  uiFont?: string | null;
  // Per-user site theme. themeMode ∈ {dark,light,custom}; NULL = dark default.
  // themeCustomColor is the #rrggbb base for 'custom'. Admin-gated (set via
  // routes/update-theme.ts). Not gated on plan.
  themeMode?: string | null;
  themeCustomColor?: string | null;
}

export const Errors = {
  UNAUTHORIZED: { error: "Unauthorized", status: 401 },
  FORBIDDEN:    { error: "Forbidden", status: 403 },
  NOT_FOUND:    { error: "Not found", status: 404 },
  CONFLICT:     { error: "Already exists", status: 409 },
  BAD_REQUEST:  { error: "Bad request", status: 400 },
  INTERNAL:     { error: "Internal server error", status: 500 },
  RATE_LIMITED: { error: "rate_limited", status: 429 },
} as const;

export function errorResponse(err: typeof Errors[keyof typeof Errors]): Response {
  return Response.json({ ok: false, ...err }, { status: err.status });
}

export function okResponse<T>(data: T, status = 200): Response {
  return Response.json({ ok: true, data }, { status });
}

// Shape of the Cloudflare ratelimit bindings (see Env in index.ts).
export interface RateLimiter {
  limit(opts: { key: string }): Promise<{ success: boolean }>;
}

// Per-user rate-limit guard for authenticated, proxied routes. These reach the
// auth worker via the API worker's service-binding proxy, which does NOT forward
// CF-Connecting-IP — so an IP key would collapse to "unknown" and bucket every
// caller together. We key on the authenticated userId instead (same reasoning as
// the MFA throttle in mfa.ts). Returns a 429 Response to short-circuit on, or
// null to proceed.
export async function rateLimitUser(limiter: RateLimiter, key: string): Promise<Response | null> {
  const { success } = await limiter.limit({ key });
  return success ? null : errorResponse(Errors.RATE_LIMITED);
}

// Canonical email normalization for every auth entry point (register, login,
// resend-verification, webauthn). Trim surrounding whitespace — addresses can't
// contain spaces, so a stray leading/trailing space is always user error — then
// lowercase so case differences map to the same account. Must be applied
// identically on the write (register) and read (login/lookup) paths or a user
// could register one way and fail to authenticate the other.
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
