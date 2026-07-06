// Shared date/identity formatting for the admin pages.
//
// Timestamps arrive in two shapes:
//  - ISO 8601 with a zone (JS `toISOString`, most API-DB columns), which
//    `new Date(...)` parses correctly, and
//  - SQLite's `datetime('now')` form "YYYY-MM-DD HH:MM:SS", which is UTC but
//    carries NO zone marker - `new Date(...)` would parse it as LOCAL time
//    and render moderation/audit history shifted by the operator's UTC
//    offset. Detect that shape and append the missing Z.
const SQLITE_DATETIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/;

export function parseDbDate(value: string): Date {
  if (SQLITE_DATETIME.test(value)) {
    return new Date(`${value.replace(" ", "T")}Z`);
  }
  return new Date(value);
}

export function formatDateTime(value: string): string {
  const d = parseDbDate(value);
  return Number.isNaN(d.getTime())
    ? value
    : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function formatDate(value: string): string {
  const d = parseDbDate(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleDateString();
}

// Unix-ms timestamp (Stripe/plan fields). Null stays null so callers can
// choose their own placeholder.
export function formatTimestampMs(ms: number | null): string | null {
  if (ms == null) return null;
  return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

// Unix-seconds timestamp (moderation `until` values).
export function formatTimestampSeconds(seconds: number): string {
  return new Date(seconds * 1000).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

// Avatar-fallback initials: first letter of the first and last words, so
// "Ada Lovelace King" -> "AK" and "Ada" -> "A". (This was previously
// duplicated with subtly different behavior per page.)
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}
