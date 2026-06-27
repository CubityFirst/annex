import { requireAuthenticatedSession } from "../auth-session";
import { errorResponse, Errors, okResponse } from "../lib";
import { OIDC_CODE_TTL_MS, parseRedirectUris, redirectUriAllowed, resolveScopes } from "../oidc";
import type { Env } from "../index";

interface ClientRow {
  client_id: string;
  client_name: string;
  redirect_uris: string;
  allowed_scopes: string;
  trusted: number;
  disabled: number;
}

interface AuthorizeBody {
  client_id?: string;
  redirect_uri?: string;
  response_type?: string;
  scope?: string;
  state?: string;
  nonce?: string;
  code_challenge?: string;
  code_challenge_method?: string;
  // SPA consent controls (the authorize page re-POSTs with one of these set):
  approved?: boolean;
  denied?: boolean;
}

// Build a `redirect_uri?...&state=...` URL. Only ever called AFTER redirect_uri
// has been validated against the client's exact allowlist.
function buildRedirect(redirectUri: string, params: Record<string, string | undefined>): string {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") url.searchParams.set(k, v);
  }
  return url.toString();
}

// POST /oauth/authorize  (proxied to the app origin as /api/oauth/authorize)
//
// The browser-facing authorization step. Called by the Annex app's
// /oauth/authorize page with the signed-in user's Bearer token plus the OIDC
// request params. Validates the client + redirect, optionally surfaces a
// consent gate, then mints a single-use authorization code and returns the
// `redirectTo` the page should send the browser to.
//
// Errors are split deliberately:
//   - Pre-validation failures (unknown/disabled client, redirect not on the
//     allowlist) return a plain 400 - we must NEVER redirect to an unvalidated
//     URI, or we become an open redirector / token-leak vector.
//   - Post-validation failures (bad scope, missing PKCE, denial) come back as a
//     `redirectTo` carrying `error=...&state=...`, per the OAuth spec.
export async function handleOAuthAuthorize(request: Request, env: Env): Promise<Response> {
  const session = await requireAuthenticatedSession(request, env);
  if (session instanceof Response) return session;

  const body = await request.json<AuthorizeBody>().catch(() => ({} as AuthorizeBody));

  if (!body.client_id || !body.redirect_uri) return errorResponse(Errors.BAD_REQUEST);

  const client = await env.DB.prepare(
    "SELECT client_id, client_name, redirect_uris, allowed_scopes, trusted, disabled FROM oauth_clients WHERE client_id = ?",
  ).bind(body.client_id).first<ClientRow>();

  // Pre-validation: never redirect on these.
  if (!client || client.disabled) {
    return Response.json({ ok: false, error: "invalid_client" }, { status: 400 });
  }
  const registered = parseRedirectUris(client.redirect_uris);
  if (!redirectUriAllowed(body.redirect_uri, registered)) {
    return Response.json({ ok: false, error: "invalid_redirect_uri" }, { status: 400 });
  }

  const redirectUri = body.redirect_uri;
  const state = body.state;

  // Post-validation failures redirect back to the (now trusted) redirect_uri.
  if (body.denied) {
    return okResponse({ redirectTo: buildRedirect(redirectUri, { error: "access_denied", state }) });
  }
  if (body.response_type !== "code") {
    return okResponse({ redirectTo: buildRedirect(redirectUri, { error: "unsupported_response_type", state }) });
  }
  const scope = resolveScopes(body.scope, client.allowed_scopes);
  if (!scope) {
    return okResponse({ redirectTo: buildRedirect(redirectUri, { error: "invalid_scope", state }) });
  }
  // PKCE is mandatory and S256-only.
  if (!body.code_challenge || body.code_challenge_method !== "S256") {
    return okResponse({ redirectTo: buildRedirect(redirectUri, { error: "invalid_request", state }) });
  }

  // Consent gate. First-party (`trusted`) clients auto-approve; others must
  // come back with `approved: true` after the page shows the consent screen.
  if (!client.trusted && !body.approved) {
    return okResponse({
      consentRequired: true,
      client: { name: client.client_name },
      scope,
      email: session.email,
    });
  }

  const now = Date.now();
  const code = crypto.randomUUID();

  // Opportunistic GC of dead codes (mirrors admin-handoff-start).
  await env.DB.prepare(
    "DELETE FROM oauth_codes WHERE expires_at <= ? OR consumed_at IS NOT NULL",
  ).bind(now).run();

  await env.DB.prepare(
    `INSERT INTO oauth_codes (code, client_id, user_id, redirect_uri, scope, code_challenge, nonce, created_at, expires_at, consumed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).bind(
    code,
    client.client_id,
    session.userId,
    redirectUri,
    scope,
    body.code_challenge,
    body.nonce ?? null,
    now,
    now + OIDC_CODE_TTL_MS,
  ).run();

  return okResponse({ redirectTo: buildRedirect(redirectUri, { code, state }) });
}
