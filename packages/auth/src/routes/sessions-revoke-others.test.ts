import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleSessionsRevokeOthers } from "./sessions-revoke-others";

vi.mock("../auth-session", () => ({
  requireAuthenticatedSession: vi.fn(),
}));
vi.mock("../sessions", () => ({
  revokeAllSessions: vi.fn(),
}));

import { requireAuthenticatedSession } from "../auth-session";
import { revokeAllSessions } from "../sessions";

const mockSession = { userId: "user-1", email: "test@example.com", expiresAt: Date.now() + 3600_000, sid: "sess-current" };

// Always-denying limiter: the panic button must never consult it (see the
// handler comment), so every passing test below doubles as proof it doesn't.
const limit = vi.fn().mockResolvedValue({ success: false });
const env = { DB: {}, RATE_LIMITER_AUTH: { limit } } as unknown as Parameters<typeof handleSessionsRevokeOthers>[1];

function req() {
  return new Request("http://localhost/sessions/revoke-others", {
    method: "POST",
    headers: { Authorization: "Bearer t" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAuthenticatedSession).mockResolvedValue(mockSession);
  vi.mocked(revokeAllSessions).mockResolvedValue(undefined);
});

describe("handleSessionsRevokeOthers", () => {
  it("returns 401 when the session is invalid", async () => {
    vi.mocked(requireAuthenticatedSession).mockResolvedValue(
      Response.json({ ok: false, error: "Unauthorized" }, { status: 401 }),
    );
    const res = await handleSessionsRevokeOthers(req(), env);
    expect(res.status).toBe(401);
    expect(revokeAllSessions).not.toHaveBeenCalled();
  });

  it("revokes every session except the caller's current one", async () => {
    const res = await handleSessionsRevokeOthers(req(), env);
    expect(res.status).toBe(200);
    expect(revokeAllSessions).toHaveBeenCalledWith(env, "user-1", "sess-current");
  });

  it("is never rate limited - a stolen session must not be able to block the panic button", async () => {
    const res = await handleSessionsRevokeOthers(req(), env);
    expect(res.status).toBe(200);
    expect(revokeAllSessions).toHaveBeenCalledWith(env, "user-1", "sess-current");
    expect(limit).not.toHaveBeenCalled();
  });
});
