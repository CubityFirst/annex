import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleChangeEmailCancel } from "./change-email-cancel";

vi.mock("../auth-session", () => ({
  requireAuthenticatedSession: vi.fn(),
}));

import { requireAuthenticatedSession } from "../auth-session";

const mockSession = { userId: "user-1", email: "old@example.com", expiresAt: Date.now() + 3600_000 };

function makeEnv() {
  const bindCalls: unknown[][] = [];
  const sqls: string[] = [];
  const prepare = vi.fn((sql: string) => {
    sqls.push(sql);
    return {
      bind: vi.fn((...args: unknown[]) => {
        bindCalls.push(args);
        return { run: vi.fn().mockResolvedValue({}) };
      }),
    };
  });
  const env = { DB: { prepare } } as unknown as Parameters<typeof handleChangeEmailCancel>[1];
  return { env, sqls, bindCalls };
}

function req() {
  return new Request("http://localhost/change-email/cancel", { method: "POST", body: "{}" });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAuthenticatedSession).mockResolvedValue(mockSession);
});

describe("handleChangeEmailCancel", () => {
  it("returns 401 when the session is invalid", async () => {
    vi.mocked(requireAuthenticatedSession).mockResolvedValue(
      Response.json({ ok: false, error: "Unauthorized" }, { status: 401 }),
    );
    const res = await handleChangeEmailCancel(req(), makeEnv().env);
    expect(res.status).toBe(401);
  });

  it("deletes only the caller's pending change tokens (idempotent)", async () => {
    const { env, sqls, bindCalls } = makeEnv();
    const res = await handleChangeEmailCancel(req(), env);
    expect(res.status).toBe(200);
    expect(sqls[0]).toContain("DELETE FROM email_verification_tokens");
    // Scoped to change tokens only - a pending signup verification survives.
    expect(sqls[0]).toContain("email IS NOT NULL");
    expect(bindCalls[0]).toEqual(["user-1"]);
  });
});
