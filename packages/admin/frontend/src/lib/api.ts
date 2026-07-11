import { getToken, invalidateAdminSession } from "@/lib/auth";

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  created_at: string;
  moderation: number;
  force_password_change: number;
  latest_moderation_action: "disabled" | "suspended" | "re_enabled" | null;
  latest_moderation_reason: string | null;
  latest_moderation_created_at: string | null;
}

export interface AdminUserDetails {
  profile: {
    id: string;
    email: string;
    display_name: string;
    account_created_at: string;
    account_status: "active" | "disabled" | "suspended";
    account_suspended_until?: number;
    force_password_change: boolean;
    badges: number;
  };
  moderation: {
    current_status: "active" | "disabled" | "suspended";
    current_moderation_value: number;
    current_reason: string | null;
    history: Array<{
      action: "disabled" | "suspended" | "re_enabled";
      moderation_value: number;
      reason: string | null;
      created_at: string;
      actor_user_id: string | null;
      actor_email: string | null;
    }>;
  };
  security: {
    totp_enabled: boolean;
    passkeys: Array<{
      id: string;
      name: string;
      registered_at: string;
    }>;
    backup_codes: {
      total: number;
      active: number;
      used: number;
    };
  };
  projects: {
    owned_projects: Array<{
      id: string;
      name: string;
      created_at: string;
    }>;
    project_memberships: Array<{
      project_id: string;
      project_name: string;
      role: string;
      joined_at: string;
    }>;
  };
  billing: {
    resolved_plan: "free" | "ink";
    via: "free" | "paid" | "granted";
    status: string | null;
    started_at: number | null;
    cancel_at: number | null;
    granted: {
      plan: string;
      expires_at: number | null;
      reason: string | null;
    } | null;
    stripe: {
      customer_id: string | null;
      subscription_id: string | null;
    };
  };
}

export interface AdminProject {
  id: string;
  name: string;
  owner_id: string;
  features: number;
  created_at: string;
  // Mapped custom domain (Cloudflare for SaaS), or null if none. status is the
  // app-facing pending | active | error from project_custom_domains.
  custom_domain: string | null;
  custom_domain_status: string | null;
}

export interface AdminProjectDetails {
  profile: {
    id: string;
    name: string;
    description: string | null;
    created_at: string;
    published: boolean;
    published_at: string | null;
    changelog_mode: string;
    home_doc_id: string | null;
    owner: { id: string; name: string | null; email: string | null } | null;
  };
  branding: {
    vanity_slug: string | null;
    logo_square_updated_at: string | null;
    logo_wide_updated_at: string | null;
    custom_domain: { hostname: string; status: string | null } | null;
  };
  organization: { id: string; name: string } | null;
  settings: {
    features: number;
    ai_enabled: boolean;
    ai_summarization_type: string;
    graph_enabled: boolean;
    published_graph_enabled: boolean;
  };
  members: {
    accepted: number;
    pending: number;
    by_role: Array<{ role: string; count: number }>;
    list: Array<{
      id: string;
      user_id: string;
      name: string;
      email: string;
      role: string;
      accepted: boolean;
      created_at: string;
    }>;
  };
  content: {
    docs: { total: number; published: number; drafts: number; with_ai_summary: number };
    folders: number;
    files: { count: number; total_bytes: number };
  };
}

export interface AdminAuditEntry {
  id: string;
  actor_user_id: string;
  actor_email: string;
  action: string;
  target_type: string;
  target_id: string | null;
  detail: string | null;
  created_at: string;
}

export interface AuditPageResult {
  entries: AdminAuditEntry[];
  nextCursor: string | null;
}

export interface AdminAuthSession {
  userId: string;
  email: string;
  expiresAt: number;
  isAdmin: true;
}

interface AdminHandoffExchange {
  token: string;
}

