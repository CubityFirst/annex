# Sign in with cubityfir.st

Annex is no longer an OpenID Connect provider. Since 2026-11-18 the identity
provider for every cubityfir.st service, Annex included, is the standalone
`cubityfirst-auth` worker at **https://auth.cubityfir.st**: hosted sign-in,
registration, account and security pages, OIDC endpoints, and client
management at `https://auth.cubityfir.st/admin/clients`.

- Discovery: `https://auth.cubityfir.st/.well-known/openid-configuration`
- Authorization endpoint: `https://auth.cubityfir.st/oauth/authorize`
  (the old `https://docs.cubityfir.st/oauth/authorize` redirects there, query
  string included)
- Issuer, `sub` values (= Annex user ids) and existing client ids are
  unchanged; the signing key is new, so verify id_tokens against the JWKS
  from discovery.

To connect a service, follow `docs/CONNECTING.md` in the `cubityfirst-auth`
repository. Workers on the `cubityfir.st` zone must reach the provider over a
service binding to `cubityfirst-auth` for every server-side request
(discovery, JWKS, token, userinfo): a Worker's `fetch()` to another Worker's
hostname on the same zone goes to the origin, not to that Worker.
