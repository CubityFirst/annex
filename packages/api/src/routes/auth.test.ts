// Sign in with auth.cubityfir.st, end to end through the worker's fetch
// handler against a fake OpenID provider and a real SQLite main DB.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createSqliteD1, type SqliteD1 } from "../test/sqliteD1";
import { createFakeIdp, type FakeIdp, type FakeUser } from "../test/fakeIdp";
import { setOidcFetchForTests, STATE_COOKIE } from "./auth";
import { clearOidcCaches, identityFetch } from "../account/oidc";
import { clearIdentityCache, type IdentityService, type IdentityUser } from "../account/identity";
import worker, { type Env } from "../index";

const APP = "https://docs.test";
const CALLBACK = `${APP}/api/auth/callback`;
const SECRET = "jwt-secret";

let db: SqliteD1;
let idp: FakeIdp;
let identity: { getUser: ReturnType<typeof vi.fn>; getUsers: ReturnType<typeof vi.fn>; findUserByEmail: ReturnType<typeof vi.fn>; listDeletedUsers: ReturnType<typeof vi.fn> };
let extraEnv: Partial<Env>;

const ALICE: FakeUser = { sub: "user-alice", email: "alice@example.com", name: "Alice", roles: ["user"] };

function identityUser(over: Partial<IdentityUser> = {}): IdentityUser {
  return { id: ALICE.sub, email: ALICE.email, name: ALICE.name, emailVerified: true, isAdmin: false, status: "active", suspendedUntil: null, createdAt: "2025-01-01T00:00:00.000Z", ...over };
}

function env(): Env {
  return {
    DB: db.db,
    JWT_SECRET: SECRET,
    OIDC_ISSUER: idp.issuer,
    OIDC_CLIENT_ID: "annex-docs",
    OIDC_CLIENT_SECRET: "s3cret",
    APP_ORIGIN: APP,
    IDENTITY: identity as unknown as IdentityService,
    ...extraEnv,
  } as unknown as Env;
}

