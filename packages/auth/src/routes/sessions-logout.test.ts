import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleSessionsLogout } from "./sessions-logout";

vi.mock("../auth-session", () => ({
  requireAuthenticatedSession: vi.fn(),
}));
vi.mock("../sessions", () => ({
  revokeSession: vi.fn(),
}));

import { requireAuthenticatedSession } from "../auth-session";
import { revokeSession } from "../sessions";

const env = { DB: {}, RATE_LIMITER_AUTH: { limit: vi.fn().mockResolvedValue({ success: true }) } } as unknown as Parameters<typeof handleSessionsLogout>[1];

function req() {
  return new Request("http://localhost/sessions/logout", {
    method: "POST",
    headers: { Authorization: "Bearer t" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(revokeSession).mockResolvedValue(true);
});

describe("handleSessionsLogout", () => {
  it("returns 401 when the session is invalid", async () => {
    vi.mocked(requireAuthenticatedSession).mockResolvedValue(
      Response.json({ ok: false, error: "Unauthorized" }, { status: 401 }),
    );
    const res = await handleSessionsLogout(req(), env);
    expect(res.status).toBe(401);
    expect(revokeSession).not.toHaveBeenCalled();
  });

  it("revokes the caller's own current session", async () => {
    vi.mocked(requireAuthenticatedSession).mockResolvedValue({
      userId: "user-1", email: "test@example.com", expiresAt: Date.now() + 3600_000, sid: "sess-current",
    });
    const res = await handleSessionsLogout(req(), env);
    expect(res.status).toBe(200);
    expect(revokeSession).toHaveBeenCalledWith(env, "sess-current", "user-1");
  });

  it("is a no-op revoke when the session has no sid (still 200)", async () => {
    vi.mocked(requireAuthenticatedSession).mockResolvedValue({
      userId: "user-1", email: "test@example.com", expiresAt: Date.now() + 3600_000,
    });
    const res = await handleSessionsLogout(req(), env);
    expect(res.status).toBe(200);
    expect(revokeSession).not.toHaveBeenCalled();
  });
});
