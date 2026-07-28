import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleForceChangePassword } from "./force-change-password";

vi.mock("zxcvbn", () => ({ default: vi.fn(() => ({ score: 4 })) }));
vi.mock("../password", () => ({ hashPassword: vi.fn(async () => "new-hash") }));
vi.mock("../jwt", () => ({ verifyJwt: vi.fn(), signJwt: vi.fn(async () => "signed.jwt") }));
vi.mock("../sessions", () => ({
  createSession: vi.fn(async () => "sess-new"),
  revokeAllSessions: vi.fn(async () => undefined),
  SESSION_TTL_MS: 7 * 24 * 60 * 60 * 1000,
}));

import zxcvbn from "zxcvbn";
import { verifyJwt } from "../jwt";
import { revokeAllSessions } from "../sessions";
import { hashPassword } from "../password";

const userRow = { id: "user-1", email: "test@example.com", name: "Test", created_at: "2026-01-01", is_admin: 0, moderation: 0 };

function makeEnv(opts?: { user?: typeof userRow | null; changes?: number }) {
  const first = vi.fn().mockResolvedValue(opts?.user === undefined ? userRow : opts.user);
  const run = vi.fn().mockResolvedValue({ meta: { changes: opts?.changes ?? 1 } });
  const bindCalls: unknown[][] = [];
  const bind = vi.fn((...a: unknown[]) => {
    bindCalls.push(a);
    return { first, run };
  });
  const prepare = vi.fn().mockReturnValue({ bind });
  return { env: { DB: { prepare }, JWT_SECRET: "secret" } as unknown as Parameters<typeof handleForceChangePassword>[1], prepare, bind, run, bindCalls };
}

function req(body: unknown) {
  return new Request("http://localhost/force-change-password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(verifyJwt).mockResolvedValue({ userId: "user-1", forcePasswordChange: true, cti: "nonce-1" } as never);
  vi.mocked(zxcvbn).mockReturnValue({ score: 4 } as never);
});

describe("handleForceChangePassword", () => {
  it("rejects a body missing fields", async () => {
    const { env } = makeEnv();
    const res = await handleForceChangePassword(req({ changeToken: "t" }), env);
    expect(res.status).toBe(400);
  });

  it("rejects a token that isn't a force-change token", async () => {
    vi.mocked(verifyJwt).mockResolvedValue({ userId: "user-1" } as never);
    const { env } = makeEnv();
    const res = await handleForceChangePassword(req({ changeToken: "t", newPassword: "p" }), env);
    expect(res.status).toBe(401);
  });

  it("rejects a weak new password", async () => {
    vi.mocked(zxcvbn).mockReturnValue({ score: 1 } as never);
    const { env } = makeEnv();
    const res = await handleForceChangePassword(req({ changeToken: "t", newPassword: "weak" }), env);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("password_too_weak");
  });

  it("returns 404 when no matching flagged user exists", async () => {
    const { env } = makeEnv({ user: null });
    const res = await handleForceChangePassword(req({ changeToken: "t", newPassword: "Str0ng!Pass" }), env);
    expect(res.status).toBe(404);
  });

  it("rejects a disabled account before consuming the change token", async () => {
    const { env, run } = makeEnv({ user: { ...userRow, moderation: -1 } });
    const res = await handleForceChangePassword(req({ changeToken: "t", newPassword: "Str0ng!Pass" }), env);
    expect(res.status).toBe(403);
    expect((await res.json<{ error: string }>()).error).toBe("account_disabled");
    expect(run).not.toHaveBeenCalled();
  });

  it("returns 401 when the atomic consume changes 0 rows (token reused)", async () => {
    const { env } = makeEnv({ changes: 0 });
    const res = await handleForceChangePassword(req({ changeToken: "t", newPassword: "Str0ng!Pass" }), env);
    expect(res.status).toBe(401);
  });

  it("rotates the password, kills all sessions, and issues a fresh token", async () => {
    const { env, prepare, bindCalls } = makeEnv();
    const res = await handleForceChangePassword(req({ changeToken: "t", newPassword: "Str0ng!Pass" }), env);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { token: string; user: { id: string } } };
    expect(json.data.token).toBe("signed.jwt");
    expect(json.data.user.id).toBe("user-1");
    expect(revokeAllSessions).toHaveBeenCalledWith(env, "user-1");

    // The consume-UPDATE must write the new hash AND keep the single-use
    // change_token_id guard. (An UPDATE that omits either fails here.)
    expect(prepare).toHaveBeenCalledWith(expect.stringContaining("password_hash = ?"));
    expect(prepare).toHaveBeenCalledWith(expect.stringContaining("change_token_id = ?"));
    // The UPDATE is the only 3-arg bind: (newHash, user.id, cti).
    const updateBind = bindCalls.find((a) => a.length === 3);
    expect(updateBind).toEqual(["new-hash", "user-1", "nonce-1"]);
    // The hashed value written is derived from the submitted new password.
    expect(hashPassword).toHaveBeenCalledWith("Str0ng!Pass");
  });
});
