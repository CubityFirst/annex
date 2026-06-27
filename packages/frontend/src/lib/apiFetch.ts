import { getToken, clearToken } from "./auth";

// Wraps fetch for API calls so account-level rejections from the auth worker
// (disabled / suspended) and expired sessions consistently log the user out
// and bounce them back to /login with a reason banner. Anything else falls
// through unchanged.
//
// Use this for any request that hits an authenticated endpoint. Anonymous
// endpoints can still call fetch directly.
export interface ApiFetchOptions extends RequestInit {
  // When true, do not auto-attach the Authorization header. Defaults to false.
  skipAuth?: boolean;
}

export interface ApiResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
  status: number;
  // True when apiFetch handled this response by triggering a forced redirect
  // (401 expired, 403 disabled/suspended). Callers should bail out of post-
  // response logic - the page is unloading.
  redirected?: boolean;
}

// Marker header on the body-less stub Response apiFetch returns when it
// redirects. Lets apiFetchJson distinguish "we redirected" from "endpoint
// genuinely returned an empty body" without depending on `response.body === null`.
const REDIRECT_MARKER = "X-Auth-Redirect";

function buildLoginUrl(reason: string): string {
  const here = window.location.pathname + window.location.search;
  // Don't bother with next= for trivially-empty paths.
  const next = here && here !== "/" ? `&next=${encodeURIComponent(here)}` : "";
  return `/login?reason=${reason}${next}`;
}

function redirectStub(status: number): Response {
  return new Response(null, { status, headers: { [REDIRECT_MARKER]: "1" } });
}

export async function apiFetch(input: string, options: ApiFetchOptions = {}): Promise<Response> {
  const { skipAuth, headers: extraHeaders, ...rest } = options;

  const headers = new Headers(extraHeaders);
  if (!skipAuth) {
    const token = getToken();
    if (token && !headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${token}`);
    }
  }

  const response = await fetch(input, { ...rest, headers });

  if (response.status === 401) {
    clearToken();
    window.location.replace(buildLoginUrl("expired"));
    return redirectStub(401);
  }

  if (response.status === 403) {
    // Peek at the body without consuming it for the caller. clone() is cheap
    // because we only read at most a few bytes of JSON before deciding.
    const reason = await peekAccountRejectReason(response);
    if (reason) {
      clearToken();
      // Replace so the back button doesn't bounce them back into a doomed page.
      window.location.replace(buildLoginUrl(reason));
      return redirectStub(403);
    }
  }

  return response;
}

// Convenience wrapper for the common `{ ok, data?, error? }` JSON envelope used
// across the API. Returns a result object that always has `status`, plus
// `redirected: true` when apiFetch handed back a marker stub during a forced
// redirect (the page is unloading; callers should bail).
export async function apiFetchJson<T = unknown>(
  input: string,
  options: ApiFetchOptions = {},
): Promise<ApiResult<T>> {
  const response = await apiFetch(input, options);
  if (response.headers.get(REDIRECT_MARKER)) {
    return { ok: false, status: response.status, redirected: true };
  }
  try {
    const json = await response.json() as { ok: boolean; data?: T; error?: string };
    return { ...json, status: response.status };
  } catch {
    return { ok: false, status: response.status };
  }
}

async function peekAccountRejectReason(response: Response): Promise<string | null> {
  try {
    const cloned = response.clone();
    const data = await cloned.json() as { error?: string };
    if (data.error === "account_disabled") return "disabled";
    if (data.error === "account_suspended") return "suspended";
  } catch {
    // not JSON, or unexpected shape - treat as a generic 403, not an account reject
  }
  return null;
}