async function authFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const token = getToken();
  const headers = new Headers(init.headers);

  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const response = await fetch(input, {
    ...init,
    headers,
  });

  // Only tear down the whole admin session for genuine session-level
  // failures: a 401 (token missing/expired/invalid) or a 403 whose code
  // says the *account* is gone or not an admin. A generic/unknown 403
  // (e.g. a future per-object "not allowed") must NOT log the operator
  // out of the entire dashboard - the caller surfaces it instead.
  if (token && (response.status === 401 || response.status === 403)) {
    let code: string | undefined;
    if (response.status === 403) {
      try {
        code = ((await response.clone().json()) as { error?: string }).error;
      } catch {
        /* non-JSON 403 body - treat as a non-session failure */
      }
    }
    const sessionFailure =
      response.status === 401 ||
      code === "Forbidden" ||
      code === "account_disabled" ||
      code === "account_suspended";
    if (sessionFailure) invalidateAdminSession();
  }

  // The admin worker rate-limits by IP and replies 429 { error: "rate_limited" }.
  // Surface a readable message instead of the raw code: throwing here routes it
  // through every caller's existing error path (a sonner toast.error), so no
  // per-endpoint handling is needed.
  if (response.status === 429) {
    throw new Error(
      "Too many requests — you've hit the admin rate limit. Wait a few seconds, then try again.",
    );
  }

  return response;
}

// Parses the `{ ok, data, error }` envelope every admin endpoint speaks,
// throwing the server's error string (falling back to `fallback`). A
// non-JSON body means the request never reached the handler (SPA fallback
// HTML on an old worker, an edge error page) or the handler died before
// responding - surface the HTTP status instead of a cryptic SyntaxError.
async function readData<T>(res: Response, fallback: string): Promise<T> {
  let json: { ok: boolean; data?: T; error?: string };
  try {
    json = (await res.json()) as typeof json;
  } catch {
    throw new Error(`${fallback} (HTTP ${res.status})`);
  }
  if (!json.ok) throw new Error(json.error ?? fallback);
  return json.data as T;
}

// Envelope check for endpoints whose `data` payload is irrelevant.
async function readOk(res: Response, fallback: string): Promise<void> {
  await readData<unknown>(res, fallback);
}

// Server-side page size for the users/projects/audit lists (kept in sync
// with USER_PAGE_SIZE / PROJECT_PAGE_SIZE / the audit page size in the
// worker) - used for UI copy, not for slicing.
export const LIST_PAGE_SIZE = 25;

export interface UserSearchResult {
  users: AdminUser[];
  // Opaque cursor for the next (older) page, or null when none remain.
  nextCursor: string | null;
}

export async function searchUsers(
  params: { q: string; status?: string; cursor?: string },
  signal?: AbortSignal,
): Promise<UserSearchResult> {
  const qs = new URLSearchParams({ q: params.q });
  if (params.status) qs.set("status", params.status);
  if (params.cursor) qs.set("cursor", params.cursor);
  const res = await authFetch(`/api/users/search?${qs.toString()}`, { signal });
  return readData<UserSearchResult>(res, "Failed to search users");
}

export async function getUserDetails(id: string): Promise<AdminUserDetails> {
  const res = await authFetch(`/api/users/${id}`);
  return readData<AdminUserDetails>(res, "Failed to load user details");
}

export async function updateUserBadges(id: string, badges: number): Promise<void> {
  const res = await authFetch(`/api/users/${id}/badges`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ badges }),
  });
  await readOk(res, "Failed to update badges");
}

export async function forceUserPasswordChange(id: string): Promise<void> {
  const res = await authFetch(`/api/users/${id}/force-password-change`, { method: "POST" });
  await readOk(res, "Failed to force password change");
}