function call(method: string, path: string, init: { token?: string; cookie?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  if (init.cookie) headers.Cookie = init.cookie;
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  return worker.fetch(new Request(`https://api${path}`, {
    method,
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    redirect: "manual",
  }), env());
}

function cookieFrom(res: Response): string {
  const set = res.headers.get("Set-Cookie") ?? "";
  return set.split(";")[0];
}

function fragment(res: Response): URLSearchParams {
  const loc = res.headers.get("Location")!;
  expect(loc.startsWith(`${APP}/auth/complete#`)).toBe(true);
  return new URLSearchParams(loc.slice(loc.indexOf("#") + 1));
}

// login -> authorize at the IdP -> callback; returns the callback response.
async function signIn(user: FakeUser = ALICE, returnTo = "/projects"): Promise<Response> {
  const login = await call("GET", `/auth/login?return_to=${encodeURIComponent(returnTo)}`);
  expect(login.status).toBe(302);
  const callbackUrl = new URL(idp.authorize(login.headers.get("Location")!, user));
  return call("GET", `/auth/callback${callbackUrl.search}`, { cookie: cookieFrom(login) });
}

async function signInToken(user: FakeUser = ALICE): Promise<string> {
  const cb = await signIn(user);
  const code = fragment(cb).get("code")!;
  const ex = await call("POST", "/auth/exchange", { body: { code } });
  expect(ex.status).toBe(200);
  return ((await ex.json()) as { data: { token: string } }).data.token;
}

beforeEach(async () => {
  db = createSqliteD1();
  idp = await createFakeIdp({ clients: { "annex-docs": { secret: "s3cret", redirectUris: [CALLBACK] } } });
  setOidcFetchForTests(idp.fetch);
  clearOidcCaches();
  clearIdentityCache();
  extraEnv = {};
  identity = {
    getUser: vi.fn(async () => identityUser()),
    getUsers: vi.fn(async () => []),
    findUserByEmail: vi.fn(async () => null),
    listDeletedUsers: vi.fn(async () => []),
  };
});

afterEach(() => setOidcFetchForTests(undefined));

describe("GET /auth/login", () => {
  it("redirects to the issuer's authorize endpoint with PKCE, state and nonce, and sets a sealed state cookie", async () => {
    const res = await call("GET", "/auth/login?return_to=/projects/p1");
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("Location")!);
    expect(`${loc.origin}${loc.pathname}`).toBe(`${idp.issuer}/oauth/authorize`);
    expect(loc.searchParams.get("client_id")).toBe("annex-docs");
    expect(loc.searchParams.get("redirect_uri")).toBe(CALLBACK);
    expect(loc.searchParams.get("scope")).toBe("openid profile email roles");
    expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
    expect(loc.searchParams.get("state")).toBeTruthy();
    expect(loc.searchParams.get("nonce")).toBeTruthy();
    const cookie = res.headers.get("Set-Cookie")!;
    expect(cookie).toContain(`${STATE_COOKIE}=`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("Path=/api/auth");
  });

  it("only passes prompt=login through", async () => {
    const forced = new URL((await call("GET", "/auth/login?prompt=login")).headers.get("Location")!);
    expect(forced.searchParams.get("prompt")).toBe("login");
    const other = new URL((await call("GET", "/auth/login?prompt=none")).headers.get("Location")!);
    expect(other.searchParams.has("prompt")).toBe(false);
  });

  it("503s when sign-in isn't configured", async () => {
    extraEnv = { OIDC_CLIENT_ID: undefined };
    expect((await call("GET", "/auth/login")).status).toBe(503);
  });
});

describe("GET /auth/callback", () => {
  it("verifies the id_token, upserts the users mirror and hands the SPA a single-use code", async () => {
    const res = await signIn(ALICE, "/projects/p1");
    expect(res.status).toBe(302);
    expect(res.headers.get("Set-Cookie")).toContain("Max-Age=0");
    const frag = fragment(res);
    expect(frag.get("return_to")).toBe("/projects/p1");
    const code = frag.get("code")!;
    expect(code.length).toBeGreaterThan(20);

    expect(db.sqlite.prepare("SELECT email, name, is_admin, status FROM users WHERE id = ?").get(ALICE.sub))
      .toEqual({ email: ALICE.email, name: ALICE.name, is_admin: 0, status: "active" });
    const session = db.sqlite.prepare("SELECT kind, id_token, handoff_hash FROM sessions WHERE user_id = ?").get(ALICE.sub) as Record<string, string>;
    expect(session.kind).toBe("app");
    expect(session.id_token.split(".")).toHaveLength(3);
    expect(session.handoff_hash).toBeTruthy();

    const ex = await call("POST", "/auth/exchange", { body: { code } });
    expect(ex.status).toBe(200);
    const token = ((await ex.json()) as { data: { token: string } }).data.token;
    // The code is single use.
    expect((await call("POST", "/auth/exchange", { body: { code } })).status).toBe(400);

    const me = await call("GET", "/me/favourite-sites", { token });
    expect(me.status).toBe(200);
  });

  it("refreshes name/email on the mirror and the member snapshots at sign-in", async () => {
    await signInToken();
    db.sqlite.prepare("INSERT INTO projects (id, name, owner_id, created_at) VALUES ('p1', 'P', 'x', 't')").run();
    db.sqlite.prepare("INSERT INTO project_members (id, project_id, user_id, email, name, role, invited_by, created_at) VALUES ('m1', 'p1', ?, 'old@example.com', 'Old', 'editor', 'x', 't')").run(ALICE.sub);
    await signInToken({ ...ALICE, name: "Alice Liddell", email: "liddell@example.com" });
    expect(db.sqlite.prepare("SELECT name, email FROM users WHERE id = ?").get(ALICE.sub)).toEqual({ name: "Alice Liddell", email: "liddell@example.com" });
    expect(db.sqlite.prepare("SELECT name, email FROM project_members WHERE id = 'm1'").get()).toEqual({ name: "Alice Liddell", email: "liddell@example.com" });
  });

  it("records admin from the roles claim", async () => {
    await signInToken({ ...ALICE, roles: ["user", "admin"] });
    expect(db.sqlite.prepare("SELECT is_admin FROM users WHERE id = ?").get(ALICE.sub)).toEqual({ is_admin: 1 });
  });

  it("refuses a callback without the state cookie", async () => {
    const login = await call("GET", "/auth/login");
    const cb = new URL(idp.authorize(login.headers.get("Location")!, ALICE));
    const res = await call("GET", `/auth/callback${cb.search}`);
    expect(fragment(res).get("error")).toBe("login_expired");
    expect(idp.tokenRequests).toBe(0);
  });

  it("refuses a forged state cookie", async () => {
    const login = await call("GET", "/auth/login");
    const cb = new URL(idp.authorize(login.headers.get("Location")!, ALICE));
    const [name, value] = cookieFrom(login).split("=");
    const [body] = value.split(".");
    const res = await call("GET", `/auth/callback${cb.search}`, { cookie: `${name}=${body}.AAAA` });
    expect(fragment(res).get("error")).toBe("login_expired");
  });

  it("refuses a state mismatch (callback from another login)", async () => {
    const first = await call("GET", "/auth/login");
    const second = await call("GET", "/auth/login");
    const cb = new URL(idp.authorize(first.headers.get("Location")!, ALICE));
    const res = await call("GET", `/auth/callback${cb.search}`, { cookie: cookieFrom(second) });
    expect(fragment(res).get("error")).toBeTruthy();
    expect(fragment(res).get("code")).toBeNull();
    expect(idp.tokenRequests).toBe(0);
  });

  it("refuses an id_token with the wrong nonce", async () => {
    idp.tamper.nonce = "attacker-nonce";
    const res = await signIn();
    expect(fragment(res).get("error")).toBe("invalid_token_response");
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 0 });
  });

  it("refuses an id_token for another audience", async () => {
    idp.tamper.aud = "someone-else";
    expect(fragment(await signIn()).get("error")).toBe("invalid_token_response");
  });

  it("refuses an id_token from another issuer", async () => {
    idp.tamper.iss = "https://evil.test";
    expect(fragment(await signIn()).get("error")).toBe("invalid_token_response");
  });

  it("refuses an expired id_token", async () => {
    idp.tamper.expSec = Math.floor(Date.now() / 1000) - 3600;
    expect(fragment(await signIn()).get("error")).toBe("invalid_token_response");
  });

  it("refuses an id_token whose signature doesn't verify against the JWKS", async () => {
    idp.tamper.signWithOtherKey = true;
    expect(fragment(await signIn()).get("error")).toBe("invalid_signature");
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM users").get()).toEqual({ n: 0 });
  });

  it("passes an OAuth error code through, never the description", async () => {
    const login = await call("GET", "/auth/login");
    const res = await call("GET", "/auth/callback?error=access_denied&error_description=%3Cscript%3E", { cookie: cookieFrom(login) });
    const frag = fragment(res);
    expect(frag.get("error")).toBe("access_denied");
    expect([...frag.keys()]).toEqual(["error"]);
  });

  it("refuses a user whose Annex data is scheduled for deletion", async () => {
    await signInToken();
    db.sqlite.prepare("INSERT INTO user_deletions (user_id, id, requested_by, requested_by_email, execute_after) VALUES (?, 'd1', 'admin', 'a@x', 0)").run(ALICE.sub);
    expect(fragment(await signIn()).get("error")).toBe("account_disabled");
  });

  it("refuses an account Annex has processed as deleted on the identity service", async () => {
    db.sqlite.prepare("INSERT INTO identity_deletions (user_id, deleted_at, deleted_by) VALUES (?, 1, 'self')").run(ALICE.sub);
    expect(fragment(await signIn()).get("error")).toBe("account_deleted");
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM users").get()).toEqual({ n: 0 });
  });

  it("falls back to / for an off-site return_to", async () => {
    for (const bad of ["https://evil.test/", "//evil.test", "/\\evil.test", "javascript:alert(1)"]) {
      const res = await signIn(ALICE, bad);
      expect(fragment(res).get("return_to")).toBe("/");
    }
  });
});

