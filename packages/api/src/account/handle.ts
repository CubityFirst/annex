// Public profile handles (the `/@<handle>` link). Pure helpers shared by the
// auth worker's write path (routes/update-handle.ts) and the API worker's
// /users/by-handle resolver. Mirrored for client-side hints in
// packages/frontend/src/lib/handle.ts - keep the rules in sync; the server is
// authoritative.

export const HANDLE_MIN_LENGTH = 3;
export const HANDLE_MAX_LENGTH = 30;

// Lowercase letters, digits, `_` and `-`; must start and end with a letter or
// digit. No dots, so a handle can never be `.`/`..` or look like a file path.
const HANDLE_PATTERN = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/;

// Names that would let someone impersonate staff or the product, or that read
// like app routes. Compared against the normalized handle.
const RESERVED_HANDLES = new Set([
  "admin", "administrator", "annex", "annexink", "api", "app", "auth",
  "billing", "dashboard", "demo", "dev", "developer", "docs", "everyone",
  "help", "here", "ink", "login", "logout", "me", "mod", "moderator",
  "moderators", "null", "official", "oauth", "register", "root", "security",
  "settings", "staff", "support", "system", "team", "undefined", "user", "users",
]);

/** Trim, drop one leading `@`, lowercase. Does not validate. */
export function normalizeHandle(input: string): string {
  return input.trim().replace(/^@/, "").toLowerCase();
}

export type HandleProblem = "length" | "characters" | "reserved";

/** Validate an already-normalized handle. Returns null when it's acceptable. */
export function handleProblem(handle: string): HandleProblem | null {
  if (handle.length < HANDLE_MIN_LENGTH || handle.length > HANDLE_MAX_LENGTH) return "length";
  if (!HANDLE_PATTERN.test(handle)) return "characters";
  if (RESERVED_HANDLES.has(handle)) return "reserved";
  return null;
}

export function isValidHandle(handle: string): boolean {
  return handleProblem(handle) === null;
}
