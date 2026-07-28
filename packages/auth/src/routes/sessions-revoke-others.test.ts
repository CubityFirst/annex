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

const env = { DB: {}, RATE_LIMITER_AUTH: { limit: vi.fn().mockResolvedValue({ success: true }) } } as unknown as Parameters<typeof handleSessionsRevokeOthers>[1];

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
});
