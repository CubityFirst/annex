import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleTotpDisable } from "./totp-disable";

vi.mock("../auth-session", () => ({
  requireAuthenticatedSession: vi.fn(),
}));
vi.mock("../mfa", () => ({
  requireMFA: vi.fn(),
}));

import { requireAuthenticatedSession } from "../auth-session";
import { requireMFA } from "../mfa";

const mockSession = { userId: "user-1", email: "test@example.com", expiresAt: Date.now() + 3600_000 };

function makeEnv(row: { totp_secret: string | null } | null) {
  const first = vi.fn().mockResolvedValue(row);
  const bind = vi.fn().mockReturnValue({ first });
  const updateBind = vi.fn().mockReturnValue({});
  const deleteBind = vi.fn().mockReturnValue({});
  const prepare = vi.fn()
    .mockReturnValueOnce({ bind })
    .mockReturnValueOnce({ bind: updateBind })
    .mockReturnValueOnce({ bind: deleteBind });
  const batch = vi.fn().mockResolvedValue([]);
  const env = { DB: { prepare, batch } } as unknown as Parameters<typeof handleTotpDisable>[1];
  return { env, prepare, updateBind, deleteBind, batch };
}

function req(body: unknown) {
  return new Request("http://localhost/totp/disable", {
    method: "POST",
    headers: { Authorization: "Bearer t", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAuthenticatedSession).mockResolvedValue(mockSession);
  vi.mocked(requireMFA).mockResolvedValue(null as never);
});

describe("handleTotpDisable", () => {
  it("returns 401 when the session is invalid", async () => {
    vi.mocked(requireAuthenticatedSession).mockResolvedValue(
      Response.json({ ok: false, error: "Unauthorized" }, { status: 401 }),
    );
    const { env } = makeEnv({ totp_secret: "S" });
    const res = await handleTotpDisable(req({ totpCode: "123456" }), env);
    expect(res.status).toBe(401);
  });

  it("returns 404 when the user is gone", async () => {
    const { env } = makeEnv(null);
    const res = await handleTotpDisable(req({ totpCode: "123456" }), env);
    expect(res.status).toBe(404);
  });

  it("rejects when TOTP isn't enabled", async () => {
    const { env, batch } = makeEnv({ totp_secret: null });
    const res = await handleTotpDisable(req({ totpCode: "123456" }), env);
    expect(res.status).toBe(400);
    expect(batch).not.toHaveBeenCalled();
  });

  it("propagates an MFA failure without clearing the secret", async () => {
    vi.mocked(requireMFA).mockResolvedValue(
      Response.json({ ok: false, error: "mfa_required" }, { status: 401 }) as never,
    );
    const { env, batch } = makeEnv({ totp_secret: "S" });
    const res = await handleTotpDisable(req({}), env);
    expect(res.status).toBe(401);
    expect(batch).not.toHaveBeenCalled();
  });

  it("atomically clears the TOTP state and its recovery codes on valid MFA", async () => {
    const { env, batch, updateBind, deleteBind, prepare } = makeEnv({ totp_secret: "S" });
    const res = await handleTotpDisable(req({ totpCode: "123456" }), env);
    expect(res.status).toBe(200);
    expect(batch).toHaveBeenCalledOnce();
    expect(batch.mock.calls[0][0]).toHaveLength(2);
    expect(updateBind).toHaveBeenCalledWith("user-1");
    expect(deleteBind).toHaveBeenCalledWith("user-1");
    expect(prepare).toHaveBeenCalledWith(expect.stringContaining("totp_secret = NULL"));
    expect(prepare).toHaveBeenCalledWith(expect.stringContaining("totp_last_used_step = NULL"));
    expect(prepare).toHaveBeenCalledWith(expect.stringContaining("DELETE FROM backup_codes"));
  });
});
