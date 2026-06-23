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
  // out of the entire dashboard — the caller surfaces it instead.
  if (token && (response.status === 401 || response.status === 403)) {
    let code: string | undefined;
    if (response.status === 403) {
      try {
        code = ((await response.clone().json()) as { error?: string }).error;
      } catch {
        /* non-JSON 403 body — treat as a non-session failure */
      }
    }
    const sessionFailure =
      response.status === 401 ||
      code === "Forbidden" ||
      code === "account_disabled" ||
      code === "account_suspended";
    if (sessionFailure) invalidateAdminSession();
  }

  return response;
}

// Pulls `{ ok, error }` off a JSON response, falling back to a static
// message. Centralizes the "surface the server's error string" handling
// so every endpoint reports the real reason instead of a generic throw.
async function readOk(res: Response, fallback: string): Promise<void> {
  const json = (await res.json()) as { ok: boolean; error?: string };
  if (!json.ok) throw new Error(json.error ?? fallback);
}

export async function searchUsers(q: string, signal?: AbortSignal): Promise<AdminUser[]> {
  const res = await authFetch(`/api/users/search?q=${encodeURIComponent(q)}`, { signal });
  const json = (await res.json()) as { ok: boolean; data?: AdminUser[]; error?: string };
  if (!json.ok || !json.data) throw new Error(json.error ?? "Failed to search users");
  return json.data;
}

export async function getUserDetails(id: string): Promise<AdminUserDetails> {
  const res = await authFetch(`/api/users/${id}`);
  const json = (await res.json()) as { ok: boolean; data?: AdminUserDetails; error?: string };
  if (!json.ok || !json.data) throw new Error(json.error ?? "Failed to load user details");
  return json.data;
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

export async function listProjects(q: string, signal?: AbortSignal): Promise<AdminProject[]> {
  const res = await authFetch(`/api/projects?q=${encodeURIComponent(q)}`, { signal });
  const json = (await res.json()) as { ok: boolean; data?: AdminProject[]; error?: string };
  if (!json.ok || !json.data) throw new Error(json.error ?? "Failed to list projects");
  return json.data;
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
  const json = (await res.json()) as { ok: boolean; data?: { hostname: string | null }; error?: string };
  if (!json.ok) throw new Error(json.error ?? "Failed to remove custom domain");
  return json.data ?? { hostname: null };
}

export async function reindexProjectFts(id: string): Promise<{ indexed: number }> {
  const res = await authFetch(`/api/projects/${id}/reindex`, { method: "POST" });
  const json = (await res.json()) as { ok: boolean; data?: { indexed: number }; error?: string };
  if (!json.ok || !json.data) throw new Error(json.error ?? "Failed to reindex project");
  return json.data;
}

export async function getProjectDetails(id: string): Promise<AdminProjectDetails> {
  const res = await authFetch(`/api/projects/${id}`);
  let json: { ok: boolean; data?: AdminProjectDetails; error?: string };
  try {
    json = (await res.json()) as typeof json;
  } catch {
    // A non-JSON body means the request never reached the handler (SPA
    // fallback HTML) or the handler threw before responding (a plain-text
    // 500) — surface the status rather than a cryptic JSON parse error.
    throw new Error(`Failed to load project details (HTTP ${res.status})`);
  }
  if (!json.ok || !json.data) throw new Error(json.error ?? "Failed to load project details");
  return json.data;
}

// Fetch a site logo (square|wide) for the admin sheet with the bearer token,
// returned as a Blob the caller renders via an object URL. Returns null when
// the site has no logo of that variant (404) or the request otherwise fails —
// the UI falls back to a neutral tile, so a missing logo isn't an error.
export async function fetchProjectLogo(id: string, variant: "square" | "wide"): Promise<Blob | null> {
  const res = await authFetch(`/api/projects/${id}/logo?variant=${variant}`);
  if (!res.ok) return null;
  return await res.blob();
}

export async function listAuditLog(
  cursor?: string,
  signal?: AbortSignal,
): Promise<AuditPageResult> {
  const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  const res = await authFetch(`/api/audit${qs}`, { signal });
  const json = (await res.json()) as { ok: boolean; data?: AuditPageResult; error?: string };
  if (!json.ok || !json.data) throw new Error(json.error ?? "Failed to load audit log");
  return json.data;
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
  const json = (await res.json()) as { ok: boolean; error?: string; data?: GrantInkResult };
  if (!json.ok) throw new Error(json.error ?? "Failed to grant Ink");
  return json.data ?? {};
}

export async function revokeGrantedInk(id: string): Promise<void> {
  const res = await authFetch(`/api/users/${id}/grant-ink`, { method: "DELETE" });
  await readOk(res, "Failed to revoke Ink grant");
}

export async function giftFreeMonth(id: string): Promise<{ amount: number; currency: string }> {
  const res = await authFetch(`/api/users/${id}/gift-month`, { method: "POST" });
  const json = (await res.json()) as { ok: boolean; data?: { amount: number; currency: string }; error?: string };
  if (!json.ok || !json.data) throw new Error(json.error ?? "Failed to gift free month");
  return json.data;
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

export async function exportUserData(id: string, email: string): Promise<void> {
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
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const date = new Date().toISOString().slice(0, 10);
  a.download = `userdata_${email.replace(/[^a-z0-9]/gi, "_")}_${date}.zip`;
  a.click();
  URL.revokeObjectURL(url);
}

export async function verifyAdminSession(): Promise<AdminAuthSession> {
  const res = await authFetch("/api/verify");
  const json = (await res.json()) as { ok: boolean; data?: AdminAuthSession; error?: string };
  if (!json.ok || !json.data) throw new Error(json.error ?? "Failed to verify admin session");
  return json.data;
}

export class AdminHandoffError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

export async function exchangeAdminHandoff(code: string, callbackUrl: string): Promise<AdminHandoffExchange> {
  const res = await fetch("/api/auth/handoff/exchange", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, callbackUrl }),
  });
  const json = (await res.json()) as { ok: boolean; data?: AdminHandoffExchange; error?: string };
  if (!json.ok || !json.data) throw new AdminHandoffError(json.error ?? "unknown");
  return json.data;
}

// ---------------------------------------------------------------------------
// "Sign in with Annex" — OIDC client management
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
  const json = (await res.json()) as { ok: boolean; data?: { clients: OAuthClient[] }; error?: string };
  if (!json.ok || !json.data) throw new Error(json.error ?? "Failed to load OAuth clients");
  return json.data.clients;
}

export async function createOAuthClient(input: CreateOAuthClientInput): Promise<CreatedOAuthClient> {
  const res = await authFetch("/api/oauth-clients", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const json = (await res.json()) as { ok: boolean; data?: CreatedOAuthClient; error?: string };
  if (!json.ok || !json.data) throw new Error(oauthClientError(json.error));
  return json.data;
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
  const json = (await res.json()) as { ok: boolean; data?: { client_secret: string }; error?: string };
  if (!json.ok || !json.data) throw new Error(oauthClientError(json.error));
  return json.data.client_secret;
}