describe("server-side OIDC requests over the IDENTITY_OIDC service binding", () => {
  it("does discovery, JWKS and the token exchange through the binding, never a direct fetch", async () => {
    const direct = vi.fn(async () => { throw new Error("same-zone fetch would hit the origin"); });
    setOidcFetchForTests(direct as unknown as typeof fetch);
    const viaBinding = vi.fn((url: string, init?: RequestInit) => idp.fetch(url, init));
    extraEnv = { IDENTITY_OIDC: { fetch: viaBinding } as unknown as Fetcher };

    const token = await signInToken();
    expect(token.split(".")).toHaveLength(3);
    expect(direct).not.toHaveBeenCalled();
    const paths = viaBinding.mock.calls.map(([u]) => new URL(u).pathname);
    expect(paths).toEqual(expect.arrayContaining(["/.well-known/openid-configuration", "/oauth/token", "/oauth/jwks"]));
    // The browser still goes to the public authorize URL.
    const login = await call("GET", "/auth/login");
    expect(login.headers.get("Location")!.startsWith(`${idp.issuer}/oauth/authorize?`)).toBe(true);
  });
});

describe("identityFetch", () => {
  const ISSUER = "https://auth.example";
  it("routes only the issuer's host through the binding", async () => {
    const binding = { fetch: vi.fn(async () => new Response("b")) };
    const direct = vi.fn(async () => new Response("d"));
    const f = identityFetch({ issuer: ISSUER, binding, fetchImpl: direct as unknown as typeof fetch });
    expect(await (await f(`${ISSUER}/oauth/token`, { method: "POST", body: "x" })).text()).toBe("b");
    expect(await (await f("https://elsewhere.example/x")).text()).toBe("d");
  });

  it("never falls back to a direct fetch outside local dev", async () => {
    const binding = { fetch: vi.fn(async () => new Response("down", { status: 503 })) };
    const direct = vi.fn(async () => new Response("d"));
    const f = identityFetch({ issuer: ISSUER, binding, fetchImpl: direct as unknown as typeof fetch });
    expect((await f(`${ISSUER}/oauth/jwks`)).status).toBe(503);
    expect(direct).not.toHaveBeenCalled();
  });

  it("falls back to the public issuer in local dev when the binding has no target", async () => {
    const direct = vi.fn(async (_u: string, init?: RequestInit) => new Response(String(init?.body ?? "")));
    for (const binding of [
      { fetch: vi.fn(async () => new Response("no local session", { status: 503 })) },
      { fetch: vi.fn(async () => { throw new Error("binding unavailable"); }) },
    ]) {
      const f = identityFetch({ issuer: ISSUER, binding, allowPublicFallback: true, fetchImpl: direct as unknown as typeof fetch });
      expect(await (await f(`${ISSUER}/oauth/token`, { method: "POST", body: "grant" })).text()).toBe("grant");
    }
  });
});

