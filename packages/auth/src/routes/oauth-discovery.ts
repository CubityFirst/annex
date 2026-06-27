import { buildDiscoveryDocument, derivePublicJwk, parsePrivateJwk } from "../oidc";
import type { Env } from "../index";

// GET /.well-known/openid-configuration  (public, on the issuer origin)
//
// The OIDC discovery document. Standard clients read this from
// `${issuer}/.well-known/openid-configuration` and self-configure every
// endpoint from it. Safe to cache - it only changes on a config/key roll.
export function handleOAuthDiscovery(_request: Request, env: Env): Response {
  const doc = buildDiscoveryDocument(env.OIDC_ISSUER, env.OIDC_AUTHORIZE_URL);
  return Response.json(doc, {
    headers: { "Cache-Control": "public, max-age=3600" },
  });
}

// GET /oauth/jwks  (public, on the issuer origin)
//
// Publishes the RSA public key(s) so clients can verify id_tokens offline.
// Derived from the private signing JWK with the private fields stripped.
export function handleOAuthJwks(_request: Request, env: Env): Response {
  const publicJwk = derivePublicJwk(parsePrivateJwk(env.OIDC_PRIVATE_KEY));
  return Response.json(
    { keys: [publicJwk] },
    { headers: { "Cache-Control": "public, max-age=3600" } },
  );
}
