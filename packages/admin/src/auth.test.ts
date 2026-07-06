import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../auth/src/session", () => ({
  loadCurrentSession: vi.fn(),
  sessionResultToResponse: vi.fn((result: { kind: string }) =>
    Response.json({ ok: false, error: `account_${result.kind}` }, { status: 403 }),
  ),
}));

import { verifySession, requireAdminSession } from "./auth";
import { loadCurrentSession } from "../../auth/src/session";
import type { Env } from "./index";

const env = { AUTH_DB: {}, JWT_SECRET: "secret" } as unknown as Env;

function req(token?: string) {
  return new Request("http://admin/api/verify", {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

const OK_SESSION = {
  kind: "ok" as const,
  session: { userId: "u-1", email: "a@x.com", expiresAt: 123, isAdmin: true, sid: "s-1" },
};

beforeEach(() => vi.clearAllMocks());

describe("verifySession result mapping", () => {
  it("returns null with no Authorization header (never hits the DB)", async () => {
    expect(await verifySession(req(), env)).toBeNull();
    expect(loadCurrentSession).not.toHaveBeenCalled();
  });

  it("maps kind:ok to an AdminSession", async () => {
    vi.mocked(loadCurrentSession).mockResolvedValue(OK_SESSION);
    const session = await verifySession(req("tok"), env);
    expect(session).toEqual({ userId: "u-1", email: "a@x.com", expiresAt: 123, isAdmin: true });
  });

  it("maps kind:invalid to null", async () => {
    vi.mocked(loadCurrentSession).mockResolvedValue({ kind: "invalid" });
    expect(await verifySession(req("tok"), env)).toBeNull();
  });

  it("passes disabled/suspended through as a Response", async () => {
    vi.mocked(loadCurrentSession).mockResolvedValue({ kind: "disabled" });
    const result = await verifySession(req("tok"), env);
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(403);
  });

  it("threads the execution context through to loadCurrentSession (AB-M7)", async () => {
    vi.mocked(loadCurrentSession).mockResolvedValue(OK_SESSION);
    const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
    await verifySession(req("tok"), env, ctx);
    expect(vi.mocked(loadCurrentSession).mock.calls[0][3]).toBe(ctx);
  });
});

describe("requireAdminSession", () => {
  it("401s a missing token", async () => {
    const result = await requireAdminSession(req(), env);
    expect((result as Response).status).toBe(401);
  });

  it("403s a valid non-admin session (isAdmin re-derived from the DB, not the JWT)", async () => {
    vi.mocked(loadCurrentSession).mockResolvedValue({
      kind: "ok",
      session: { ...OK_SESSION.session, isAdmin: false },
    });
    const result = await requireAdminSession(req("tok"), env);
    expect((result as Response).status).toBe(403);
  });

  it("returns the session for a valid admin", async () => {
    vi.mocked(loadCurrentSession).mockResolvedValue(OK_SESSION);
    const result = await requireAdminSession(req("tok"), env);
    expect(result).toMatchObject({ userId: "u-1", isAdmin: true });
  });
});