describe("session standing", () => {
  it("locks out a user disabled on the identity service", async () => {
    const token = await signInToken();
    clearIdentityCache();
    identity.getUser.mockResolvedValue(identityUser({ status: "disabled" }));
    const res = await call("GET", "/me/favourite-sites", { token });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "account_disabled" });
    expect(db.sqlite.prepare("SELECT status FROM users WHERE id = ?").get(ALICE.sub)).toEqual({ status: "disabled" });
  });

  it("reports a suspension with its end", async () => {
    const token = await signInToken();
    clearIdentityCache();
    const until = Math.floor(Date.now() / 1000) + 600;
    identity.getUser.mockResolvedValue(identityUser({ status: "suspended", suspendedUntil: until }));
    const res = await call("GET", "/me/favourite-sites", { token });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "account_suspended", until });
  });

  it("treats an account deleted on the identity service as signed out", async () => {
    const token = await signInToken();
    clearIdentityCache();
    identity.getUser.mockResolvedValue(null);
    expect((await call("GET", "/me/favourite-sites", { token })).status).toBe(401);
  });

  it("caches standing per isolate instead of calling the identity service on every request", async () => {
    const token = await signInToken();
    identity.getUser.mockClear();
    for (let i = 0; i < 3; i++) expect((await call("GET", "/me/favourite-sites", { token })).status).toBe(200);
    expect(identity.getUser).toHaveBeenCalledTimes(1);
  });

  it("falls back to the mirror's standing when the identity service is unreachable", async () => {
    const token = await signInToken();
    clearIdentityCache();
    identity.getUser.mockRejectedValue(new Error("service binding unavailable"));
    expect((await call("GET", "/me/favourite-sites", { token })).status).toBe(200);
    db.sqlite.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").run(ALICE.sub);
    expect((await call("GET", "/me/favourite-sites", { token })).status).toBe(403);
  });

  it("blocks an existing session as soon as an admin deletion is scheduled", async () => {
    const token = await signInToken();
    db.sqlite.prepare("INSERT INTO user_deletions (user_id, id, requested_by, requested_by_email, execute_after) VALUES (?, 'd1', 'admin', 'a@x', 0)").run(ALICE.sub);
    expect((await call("GET", "/me/favourite-sites", { token })).status).toBe(403);
  });

  it("refuses an app token on a session of the admin kind", async () => {
    const token = await signInToken();
    db.sqlite.prepare("UPDATE sessions SET kind = 'admin'").run();
    expect((await call("GET", "/me/favourite-sites", { token })).status).toBe(401);
  });
});

