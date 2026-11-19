// A minimal in-memory OpenID provider for tests, shaped like auth.cubityfir.st:
// discovery, JWKS, an authorize step (simulating the user signing in), a token
// endpoint that enforces client auth, redirect_uri and PKCE S256, and RS256
// id_tokens. Plug `fetch` into the code under test.
import { b64url } from "../account/jwt";

export interface FakeUser {
  sub: string;
  email: string;
  name: string;
  emailVerified?: boolean;
  roles?: string[];
}

interface CodeGrant {
  user: FakeUser;
  clientId: string;
  redirectUri: string;
  challenge: string;
  nonce: string | null;
  scope: string;
}

export interface FakeIdp {
  issuer: string;
  fetch: typeof fetch;
  // Simulates the browser at the authorization endpoint: validates the
  // request like the real one would and returns the callback URL.
  authorize(authorizeUrl: string, user: FakeUser): string;
  // Knobs for negative tests.
  tamper: { nonce?: string; signWithOtherKey?: boolean; aud?: string; iss?: string; expSec?: number };
  tokenRequests: number;
}

const enc = new TextEncoder();

async function rsaKey(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  ) as Promise<CryptoKeyPair>;
}

async function sign(payload: Record<string, unknown>, key: CryptoKey, kid: string): Promise<string> {
  const header = b64url(enc.encode(JSON.stringify({ alg: "RS256", typ: "JWT", kid })));
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(`${header}.${body}`));
  return `${header}.${body}.${b64url(sig)}`;
}

async function s256(verifier: string): Promise<string> {
  return b64url(await crypto.subtle.digest("SHA-256", enc.encode(verifier)));
}

export async function createFakeIdp(opts: { issuer?: string; clients: Record<string, { secret?: string; redirectUris: string[] }> }): Promise<FakeIdp> {
  const issuer = opts.issuer ?? "https://idp.test";
  const keys = await rsaKey();
  const otherKeys = await rsaKey();
  const kid = "test-key-1";
  const publicJwk = { ...(await crypto.subtle.exportKey("jwk", keys.publicKey)), kid, alg: "RS256", use: "sig" };
  const codes = new Map<string, CodeGrant>();

  const idp: FakeIdp = {
    issuer,
    tamper: {},
    tokenRequests: 0,
    authorize(authorizeUrl, user) {
      const u = new URL(authorizeUrl);
      if (`${u.origin}${u.pathname}` !== `${issuer}/oauth/authorize`) throw new Error(`unexpected authorize URL ${authorizeUrl}`);
      const p = u.searchParams;
      const client = opts.clients[p.get("client_id") ?? ""];
      const redirectUri = p.get("redirect_uri") ?? "";
      if (!client || !client.redirectUris.includes(redirectUri)) throw new Error("bad client/redirect");
      if (p.get("response_type") !== "code" || p.get("code_challenge_method") !== "S256" || !p.get("code_challenge")) {
        throw new Error("bad authorize params");
      }
      const code = crypto.randomUUID();
      codes.set(code, {
        user,
        clientId: p.get("client_id")!,
        redirectUri,
        challenge: p.get("code_challenge")!,
        nonce: p.get("nonce"),
        scope: p.get("scope") ?? "openid",
      });
      const cb = new URL(redirectUri);
      cb.searchParams.set("code", code);
      if (p.get("state")) cb.searchParams.set("state", p.get("state")!);
      cb.searchParams.set("iss", issuer);
      return cb.toString();
    },
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      const url = new URL(req.url);
      if (url.pathname === "/.well-known/openid-configuration") {
        return Response.json({
          issuer,
          authorization_endpoint: `${issuer}/oauth/authorize`,
          token_endpoint: `${issuer}/oauth/token`,
          userinfo_endpoint: `${issuer}/oauth/userinfo`,
          jwks_uri: `${issuer}/oauth/jwks`,
          end_session_endpoint: `${issuer}/oauth/logout`,
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
          authorization_response_iss_parameter_supported: true,
        });
      }
      if (url.pathname === "/oauth/jwks") return Response.json({ keys: [publicJwk] });
      if (url.pathname === "/oauth/token" && req.method === "POST") {
        idp.tokenRequests++;
        const form = new URLSearchParams(await req.text());
        let clientId = form.get("client_id") ?? "";
        let secret = form.get("client_secret") ?? undefined;
        const basic = req.headers.get("Authorization");
        if (basic?.startsWith("Basic ")) {
          const [id, s] = atob(basic.slice(6)).split(":").map(decodeURIComponent);
          clientId = id;
          secret = s;
        }
        const client = opts.clients[clientId];
        if (!client || (client.secret && client.secret !== secret)) return Response.json({ error: "invalid_client" }, { status: 401 });
        const grant = codes.get(form.get("code") ?? "");
        if (!grant || grant.clientId !== clientId || grant.redirectUri !== form.get("redirect_uri")) {
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        }
        if ((await s256(form.get("code_verifier") ?? "")) !== grant.challenge) return Response.json({ error: "invalid_grant" }, { status: 400 });
        codes.delete(form.get("code")!);
        const now = Math.floor(Date.now() / 1000);
        const scopes = new Set(grant.scope.split(" "));
        const claims: Record<string, unknown> = {
          iss: idp.tamper.iss ?? issuer,
          sub: grant.user.sub,
          aud: idp.tamper.aud ?? clientId,
          iat: now,
          exp: idp.tamper.expSec ?? now + 3600,
          auth_time: now,
          sid: "idp-session-1",
          ...(grant.nonce || idp.tamper.nonce ? { nonce: idp.tamper.nonce ?? grant.nonce } : {}),
          ...(scopes.has("email") ? { email: grant.user.email, email_verified: grant.user.emailVerified ?? true } : {}),
          ...(scopes.has("profile") ? { name: grant.user.name } : {}),
          ...(scopes.has("roles") ? { roles: grant.user.roles ?? ["user"] } : {}),
        };
        const idToken = await sign(claims, idp.tamper.signWithOtherKey ? otherKeys.privateKey : keys.privateKey, kid);
        return Response.json(
          { access_token: "at-" + crypto.randomUUID(), token_type: "Bearer", expires_in: 3600, id_token: idToken, scope: grant.scope },
          { headers: { "Cache-Control": "no-store" } },
        );
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch,
  };
  return idp;
}