export async function updateUserModeration(id: string, moderation: number, reason?: string): Promise<void> {
  const res = await authFetch(`/api/users/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ moderation, reason }),
  });
  await readOk(res, "Failed to update user");
}

export interface ProjectListResult {
  projects: AdminProject[];
  // Opaque cursor for the next (older) page, or null when none remain.
  nextCursor: string | null;
}

export async function listProjects(
  params: { q?: string; cursor?: string },
  signal?: AbortSignal,
): Promise<ProjectListResult> {
  const qs = new URLSearchParams();
  if (params.q) qs.set("q", params.q);
  if (params.cursor) qs.set("cursor", params.cursor);
  const res = await authFetch(`/api/projects?${qs.toString()}`, { signal });
  return readData<ProjectListResult>(res, "Failed to list projects");
}

export async function updateProjectFeatures(id: string, features: number): Promise<void> {
  const res = await authFetch(`/api/projects/${id}/features`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ features }),
  });
  await readOk(res, "Failed to update project features");
}

export async function deleteProject(id: string): Promise<void> {
  const res = await authFetch(`/api/projects/${id}`, { method: "DELETE" });
  await readOk(res, "Failed to delete project");
}

// Remove a site's custom domain (deregisters the Cloudflare custom hostname +
// drops the DB row). Returns the removed hostname, or null if none was mapped.
export async function removeProjectDomain(id: string): Promise<{ hostname: string | null }> {
  const res = await authFetch(`/api/projects/${id}/domain`, { method: "DELETE" });
  const data = await readData<{ hostname: string | null } | undefined>(res, "Failed to remove custom domain");
  return data ?? { hostname: null };
}

export async function reindexProjectFts(id: string): Promise<{ indexed: number }> {
  const res = await authFetch(`/api/projects/${id}/reindex`, { method: "POST" });
  return readData<{ indexed: number }>(res, "Failed to reindex project");
}

export async function getProjectDetails(id: string): Promise<AdminProjectDetails> {
  const res = await authFetch(`/api/projects/${id}`);
  return readData<AdminProjectDetails>(res, "Failed to load project details");
}

export type ReportStatus = "open" | "acknowledged" | "resolved" | "dismissed";

export interface AdminSiteReport {
  id: string;
  project_id: string;
  project_name: string | null;
  reporter_user_id: string | null;
  reporter_ip: string | null;
  // The page the reporter was viewing (null if none was sent or the doc was
  // since deleted); doc_title resolved via LEFT JOIN.
  doc_id: string | null;
  doc_title: string | null;
  note: string;
  status: ReportStatus;
  created_at: string;
  status_changed_at: string | null;
  status_changed_by: string | null;
  // Resolved from the auth DB when the report was filed by a signed-in user;
  // null for anonymous reports and deleted accounts.
  reporter: { email: string | null; name: string | null } | null;
}

// A report filed against a user from the profile card. Reporter is always a
// signed-in account (the endpoint requires auth); reported/reporter identities
// are resolved from the auth DB, null for deleted accounts.
export interface AdminUserReport {
  id: string;
  reported_user_id: string;
  reporter_user_id: string;
  reporter_ip: string | null;
  note: string;
  status: ReportStatus;
  created_at: string;
  status_changed_at: string | null;
  status_changed_by: string | null;
  reported: { email: string | null; name: string | null } | null;
  reporter: { email: string | null; name: string | null } | null;
}

export interface ReportListResult<T> {
  reports: T[];
  // Opaque cursor for the next (older) page, or null when none remain.
  nextCursor: string | null;
}

// status: "current" (open + acknowledged - the triage queue), "all", or one
// concrete status. projectId narrows to a single site.
export async function listSiteReports(
  params: { status?: string; projectId?: string; cursor?: string },
  signal?: AbortSignal,
): Promise<ReportListResult<AdminSiteReport>> {
  const qs = new URLSearchParams();
  if (params.status) qs.set("status", params.status);
  if (params.projectId) qs.set("projectId", params.projectId);
  if (params.cursor) qs.set("cursor", params.cursor);
  const res = await authFetch(`/api/reports/sites?${qs.toString()}`, { signal });
  return readData<ReportListResult<AdminSiteReport>>(res, "Failed to list reports");
}

export async function listUserReports(
  params: { status?: string; userId?: string; cursor?: string },
  signal?: AbortSignal,
): Promise<ReportListResult<AdminUserReport>> {
  const qs = new URLSearchParams();
  if (params.status) qs.set("status", params.status);
  if (params.userId) qs.set("userId", params.userId);
  if (params.cursor) qs.set("cursor", params.cursor);
  const res = await authFetch(`/api/reports/users?${qs.toString()}`, { signal });
  return readData<ReportListResult<AdminUserReport>>(res, "Failed to list reports");
}

export async function updateReportStatus(
  kind: "site" | "user",
  id: string,
  status: ReportStatus,
): Promise<void> {
  const res = await authFetch(`/api/reports/${kind}s/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  });
  await readOk(res, "Failed to update report");
}

// Fetch a site logo (square|wide) for the admin sheet with the bearer token,
// returned as a Blob the caller renders via an object URL. Returns null when
// the site has no logo of that variant (404) or the request otherwise fails -
// the UI falls back to a neutral tile, so a missing logo isn't an error.
export async function fetchProjectLogo(id: string, variant: "square" | "wide"): Promise<Blob | null> {
  const res = await authFetch(`/api/projects/${id}/logo?variant=${variant}`);
  if (!res.ok) return null;
  return await res.blob();
}

