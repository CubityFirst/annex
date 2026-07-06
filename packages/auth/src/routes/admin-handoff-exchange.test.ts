import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../admin-handoff", () => ({
  normalizeAdminCallbackUrl: vi.fn(),
  writeAdminHandoffAudit: vi.fn(),
}));
vi.mock("../sessions", async (orig) => ({
  ...(await orig<typeof import("../sessions")>()),
  createSession: vi.fn(),
}));
vi.mock("../jwt", () => ({ signJwt: vi.fn(async () => "signed-jwt") }));

import { handleAdminHandoffExchange } from "./admin-handoff-exchange";
import { normalizeAdminCallbackUrl, writeAdminHandoffAudit } from "../admin-handoff";
import { createSession, ADMIN_SESSION_TTL_MS, SESSION_TTL_MS } from "../sessions";
import { signJwt } from "../jwt";
import type { Env } from "../index";

function makeDb() {
  const firstQueue: unknown[] = [];
  const runResults: Array<{ meta: { changes: number } }> = [];
  const stmt = {
    bind: (..._args: unknown[]) => stmt,
    first: async () => firstQueue.shift() ?? null,
    run: async () => runResults.shift() ?? { meta: { changes: 1 } },
  };
  return { firstQueue, runResults, prepare: vi.fn(() => stmt) };
}

function makeRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://auth/admin/handoff/exchange", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const ADMIN_USER = { id: "u-1", email: "a@x.com", moderation: 0, force_password_change: 0, is_admin: 1 };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(normalizeAdminCallbackUrl).mockReturnValue("https://admin.cubityfir.st/auth/callback");
  vi.mocked(createSession).mockResolvedValue("sid-1");
});

describe("handleAdminHandoffExchange", () => {
  it("mints a SHORT-TTL admin session (hours, not the standard 7 days) and audits it (AB-M7/AB-M2)", async () => {
    const db = makeDb();
    db.firstQueue.push({ id: "code-1", user_id: "u-1" }); // handoff row
    db.firstQueue.push(ADMIN_USER);
    const env = { DB: db, JWT_SECRET: "s" } as unknown as Env;

    const before = Date.now();
    const res = await handleAdminHandoffExchange(
      makeRequest({ code: "code-1", callbackUrl: "https://admin.cubityfir.st/auth/callback" }),
      env,
    );
    expect(res.status).toBe(200);

    // TTL sanity: admin sessions must be far shorter than the standard week.
    expect(ADMIN_SESSION_TTL_MS).toBeLessThan(SESSION_TTL_MS);
    expect(ADMIN_SESSION_TTL_MS).toBeLessThanOrEqual(24 * 60 * 60 * 1000);

    const expiresAt = vi.mocked(createSession).mock.calls[0][3];
    expect(expiresAt).toBeGreaterThanOrEqual(before + ADMIN_SESSION_TTL_MS - 1000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + ADMIN_SESSION_TTL_MS + 1000);

    const jwtPayload = vi.mocked(signJwt).mock.calls[0][0] as { expiresAt: number };
    expect(jwtPayload.expiresAt).toBe(expiresAt);

    expect(writeAdminHandoffAudit).toHaveBeenCalledWith(
      env,
      { userId: "u-1", email: "a@x.com" },
      "admin.handoff.exchange",
      expect.objectContaining({ sessionId: "sid-1", expiresAt }),
    );
  });

  it("refuses a non-admin user with 403 and no session/audit", async () => {
    const db = makeDb();
    db.firstQueue.push({ id: "code-1", user_id: "u-1" });
    db.firstQueue.push({ ...ADMIN_USER, is_admin: 0 });
    const env = { DB: db, JWT_SECRET: "s" } as unknown as Env;

    const res = await handleAdminHandoffExchange(
      makeRequest({ code: "code-1", callbackUrl: "https://admin.cubityfir.st/auth/callback" }),
      env,
    );
    expect(res.status).toBe(403);
    expect(createSession).not.toHaveBeenCalled();
    expect(writeAdminHandoffAudit).not.toHaveBeenCalled();
  });

  it("refuses an already-consumed code (atomic compare-and-set lost)", async () => {
    const db = makeDb();
    db.firstQueue.push({ id: "code-1", user_id: "u-1" });
    db.runResults.push({ meta: { changes: 0 } }); // consume raced and lost
    const env = { DB: db, JWT_SECRET: "s" } as unknown as Env;

    const res = await handleAdminHandoffExchange(
      makeRequest({ code: "code-1", callbackUrl: "https://admin.cubityfir.st/auth/callback" }),
      env,
    );
    expect(res.status).toBe(401);
    expect(createSession).not.toHaveBeenCalled();
    expect(writeAdminHandoffAudit).not.toHaveBeenCalled();
  });

  it("rejects an unapproved callbackUrl before touching the database", async () => {
    vi.mocked(normalizeAdminCallbackUrl).mockReturnValue(null);
    const db = makeDb();
    const env = { DB: db, JWT_SECRET: "s" } as unknown as Env;
    const res = await handleAdminHandoffExchange(
      makeRequest({ code: "code-1", callbackUrl: "https://evil.com/auth/callback" }),
      env,
    );
    expect(res.status).toBe(400);
    expect(db.prepare).not.toHaveBeenCalled();
  });
});
