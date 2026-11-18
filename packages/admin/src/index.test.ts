import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The gate itself is the unit under test, so mock only the session
// verification underneath it - the real enforceAdmin middleware, routers,
// sign-in routes and 404/asset fallbacks all run.
vi.mock("./auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./auth")>()),
  requireAdminSession: vi.fn(),
  verifySession: vi.fn(),
}));
vi.mock("./audit", () => ({ writeAdminAudit: vi.fn() }));

import { app } from "./index";
import { requireAdminSession, verifySession } from "./auth";
import { createSqliteD1 } from "../../api/src/test/sqliteD1";
import { seedSession } from "../../api/src/test/session";
import { createFakeIdp } from "../../api/src/test/fakeIdp";
import { setOidcFetchForTests } from "../../api/src/routes/auth";
import { clearOidcCaches } from "../../api/src/account/oidc";

const session = { userId: "admin-1", email: "admin@example.com", expiresAt: Date.now() + 3600_000, isAdmin: true };

function makeLimiter(success = true) {
  return { limit: vi.fn(async () => ({ success })) };
}

// Loose queue-based D1 mock: enough for the routers' happy-path GETs.
function makeDb() {
  const stmt = {
    bind: (..._args: unknown[]) => stmt,
    first: async () => null,
    all: async () => ({ results: [] }),
    run: async () => ({ meta: { changes: 1 } }),
  };
  return {
    prepare: vi.fn(() => stmt),
    batch: vi.fn(async () => []),
  };
}

function makeEnv(overrides: Record<string, unknown> = {}) {
  return {
    DB: makeDb(),
    ASSETS: { get: vi.fn(async () => null), delete: vi.fn(), list: vi.fn(async () => ({ objects: [], truncated: false })) },
    SITE_ASSETS: {
      fetch: vi.fn(async () => new Response("<!doctype html><html></html>", { headers: { "Content-Type": "text/html" } })),
    },
    JWT_SECRET: "secret",
    RATE_LIMITER_ADMIN: makeLimiter(),
    RATE_LIMITER_AVATAR: makeLimiter(),
    ...overrides,
  };
}

const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;

function request(env: ReturnType<typeof makeEnv>, path: string, init?: RequestInit) {
  return app.request(path, init, env as never, ctx);
}

beforeEach(() => {
  vi.clearAllMocks();
});

// Every mounted API group must sit behind enforceAdmin: deleting one
// app.use line in index.ts must flip at least one row of this matrix.
const GATED_GETS = [
  "/api/users/search?q=x",
  "/api/users/u-1",
  "/api/projects",
  "/api/projects/p-1",
  "/api/audit",
  "/api/audit/actions",
];

describe("admin gate route matrix", () => {
  it.each(GATED_GETS)("%s -> 401 when the session is invalid", async (path) => {
    vi.mocked(requireAdminSession).mockResolvedValue(
      Response.json({ ok: false, error: "Unauthorized" }, { status: 401 }),
    );
    const res = await request(makeEnv(), path);
    expect(res.status).toBe(401);
  });

  it.each(GATED_GETS)("%s -> handled (not 401/403) for a valid admin", async (path) => {
    vi.mocked(requireAdminSession).mockResolvedValue(session);
    const res = await request(makeEnv(), path);
    expect([200, 404]).toContain(res.status);
  });

  it.each(GATED_GETS)("%s -> 429 when the IP is over the admin rate limit", async (path) => {
    vi.mocked(requireAdminSession).mockResolvedValue(session);
    const res = await request(makeEnv({ RATE_LIMITER_ADMIN: makeLimiter(false) }), path);
    expect(res.status).toBe(429);
    // The gate must refuse BEFORE touching session verification.
    expect(requireAdminSession).not.toHaveBeenCalled();
  });
});

describe("gated mutations are behind the same gate", () => {
  const MUTATIONS: Array<[string, string]> = [
    ["DELETE", "/api/projects/p-1"],
    ["PATCH", "/api/projects/p-1/features"],
    ["POST", "/api/projects/p-1/reindex"],
    ["POST", "/api/users/u-1/deletion"],
    ["POST", "/api/users/u-1/grant-ink"],
    ["POST", "/api/users/u-1/gift-month"],
    ["POST", "/api/users/u-1/resync-name"],
  ];

  it.each(MUTATIONS)("%s %s -> 401 without a session", async (method, path) => {
    vi.mocked(requireAdminSession).mockResolvedValue(
      Response.json({ ok: false, error: "Unauthorized" }, { status: 401 }),
    );
    const res = await request(makeEnv(), path, { method });
    expect(res.status).toBe(401);
  });
});