export interface AuditFilter {
  // Match any of these action types. Empty/omitted = all actions.
  actions?: string[];
  // User-scoped substring search (actor email/id + target id).
  q?: string;
}

export async function listAuditLog(
  cursor?: string,
  filter?: AuditFilter,
  signal?: AbortSignal,
): Promise<AuditPageResult> {
  const params = new URLSearchParams();
  if (cursor) params.set("cursor", cursor);
  for (const a of filter?.actions ?? []) params.append("action", a);
  if (filter?.q) params.set("q", filter.q);
  const qs = params.toString();
  const res = await authFetch(`/api/audit${qs ? `?${qs}` : ""}`, { signal });
  return readData<AuditPageResult>(res, "Failed to load audit log");
}

export async function listAuditActions(signal?: AbortSignal): Promise<string[]> {
  const res = await authFetch("/api/audit/actions", { signal });
  const data = await readData<{ actions: string[] }>(res, "Failed to load audit actions");
  return data.actions;
}

export interface GrantInkResult {
  cancelStripeWarning?: string;
}

export async function grantInk(
  id: string,
  opts: { reason?: string; expiresAt?: number | null; cancelExistingPaidSub?: boolean } = {},
): Promise<GrantInkResult> {
  const res = await authFetch(`/api/users/${id}/grant-ink`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      reason: opts.reason,
      expires_at: opts.expiresAt ?? null,
      cancel_existing_paid_sub: opts.cancelExistingPaidSub === true,
    }),
  });
  const data = await readData<GrantInkResult | undefined>(res, "Failed to grant Ink");
  return data ?? {};
}

export async function revokeGrantedInk(id: string): Promise<void> {
  const res = await authFetch(`/api/users/${id}/grant-ink`, { method: "DELETE" });
  await readOk(res, "Failed to revoke Ink grant");
}

export async function giftFreeMonth(id: string): Promise<{ amount: number; currency: string }> {
  const res = await authFetch(`/api/users/${id}/gift-month`, { method: "POST" });
  return readData<{ amount: number; currency: string }>(res, "Failed to gift free month");
}

export async function cancelUserSubscription(id: string, opts: { immediate?: boolean } = {}): Promise<void> {
  const res = await authFetch(`/api/users/${id}/cancel-subscription`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ immediate: opts.immediate === true }),
  });
  await readOk(res, "Failed to cancel subscription");
}

export async function deleteUserAvatar(id: string): Promise<void> {
  const res = await authFetch(`/api/users/${id}/avatar`, { method: "DELETE" });
  await readOk(res, "Failed to delete avatar");
}

// Fetches the export zip; the caller decides how to save it (see
// lib/download.ts downloadBlob) so this module stays DOM-free.
export async function exportUserData(id: string, email: string): Promise<{ blob: Blob; filename: string }> {
  const res = await authFetch(`/api/users/${id}/export`);
  if (!res.ok) {
    let msg = "Failed to export user data";
    try {
      msg = ((await res.json()) as { error?: string }).error ?? msg;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(msg);
  }
  const blob = await res.blob();
  const date = new Date().toISOString().slice(0, 10);
  return { blob, filename: `userdata_${email.replace(/[^a-z0-9]/gi, "_")}_${date}.zip` };
}

// Thrown by verifyAdminSession for failures that do NOT mean the session is
// bad - offline, DNS, a gateway 5xx. The caller should keep the token and
// retry later instead of forcing a fresh handoff.
export class TransientVerifyError extends Error {}

export async function verifyAdminSession(): Promise<AdminAuthSession> {
  let res: Response;
  try {
    res = await authFetch("/api/verify");
  } catch (err) {
    // fetch() rejects only on network-level failures (offline, DNS, CORS);
    // authFetch's own 429 throw is transient too.
    throw new TransientVerifyError(err instanceof Error ? err.message : "Network error");
  }
  if (res.status >= 500) {
    throw new TransientVerifyError(`Admin API returned ${res.status}`);
  }
  return readData<AdminAuthSession>(res, "Failed to verify admin session");
}

// Server-side sign-out: revokes the session row the current token points
// at (via the auth worker), so a copied token dies with the sign-out
// instead of staying valid until its TTL. Best-effort by design - the
// caller clears local state regardless.
export async function logoutAdminSession(): Promise<void> {
  const res = await authFetch("/api/auth/logout", { method: "POST" });
  await readOk(res, "Failed to sign out");
}

export class AdminHandoffError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

async function exchangeAdminHandoffUncached(code: string, callbackUrl: string): Promise<AdminHandoffExchange> {
  const res = await fetch("/api/auth/handoff/exchange", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, callbackUrl }),
  });
  const json = (await res.json()) as { ok: boolean; data?: AdminHandoffExchange; error?: string };
  if (!json.ok || !json.data) throw new AdminHandoffError(json.error ?? "unknown");
  return json.data;
}

