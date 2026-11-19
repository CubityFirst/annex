import type { AdminUser } from "@/lib/api";
import { formatDateTime, formatTimestampSeconds } from "@/lib/format";

// Helpers for interpreting the `moderation` value the admin API derives from
// the users mirror's last known identity standing (read-only here; moderation
// happens on auth.cubityfir.st):
//   0  = active, -1 = disabled indefinitely, >0 = suspended until that
//   unix-seconds timestamp (an elapsed timestamp means active again).

export type ModerationState =
  | { kind: "active" }
  | { kind: "disabled" }
  | { kind: "suspended"; until: number };

export function getModerationState(moderation: number, nowMs = Date.now()): ModerationState {
  const nowSeconds = Math.floor(nowMs / 1000);
  if (moderation === -1) return { kind: "disabled" };
  if (moderation > 0 && nowSeconds < moderation) return { kind: "suspended", until: moderation };
  return { kind: "active" };
}

export function formatModerationUntil(until: number): string {
  return formatTimestampSeconds(until);
}

export function formatModerationAction(action: AdminUser["latest_moderation_action"]): string {
  if (action === "disabled") return "Disabled";
  if (action === "suspended") return "Suspended";
  if (action === "re_enabled") return "Re-enabled";
  return "Unknown";
}

export function latestModerationSummary(user: AdminUser): string | null {
  if (!user.latest_moderation_action || !user.latest_moderation_created_at) return null;
  // created_at comes from SQLite datetime('now') - formatDateTime handles
  // the missing-zone form (see lib/format.ts).
  const when = formatDateTime(user.latest_moderation_created_at);
  return `${formatModerationAction(user.latest_moderation_action)} on ${when}`;
}
