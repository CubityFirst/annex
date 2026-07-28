import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleSessionsRevoke } from "./sessions-revoke";

vi.mock("../auth-session", () => ({
  requireAuthenticatedSession: vi.fn(),
}));
vi.mock("../sessions", () => ({
  revokeSession: vi.fn(),
}));

import { requireAuthenticatedSession } from "../auth-session";
import { revokeSession } from "../sessions";

const mockSession = { userId: "user-1", email: "test@example.com", expiresAt: Date.now() + 3600_000, sid: "sess-current" };

const limit = vi.fn().mockResolvedValue({ success: true });
const env = { DB: {}, RATE_LIMITER_AUTH: { limit } } as unknown as Parameters<typeof handleSessionsRevoke>[1];

function req(body: unknown) {
  return new Request("http://localhost/sessions/revoke", {
    method: "POST",
    headers: { Authorization: "Bearer t", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAuthenticatedSession).mockResolvedValue(mockSession);
  vi.mocked(revokeSession).mockResolvedValue(true);
});

describe("handleSessionsRevoke", () => {
  it("rejects a missing sessionId before touching auth", async () => {
    const res = await handleSessionsRevoke(req({}), env);
    expect(res.status).toBe(400);
    expect(requireAuthenticatedSession).not.toHaveBeenCalled();
  });

  it("returns 401 when the session is invalid", async () => {
    vi.mocked(requireAuthenticatedSession).mockResolvedValue(
      Response.json({ ok: false, error: "Unauthorized" }, { status: 401 }),
    );
    const res = await handleSessionsRevoke(req({ sessionId: "sess-x" }), env);
    expect(res.status).toBe(401);
    expect(revokeSession).not.toHaveBeenCalled();
  });

  it("revokes the targeted session scoped to the caller", async () => {
    const res = await handleSessionsRevoke(req({ sessionId: "sess-x" }), env);
    expect(res.status).toBe(200);
    expect(revokeSession).toHaveBeenCalledWith(env, "sess-x", "user-1");
  });

  it("returns 429 without revoking when the user limit is exceeded", async () => {
    limit.mockResolvedValueOnce({ success: false });
    const res = await handleSessionsRevoke(req({ sessionId: "sess-x" }), env);
    expect(res.status).toBe(429);
    expect(revokeSession).not.toHaveBeenCalled();
  });

  it("returns 404 when nothing was revoked (not the caller's session)", async () => {
    vi.mocked(revokeSession).mockResolvedValue(false);
    const res = await handleSessionsRevoke(req({ sessionId: "sess-foreign" }), env);
    expect(res.status).toBe(404);
  });
});