// The handoff code is single-use and consumed atomically server-side, so two
// concurrent exchanges of the same code (React StrictMode's dev double-mount)
// would race: the loser gets "consumed" and paints an error over a successful
// sign-in. Cache the in-flight/settled promise per code so every caller
// observes the SAME exchange outcome.
const exchangePromises = new Map<string, Promise<AdminHandoffExchange>>();

export function exchangeAdminHandoff(code: string, callbackUrl: string): Promise<AdminHandoffExchange> {
  let promise = exchangePromises.get(code);
  if (!promise) {
    promise = exchangeAdminHandoffUncached(code, callbackUrl);
    exchangePromises.set(code, promise);
  }
  return promise;
}

// ---------------------------------------------------------------------------
// "Sign in with Annex" - OIDC client management
// ---------------------------------------------------------------------------

export interface OAuthClient {
  client_id: string;
  client_name: string;
  is_public: boolean;
  redirect_uris: string[];
  allowed_scopes: string;
  trusted: boolean;
  disabled: boolean;
  created_at: number;
}

// The create/rotate responses additionally carry the plaintext secret, which
// the server returns exactly ONCE and never stores.
export interface CreatedOAuthClient {
  client_id: string;
  client_secret: string | null;
  client_name: string;
  is_public: boolean;
  redirect_uris: string[];
  allowed_scopes: string;
  trusted: boolean;
  disabled: boolean;
}

export interface CreateOAuthClientInput {
  name: string;
  redirect_uris: string[];
  scopes?: string;
  trusted?: boolean;
  public?: boolean;
}

// Map the server's machine error codes to operator-friendly messages.
function oauthClientError(error?: string): string {
  if (error === "invalid_redirect_uri") return "Every redirect URI must be a valid https URL (or localhost for dev).";
  if (error === "invalid_scope") return "Scopes must be a subset of 'openid profile email' and include openid.";
  if (error === "public_client_no_secret") return "Public clients have no secret to rotate.";
  return error ?? "Request failed";
}

export async function listOAuthClients(signal?: AbortSignal): Promise<OAuthClient[]> {
  const res = await authFetch("/api/oauth-clients", { signal });
  const data = await readData<{ clients: OAuthClient[] }>(res, "Failed to load OAuth clients");
  return data.clients;
}

export async function createOAuthClient(input: CreateOAuthClientInput): Promise<CreatedOAuthClient> {
  const res = await authFetch("/api/oauth-clients", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  try {
    return await readData<CreatedOAuthClient>(res, "Failed to register client");
  } catch (err) {
    throw new Error(oauthClientError(err instanceof Error ? err.message : undefined));
  }
}

export async function setOAuthClientDisabled(clientId: string, disabled: boolean): Promise<void> {
  const res = await authFetch("/api/oauth-clients/set-disabled", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, disabled }),
  });
  await readOk(res, "Failed to update client");
}

export async function deleteOAuthClient(clientId: string): Promise<void> {
  const res = await authFetch("/api/oauth-clients/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId }),
  });
  await readOk(res, "Failed to delete client");
}

export async function rotateOAuthClientSecret(clientId: string): Promise<string> {
  const res = await authFetch("/api/oauth-clients/rotate-secret", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId }),
  });
  try {
    const data = await readData<{ client_secret: string }>(res, "Failed to rotate secret");
    return data.client_secret;
  } catch (err) {
    throw new Error(oauthClientError(err instanceof Error ? err.message : undefined));
  }
}