describe("/api/verify", () => {
  it("is rate limited (AB-M5)", async () => {
    const res = await request(makeEnv({ RATE_LIMITER_ADMIN: makeLimiter(false) }), "/api/verify");
    expect(res.status).toBe(429);
    expect(verifySession).not.toHaveBeenCalled();
  });

  it("401s a missing/invalid token", async () => {
    vi.mocked(verifySession).mockResolvedValue(null);
    const res = await request(makeEnv(), "/api/verify");
    expect(res.status).toBe(401);
  });

  it("403s a valid non-admin session", async () => {
    vi.mocked(verifySession).mockResolvedValue({ ...session, isAdmin: false });
    const res = await request(makeEnv(), "/api/verify");
    expect(res.status).toBe(403);
  });

  it("passes the execution context so last_used_at can refresh (AB-M7)", async () => {
    vi.mocked(verifySession).mockResolvedValue(session);
    const res = await request(makeEnv(), "/api/verify");
    expect(res.status).toBe(200);
    expect(vi.mocked(verifySession).mock.calls[0][2]).toBe(ctx);
  });
});

describe("sign-in routes", () => {
  afterEach(() => setOidcFetchForTests(undefined));

  it("GET /api/auth/login 503s when OIDC isn't configured", async () => {
    const res = await request(makeEnv(), "/api/auth/login");
    expect(res.status).toBe(503);
    expect(requireAdminSession).not.toHaveBeenCalled();
  });

  it("GET /api/auth/login redirects to the issuer with this panel's client and callback", async () => {
    const idp = await createFakeIdp({
      clients: { "annex-admin": { redirectUris: ["https://admin.test/api/auth/callback"] } },
    });
    setOidcFetchForTests(idp.fetch);
    clearOidcCaches();
    const res = await request(
      makeEnv({ OIDC_ISSUER: idp.issuer, OIDC_CLIENT_ID: "annex-admin", APP_ORIGIN: "https://admin.test" }),
      "/api/auth/login",
    );
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("Location")!);
    expect(`${loc.origin}${loc.pathname}`).toBe(`${idp.issuer}/oauth/authorize`);
    expect(loc.searchParams.get("client_id")).toBe("annex-admin");
    expect(loc.searchParams.get("redirect_uri")).toBe("https://admin.test/api/auth/callback");
    expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it.each([
    ["GET", "/api/auth/login"],
    ["GET", "/api/auth/callback"],
    ["POST", "/api/auth/exchange"],
    ["POST", "/api/auth/logout"],
  ])("%s %s is IP rate limited", async (method, path) => {
    const res = await request(makeEnv({ RATE_LIMITER_ADMIN: makeLimiter(false) }), path, { method });
    expect(res.status).toBe(429);
  });

  it("POST /api/auth/exchange 400s an unknown code", async () => {
    const { db } = createSqliteD1();
    const res = await request(makeEnv({ DB: db }), "/api/auth/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "x".repeat(32) }),
    });
    expect(res.status).toBe(400);
  });
});

describe("logout (AF-S3)", () => {
  it("revokes the caller's admin session without the admin gate and returns a logoutUrl", async () => {
    const { db, sqlite } = createSqliteD1();
    // Not an admin any more: logout must still work (and never consults the gate).
    const token = await seedSession(sqlite, { userId: "u-1", kind: "admin", isAdmin: false });
    const res = await request(makeEnv({ DB: db, JWT_SECRET: "test-secret" }), "/api/auth/logout", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data: { logoutUrl: string } };
    expect(body.ok).toBe(true);
    expect(typeof body.data.logoutUrl).toBe("string");
    expect(requireAdminSession).not.toHaveBeenCalled();
    const row = sqlite.prepare("SELECT revoked_at FROM sessions WHERE id = 's-u-1'").get() as { revoked_at: number | null };
    expect(row.revoked_at).not.toBeNull();
  });

  it("does not revoke a docs-app session presented to the admin logout", async () => {
    const { db, sqlite } = createSqliteD1();
    const token = await seedSession(sqlite, { userId: "u-1", kind: "app" });
    const res = await request(makeEnv({ DB: db, JWT_SECRET: "test-secret" }), "/api/auth/logout", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const row = sqlite.prepare("SELECT revoked_at FROM sessions WHERE id = 's-u-1'").get() as { revoked_at: number | null };
    expect(row.revoked_at).toBeNull();
  });
});

describe("invalid cursors 400 at the HTTP layer", () => {
  it.each([
    "/api/users/search?q=&cursor=garbage",
    "/api/projects?cursor=garbage",
    "/api/audit?cursor=garbage",
  ])("%s -> 400", async (path) => {
    vi.mocked(requireAdminSession).mockResolvedValue(session);
    const res = await request(makeEnv(), path);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/cursor/i);
  });
});

describe("fallbacks", () => {
  it("returns JSON 404 for unknown /api/* paths instead of the SPA shell", async () => {
    vi.mocked(requireAdminSession).mockResolvedValue(session);
    const res = await request(makeEnv(), "/api/nonexistent");
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(false);
  });

  it("serves SPA assets with CSP, frame-ancestors, and X-Frame-Options (AF-S2)", async () => {
    const res = await request(makeEnv(), "/");
    const csp = res.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("uses the dedicated avatar limiter, not the admin API budget", async () => {
    const env = makeEnv({ RATE_LIMITER_AVATAR: makeLimiter(false) });
    const res = await request(env, "/api/avatar/u-1");
    expect(res.status).toBe(429);
    expect((env.RATE_LIMITER_ADMIN as { limit: ReturnType<typeof vi.fn> }).limit).not.toHaveBeenCalled();
  });
});
