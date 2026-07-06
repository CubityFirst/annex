import type { Env } from "./index";

const LOCAL_ADMIN_ORIGINS = new Set([
  "http://localhost:5174",
  "http://127.0.0.1:5174",
  "https://localhost:5174",
  "https://127.0.0.1:5174",
]);

export function normalizeNextPath(nextPath: string | null): string | null {
  if (nextPath === null) return null;
  if (!nextPath.startsWith("/")) return null;
  // Reject protocol-relative forms ("//evil.com", "/\evil.com"): they are not
  // an open redirect on the admin SPA (React Router refuses the cross-origin
  // resolve) but they wedge the callback page after a successful exchange.
  if (nextPath.startsWith("//") || nextPath.startsWith("/\\")) return null;
  return nextPath;
}

// Loopback admin origins are for local development only. Gate them on the
// deployment itself being local (same defence as dev-quick-login): otherwise a
// crafted login link + malware listening on a victim admin's localhost:5174
// could exchange a handoff code for an admin session in production.
function isAllowedLocalAdminOrigin(origin: string, env: Env): boolean {
  const isLocalDeploy = /\blocalhost\b|127\.0\.0\.1/.test(env.APP_ORIGIN ?? "");
  return isLocalDeploy && LOCAL_ADMIN_ORIGINS.has(origin);
}

function buildApprovedCallbackUrl(origin: string, nextPath: string | null): string {
  const url = new URL("/auth/callback", origin);
  if (nextPath && nextPath !== "/") {
    url.searchParams.set("next", nextPath);
  }
  return url.toString();
}

export function normalizeAdminCallbackUrl(
  callbackUrl: string,
  env: Env,
): string | null {
  try {
    const url = new URL(callbackUrl);
    const nextPath = normalizeNextPath(url.searchParams.get("next"));
    if (url.searchParams.has("next") && nextPath === null) return null;
    if (url.pathname !== "/auth/callback") return null;

    const productionOrigin = env.ADMIN_APP_ORIGIN;
    if (url.origin === productionOrigin) {
      return buildApprovedCallbackUrl(productionOrigin, nextPath);
    }

    if (isAllowedLocalAdminOrigin(url.origin, env)) {
      return buildApprovedCallbackUrl(url.origin, nextPath);
    }

    return null;
  } catch {
    return null;
  }
}

// Audit trail for admin-session minting (admin_audit_log lives in this
// worker's own DB). The admin worker's audit view shows what admins *did*;
// these two rows record *who obtained admin access and when* - the single
// most useful record in an incident.
export async function writeAdminHandoffAudit(
  env: Env,
  actor: { userId: string; email: string },
  action: "admin.handoff.start" | "admin.handoff.exchange",
  detail?: Record<string, unknown>,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO admin_audit_log
       (id, actor_user_id, actor_email, action, target_type, target_id, detail)
     VALUES (?, ?, ?, ?, 'user', ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      actor.userId,
      actor.email,
      action,
      actor.userId,
      detail ? JSON.stringify(detail) : null,
    )
    .run();
}
