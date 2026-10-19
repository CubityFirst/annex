import type { Env } from "./index";
import type { AdminSession } from "./auth";

export type AuditTargetType = "user" | "project" | "oauth_client" | "report";

// Writes one actor-attributed row to admin_audit_log (auth DB). Call
// AFTER the mutation/export has succeeded so the trail only records
// actions that actually took effect. Awaited rather than fire-and-forget:
// a missing audit row on a privileged action is worse than a 500 the
// operator can retry, and the insert is a single local D1 write.
export async function writeAdminAudit(
  env: Env,
  actor: AdminSession,
  action: string,
  targetType: AuditTargetType,
  targetId: string | null,
  detail?: Record<string, unknown>,
): Promise<void> {
  await adminAuditStatement(env, actor, action, targetType, targetId, detail).run();
}

// The same insert as an unexecuted statement, for callers that must commit
// the audit row in one AUTH_DB batch with the mutation it records (so neither
// can land without the other).
export function adminAuditStatement(
  env: Env,
  actor: AdminSession,
  action: string,
  targetType: AuditTargetType,
  targetId: string | null,
  detail?: Record<string, unknown>,
): D1PreparedStatement {
  return env.AUTH_DB.prepare(
    `INSERT INTO admin_audit_log
       (id, actor_user_id, actor_email, action, target_type, target_id, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(),
    actor.userId,
    actor.email,
    action,
    targetType,
    targetId,
    detail ? JSON.stringify(detail) : null,
  );
}
