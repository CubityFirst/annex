# Prompt: wire up "Sign in with Annex" (OIDC)

Copy everything in the block below into the other project's Claude agent. First
replace the three `<…>` placeholders with the values from
`scripts/register-oauth-client.mjs` (and the exact callback URL you registered).

> ⚠️ The callback/redirect URL you put below must be registered **exactly** with
> the Annex provider (it's an exact-match allowlist). If you change it, re-register.

---

```
Add "Sign in with Annex" to this project. Annex is a standard OpenID Connect
(OIDC) provider — use a well-maintained OIDC client library for this stack, not
a hand-rolled flow.

PROVIDER (everything else is discoverable):
- Issuer:        https://auth.cubityfir.st
- Discovery:     https://auth.cubityfir.st/.well-known/openid-configuration
- Flow:          Authorization Code + PKCE (S256). id_tokens are RS256; verify
                 offline via the provider's JWKS (in the discovery doc).
- Scopes:        openid profile email
- Claims you get: sub (stable unique user id — key your users on THIS, never on
                  email), email, email_verified, name, picture (avatar URL; may
                  404 if the user has no avatar — fall back to your own placeholder).

CREDENTIALS (store the secret server-side only — never ship it to the browser):
- client_id:     <ANNEX_CLIENT_ID>
- client_secret: <ANNEX_CLIENT_SECRET>     (omit if this is a public/SPA client)
- redirect_uri:  <YOUR_EXACT_CALLBACK_URL> (e.g. https://app.example.com/api/auth/callback/annex)

REQUIREMENTS:
1. Configure the OIDC client from the discovery URL — do NOT hardcode the
   authorization/token/userinfo/jwks endpoints (the authorization endpoint is on
   a different host than the issuer; discovery handles that for you).
2. Use Authorization Code flow with PKCE (code_challenge_method=S256).
3. Send and verify `state` (CSRF) and a `nonce` (bound into the id_token).
4. Request scope "openid profile email".
5. On callback: exchange the code at the token endpoint (send the PKCE
   code_verifier; include the client_secret only for a confidential/server-side
   client), then VERIFY the id_token: signature against JWKS, and the iss, aud
   (== client_id), exp, and nonce claims. Most OIDC libraries do this for you —
   make sure it's enabled, not skipped.
6. Establish your app's own session from the verified identity. Use `sub` as the
   primary key for the Annex identity; treat email as mutable.
7. The redirect_uri registered with Annex must match byte-for-byte what your app
   sends (scheme, host, port, path).
8. (If this client was granted the `roles` scope) the id_token / userinfo carry a
   `roles` string array. Gate admin-only features on `roles.includes("admin")` —
   do NOT hardcode a user id or email for admin access.

STACK-SPECIFIC GUIDANCE (pick what fits this project):
- Next.js / Auth.js (NextAuth): add a custom OIDC provider with
  `{ id: "annex", name: "Annex", type: "oidc", issuer: "https://auth.cubityfir.st",
     clientId, clientSecret, authorization: { params: { scope: "openid profile email" } },
     checks: ["pkce", "state", "nonce"] }`. Auth.js fetches discovery + JWKS and
  verifies the id_token automatically.
- Node/Express: use `openid-client`. `Issuer.discover("https://auth.cubityfir.st")`,
  then a `Client`, then `generators.codeVerifier()`/`codeChallenge()`, `client.authorizationUrl(...)`,
  and `client.callback(...)` (which validates the id_token, state, nonce, PKCE).
- Python: `authlib` (`authlib.integrations.*` OAuth with
  `server_metadata_url=".../.well-known/openid-configuration"`).
- Go: `coreos/go-oidc` + `golang.org/x/oauth2` (provider via `oidc.NewProvider`,
  verify with `provider.Verifier`).
- Anything else: any conformant OIDC/OAuth2-with-PKCE client works — point it at
  the discovery URL.

Then:
- Add a "Sign in with Annex" button that starts the flow.
- Store the client_secret in the project's secret manager / env (never in client
  code or the repo).
- Tell me the EXACT callback URL you wired up so it can be registered with Annex
  (or confirm it matches <YOUR_EXACT_CALLBACK_URL> above).
- Verify end-to-end: click the button, sign in, confirm a session is created and
  the id_token's signature/iss/aud/nonce are validated. Show me the verified
  claims you receive.
```

---

## If it's a browser-only SPA (no backend)

Register the client with `--public` (no secret), and have the agent use a
browser OIDC library with PKCE (e.g. `oidc-client-ts`). The token endpoint
accepts public clients with PKCE and no secret. Never embed a `client_secret` in
front-end code.
