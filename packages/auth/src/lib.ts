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

// Resolve the real client IP. CF-Connecting-IP is edge-set and unspoofable but
// survives only direct edge hits; service-binding hops (frontend → api → auth)
// drop it, so the proxies forward the edge-observed value as X-Client-IP
// (overwritten at every hop, never client-controlled). Returns null when
// neither is present (local dev without the header).
export function clientIp(request: Request): string | null {
  return request.headers.get("CF-Connecting-IP") ?? request.headers.get("X-Client-IP");
}

// Canonical email normalization for every auth entry point (register, login,
// resend-verification, webauthn). Trim surrounding whitespace - addresses can't
// contain spaces, so a stray leading/trailing space is always user error - then
// lowercase so case differences map to the same account. Must be applied
// identically on the write (register) and read (login/lookup) paths or a user
// could register one way and fail to authenticate the other.
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
