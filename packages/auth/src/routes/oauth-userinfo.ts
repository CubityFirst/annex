import { parsePrivateJwk, scopedClaims, verifyRs256, type OidcUser } from "../oidc";
import { checkModeration } from "./login";
import type { Env } from "../index";

interface UserRow {
  id: string;
  email: string;
  name: string;
  email_verified: number;
  is_admin: number;
  moderation: number;
  force_password_change: number;
}

function unauthorized(description: string): Response {
  // Per RFC 6750, signal bearer-token problems via WWW-Authenticate.
  return new Response(JSON.stringify({ error: "invalid_token", error_description: description }), {
    status: 401,
    headers: {
      "Content-Type": "application/json",
      "WWW-Authenticate": `Bearer error="invalid_token", error_description="${description}"`,
      "Cache-Control": "no-store",
    },
  });
}

// GET|POST /oauth/userinfo  (public, on the issuer origin)
//
// Returns the standard OIDC claims for the subject of a valid access token,
// filtered by the token's granted scope. Claims are read live from the DB
// (not the token) so email/name changes and account suspension take effect
// immediately.
export async function handleOAuthUserinfo(request: Request, env: Env): Promise<Response> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return unauthorized("missing bearer token");

  const privateJwk = parsePrivateJwk(env.OIDC_PRIVATE_KEY);
  const payload = await verifyRs256(authHeader.slice(7), privateJwk);
  if (!payload) return unauthorized("invalid or expired token");
  if (payload.token_use !== "access") return unauthorized("not an access token");
  if (payload.iss !== env.OIDC_ISSUER) return unauthorized("wrong issuer");
  if (typeof payload.sub !== "string" || typeof payload.aud !== "string") {
    return unauthorized("malformed token");
  }

  // Mirror the token endpoint's disabled-client refusal so flipping
  // disabled=1 cuts off a client's already-issued access tokens too — not just
  // new ones. (Also a belt-and-braces audience check.)
  const client = await env.DB.prepare(
    "SELECT disabled FROM oauth_clients WHERE client_id = ?",
  ).bind(payload.aud).first<{ disabled: number }>();
  if (!client || client.disabled) return unauthorized("client no longer authorized");

  const user = await env.DB.prepare(
    "SELECT id, email, name, email_verified, is_admin, moderation, force_password_change FROM users WHERE id = ?",
  ).bind(payload.sub).first<UserRow>();
  if (!user || user.force_password_change || checkModeration(user.moderation)) {
    return unauthorized("subject no longer valid");
  }

  const scopes = new Set(String(payload.scope ?? "").split(/\s+/).filter(Boolean));
  const oidcUser: OidcUser = {
    id: user.id,
    email: user.email,
    emailVerified: Boolean(user.email_verified),
    name: user.name,
    isAdmin: Boolean(user.is_admin),
    picture: `${env.APP_ORIGIN}/api/avatar/${user.id}`,
  };

  return Response.json(scopedClaims(oidcUser, scopes), {
    headers: { "Cache-Control": "no-store" },
  });
}
