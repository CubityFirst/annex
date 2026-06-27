import {
  buildAccessTokenClaims,
  buildIdTokenClaims,
  OIDC_TOKEN_TTL_SEC,
  parsePrivateJwk,
  signRs256,
  verifyClientSecret,
  verifyPkceS256,
  type OidcUser,
} from "../oidc";
import { checkModeration } from "./login";
import type { Env } from "../index";

interface ClientRow {
  client_id: string;
  client_secret_hash: string | null;
  disabled: number;
}

interface CodeRow {
  code: string;
  client_id: string;
  user_id: string;
  redirect_uri: string;
  scope: string;
  code_challenge: string;
  nonce: string | null;
}

interface UserRow {
  id: string;
  email: string;
  name: string;
  email_verified: number;
  is_admin: number;
  moderation: number;
  force_password_change: number;
}

// Standard OAuth token-endpoint responses are RAW JSON (no `{ok,data}`
// envelope) and must not be cached.
function tokenJson(body: Record<string, unknown>, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", Pragma: "no-cache" },
  });
}

function tokenError(error: string, status: number, description?: string): Response {
  return tokenJson(description ? { error, error_description: description } : { error }, status);
}

// Pull client credentials from either HTTP Basic auth or the POST body
// (client_secret_post). Returns the body params too.
async function parseTokenRequest(request: Request): Promise<{
  params: Record<string, string>;
  basicId?: string;
  basicSecret?: string;
}> {
  const params: Record<string, string> = {};
  const contentType = request.headers.get("Content-Type") ?? "";
  if (contentType.includes("application/json")) {
    const json = await request.json<Record<string, unknown>>().catch(() => ({}));
    for (const [k, v] of Object.entries(json)) if (typeof v === "string") params[k] = v;
  } else {
    const form = await request.formData().catch(() => null);
    if (form) for (const [k, v] of form.entries()) if (typeof v === "string") params[k] = v;
  }

  let basicId: string | undefined;
  let basicSecret: string | undefined;
  const auth = request.headers.get("Authorization");
  if (auth?.startsWith("Basic ")) {
    try {
      const decoded = atob(auth.slice(6));
      const idx = decoded.indexOf(":");
      if (idx >= 0) {
        const dec = (s: string) => {
          try {
            return decodeURIComponent(s);
          } catch {
            return s;
          }
        };
        basicId = dec(decoded.slice(0, idx));
        basicSecret = dec(decoded.slice(idx + 1));
      }
    } catch {
      /* malformed Basic header - ignored, falls through to invalid_client */
    }
  }
  return { params, basicId, basicSecret };
}

// POST /oauth/token  (public, on the issuer origin - server-to-server)
//
// Exchanges a single-use authorization code for an id_token + access_token.
// Authenticates the client (secret for confidential clients; PKCE for all),
// atomically consumes the code (replay-proof), and re-checks live account
// standing before minting tokens.
export async function handleOAuthToken(request: Request, env: Env): Promise<Response> {
  const { params, basicId, basicSecret } = await parseTokenRequest(request);

  if (params.grant_type !== "authorization_code") {
    return tokenError("unsupported_grant_type", 400);
  }

  const clientId = basicId ?? params.client_id;
  const clientSecret = basicSecret ?? params.client_secret;
  if (!clientId) return tokenError("invalid_client", 401);

  const client = await env.DB.prepare(
    "SELECT client_id, client_secret_hash, disabled FROM oauth_clients WHERE client_id = ?",
  ).bind(clientId).first<ClientRow>();
  if (!client || client.disabled) return tokenError("invalid_client", 401);

  // Confidential clients (those with a stored secret) MUST authenticate.
  // Public clients (no secret) rely on PKCE alone.
  if (client.client_secret_hash) {
    if (!clientSecret || !(await verifyClientSecret(clientSecret, client.client_secret_hash))) {
      return tokenError("invalid_client", 401);
    }
  }

  const code = params.code;
  const codeVerifier = params.code_verifier;
  const redirectUri = params.redirect_uri;
  if (!code || !codeVerifier || !redirectUri) return tokenError("invalid_request", 400);

  const codeRow = await env.DB.prepare(
    `SELECT code, client_id, user_id, redirect_uri, scope, code_challenge, nonce
     FROM oauth_codes
     WHERE code = ? AND client_id = ? AND redirect_uri = ? AND consumed_at IS NULL AND expires_at > ?`,
  ).bind(code, clientId, redirectUri, Date.now()).first<CodeRow>();
  if (!codeRow) return tokenError("invalid_grant", 400);

  // PKCE proof-of-possession is verified BEFORE the code is consumed. A request
  // with a bad verifier must not be able to burn a still-unredeemed code - for a
  // public (PKCE-only) client the code is observable in the redirect URL, so a
  // consume-then-verify order would let an observer DoS that client's logins.
  if (!(await verifyPkceS256(codeVerifier, codeRow.code_challenge))) {
    return tokenError("invalid_grant", 400);
  }

  // Atomically consume - exactly one caller can win, so a replayed code (or a
  // concurrent double-submit with the correct verifier) fails here with 0 rows.
  const consume = await env.DB.prepare(
    "UPDATE oauth_codes SET consumed_at = ? WHERE code = ? AND consumed_at IS NULL",
  ).bind(Date.now(), codeRow.code).run();
  if ((consume.meta.changes ?? 0) !== 1) return tokenError("invalid_grant", 400);

  const user = await env.DB.prepare(
    "SELECT id, email, name, email_verified, is_admin, moderation, force_password_change FROM users WHERE id = ?",
  ).bind(codeRow.user_id).first<UserRow>();
  if (!user || user.force_password_change) return tokenError("invalid_grant", 400);
  // Re-check live account standing (disabled/suspended) at token time.
  if (checkModeration(user.moderation)) return tokenError("invalid_grant", 400);

  const privateJwk = parsePrivateJwk(env.OIDC_PRIVATE_KEY);
  const issuer = env.OIDC_ISSUER;
  const nowSec = Math.floor(Date.now() / 1000);
  const scopes = new Set(codeRow.scope.split(/\s+/).filter(Boolean));
  const oidcUser: OidcUser = {
    id: user.id,
    email: user.email,
    emailVerified: Boolean(user.email_verified),
    name: user.name,
    isAdmin: Boolean(user.is_admin),
    picture: `${env.APP_ORIGIN}/api/avatar/${user.id}`,
  };

  const idToken = await signRs256(
    buildIdTokenClaims({
      issuer,
      clientId,
      user: oidcUser,
      scopes,
      nonce: codeRow.nonce,
      nowSec,
      ttlSec: OIDC_TOKEN_TTL_SEC,
    }),
    privateJwk,
  );

  const accessToken = await signRs256(
    buildAccessTokenClaims({
      issuer,
      clientId,
      sub: user.id,
      scope: codeRow.scope,
      nowSec,
      ttlSec: OIDC_TOKEN_TTL_SEC,
    }),
    privateJwk,
  );

  return tokenJson({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: OIDC_TOKEN_TTL_SEC,
    id_token: idToken,
    scope: codeRow.scope,
  });
}
