import type { AdminUser } from "@/lib/api";
import { formatDateTime, formatTimestampSeconds } from "@/lib/format";

// Helpers for interpreting the users.moderation column:
//   0  = active, -1 = disabled indefinitely, >0 = suspended until that
//   unix-seconds timestamp (an elapsed timestamp means active again).

export type ModerationState =
  | { kind: "active" }
  | { kind: "disabled" }
  | { kind: "suspended"; until: number };

export type DisableMode = "indefinitely" | "until";

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

export function createDefaultDisableDate(): Date {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  date.setHours(9, 0, 0, 0);
  return date;
}

export function formatTimeInput(date: Date): string {
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

export function mergeDateAndTime(date: Date, timeValue: string): Date {
  const [hours, minutes] = timeValue.split(":").map(part => Number.parseInt(part, 10));
  const merged = new Date(date);
  merged.setHours(hours || 0, minutes || 0, 0, 0);
  return merged;
}

export function latestModerationSummary(user: AdminUser): string | null {
  if (!user.latest_moderation_action || !user.latest_moderation_created_at) return null;
  // created_at comes from SQLite datetime('now') - formatDateTime handles
  // the missing-zone form (see lib/format.ts).
  const when = formatDateTime(user.latest_moderation_created_at);
  return `${formatModerationAction(user.latest_moderation_action)} on ${when}`;
}
