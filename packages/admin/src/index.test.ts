import { describe, it, expect, vi, beforeEach } from "vitest";

// The gate itself is the unit under test, so mock only the session
// verification underneath it - the real enforceAdmin middleware, routers,
// and 404/asset fallbacks all run.
vi.mock("./auth", () => ({
  requireAdminSession: vi.fn(),
  verifySession: vi.fn(),
}));
vi.mock("./audit", () => ({ writeAdminAudit: vi.fn() }));

import app from "./index";
import { requireAdminSession, verifySession } from "./auth";

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
    AUTH_DB: makeDb(),
    ASSETS: { get: vi.fn(async () => null), delete: vi.fn(), list: vi.fn(async () => ({ objects: [], truncated: false })) },
    SITE_ASSETS: {
      fetch: vi.fn(async () => new Response("<!doctype html><html></html>", { headers: { "Content-Type": "text/html" } })),
    },
    AUTH: { fetch: vi.fn(async () => Response.json({ ok: true, data: {} })) },
    JWT_SECRET: "secret",
    RATE_LIMITER_ADMIN: makeLimiter(),
    RATE_LIMITER_ADMIN_HANDOFF: makeLimiter(),
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
  "/api/oauth-clients",
];

describe("admin gate route matrix", () => {
  it.each(GATED_GETS)("%s -> 401 when the session is invalid", async (path) => {
    vi.mocked(requireAdminSession).mockResolvedValue(
      Response.json({ ok: false, error: "Unauthorized" }, { status: 401 }),
    );
    const res = await request(makeEnv(), path);
    expect(res.status).toBe(401);
  });

  it.each(GATED_GETS)("%s -> 403 when the caller is not an admin", async (path) => {
    vi.mocked(requireAdminSession).mockResolvedValue(
      Response.json({ ok: false, error: "Forbidden" }, { status: 403 }),
    );
    const res = await request(makeEnv(), path);
    expect(res.status).toBe(403);
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
    ["PATCH", "/api/users/u-1"],
    ["POST", "/api/users/u-1/grant-ink"],
    ["POST", "/api/users/u-1/gift-month"],
    ["POST", "/api/oauth-clients/delete"],
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

describe("handoff exchange proxy", () => {
  it("forwards X-Client-IP and User-Agent across the service-binding hop (AB-M1)", async () => {
    const env = makeEnv();
    await request(env, "/api/auth/handoff/exchange", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "CF-Connecting-IP": "203.0.113.9",
        "User-Agent": "TestBrowser/1.0",
      },
      body: JSON.stringify({ code: "c", callbackUrl: "https://admin.example/auth/callback" }),
    });
    const authFetch = (env.AUTH as { fetch: ReturnType<typeof vi.fn> }).fetch;
    expect(authFetch).toHaveBeenCalledTimes(1);
    const init = authFetch.mock.calls[0][1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get("X-Client-IP")).toBe("203.0.113.9");
    expect(headers.get("User-Agent")).toBe("TestBrowser/1.0");
  });
});

describe("logout proxy (AF-S3)", () => {
  it("forwards the bearer token to the auth worker's /sessions/logout", async () => {
    const env = makeEnv();
    const res = await request(env, "/api/auth/logout", {
      method: "POST",
      headers: { Authorization: "Bearer tok" },
    });
    expect(res.status).toBe(200);
    const authFetch = (env.AUTH as { fetch: ReturnType<typeof vi.fn> }).fetch;
    expect(authFetch).toHaveBeenCalledWith(
      "https://auth/sessions/logout",
      expect.objectContaining({ method: "POST" }),
    );
    const init = authFetch.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer tok");
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
