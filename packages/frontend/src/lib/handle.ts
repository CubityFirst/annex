// Client-side mirror of packages/auth/src/handle.ts - the rules for the opt-in
// `/@<handle>` profile link. Used for instant validation hints in settings and
// for spotting `/@…` paths in the router; the auth worker is authoritative.
// handle.test.ts asserts the two stay in agreement.

export const HANDLE_MIN_LENGTH = 3;
export const HANDLE_MAX_LENGTH = 30;

const HANDLE_PATTERN = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/;

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

export function handleProblem(handle: string): HandleProblem | null {
  if (handle.length < HANDLE_MIN_LENGTH || handle.length > HANDLE_MAX_LENGTH) return "length";
  if (!HANDLE_PATTERN.test(handle)) return "characters";
  if (RESERVED_HANDLES.has(handle)) return "reserved";
  return null;
}

export const HANDLE_PROBLEM_MESSAGES: Record<HandleProblem, string> = {
  length: `Use ${HANDLE_MIN_LENGTH}–${HANDLE_MAX_LENGTH} characters.`,
  characters: "Use letters, numbers, - or _, starting and ending with a letter or number.",
  reserved: "That username is reserved.",
};

/** Path of a user's profile: the vanity `/@handle` link when they have one. */
export function profilePath(userId: string, handle?: string | null): string {
  return handle ? `/@${handle}` : `/u/${userId}`;
}