describe("POST /auth/logout", () => {
  it("revokes the Annex session and returns the end-session URL with id_token_hint", async () => {
    const token = await signInToken();
    const idToken = (db.sqlite.prepare("SELECT id_token FROM sessions").get() as { id_token: string }).id_token;
    const res = await call("POST", "/auth/logout", { token });
    expect(res.status).toBe(200);
    const url = new URL(((await res.json()) as { data: { logoutUrl: string } }).data.logoutUrl);
    expect(`${url.origin}${url.pathname}`).toBe(`${idp.issuer}/oauth/logout`);
    expect(url.searchParams.get("id_token_hint")).toBe(idToken);
    expect(url.searchParams.get("post_logout_redirect_uri")).toBe(`${APP}/`);
    expect((await call("GET", "/me/favourite-sites", { token })).status).toBe(401);
  });

  it("still signs a disabled user out", async () => {
    const token = await signInToken();
    clearIdentityCache();
    identity.getUser.mockResolvedValue(identityUser({ status: "disabled" }));
    const res = await call("POST", "/auth/logout", { token });
    expect(res.status).toBe(200);
    expect(db.sqlite.prepare("SELECT revoked_at IS NOT NULL AS r FROM sessions").get()).toEqual({ r: 1 });
  });
});

describe("POST /dev/quick-login", () => {
  it("is a 404 unless DEV_QUICK_LOGIN is on AND the app origin is localhost", async () => {
    extraEnv = { DEV_QUICK_LOGIN: "true" };
    expect((await call("POST", "/dev/quick-login", { body: { variant: "standard-free" } })).status).toBe(404);
    extraEnv = { APP_ORIGIN: "http://localhost:5173" };
    expect((await call("POST", "/dev/quick-login", { body: { variant: "standard-free" } })).status).toBe(404);
  });

  it("mints a mirror-only dev user and a working session without asking the identity service", async () => {
    extraEnv = { DEV_QUICK_LOGIN: "true", APP_ORIGIN: "http://localhost:5173" };
    const res = await call("POST", "/dev/quick-login", { body: { email: "E2E-a@example.com", name: "E2E A" } });
    expect(res.status).toBe(200);
    const { token, userId } = ((await res.json()) as { data: { token: string; userId: string } }).data;
    expect(userId.startsWith("dev-")).toBe(true);
    identity.getUser.mockResolvedValue(null);
    expect((await call("GET", "/me/favourite-sites", { token })).status).toBe(200);
    expect(identity.getUser).not.toHaveBeenCalled();
    // Same email signs back in as the same dev user.
    const again = await call("POST", "/dev/quick-login", { body: { email: "e2e-a@example.com" } });
    expect(((await again.json()) as { data: { userId: string } }).data.userId).toBe(userId);
  });
});
