import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleUpdateInkPrefs } from "./update-ink-prefs";
import type { PlanRow } from "../../account/plan";

vi.mock("../../account/requestSession", () => ({
  requireAuthenticatedSession: vi.fn(),
}));

import { requireAuthenticatedSession } from "../../account/requestSession";

const mockSession = { userId: "user-1", email: "test@example.com", expiresAt: Date.now() + 3600_000 };

const inkRow: PlanRow = {
  granted_plan: "ink",
  granted_plan_expires_at: null,
  granted_plan_started_at: 1,
  personal_plan: null,
  personal_plan_status: null,
  personal_plan_started_at: null,
  personal_plan_cancel_at: null,
  personal_plan_style: null,
  personal_presence_color: null,
  personal_crit_sparkles: null,
};

const freeRow: PlanRow = { ...inkRow, granted_plan: null, granted_plan_started_at: null };

function makeEnv(planRow: PlanRow | null) {
  const first = vi.fn().mockResolvedValue(planRow);
  const run = vi.fn().mockResolvedValue({});
  const bind = vi.fn().mockReturnValue({ first, run });
  const prepare = vi.fn().mockReturnValue({ bind });
  return {
    env: { DB: { prepare } } as unknown as Parameters<typeof handleUpdateInkPrefs>[1],
    prepare,
    bind,
    first,
    run,
  };
}

function req(body: unknown) {
  return new Request("http://localhost/update-ink-prefs", {
    method: "POST",
    headers: { Authorization: "Bearer t", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAuthenticatedSession).mockResolvedValue(mockSession);
});

describe("handleUpdateInkPrefs", () => {
  it("returns 401 when the session is invalid", async () => {
    vi.mocked(requireAuthenticatedSession).mockResolvedValue(
      Response.json({ ok: false, error: "Unauthorized" }, { status: 401 }),
    );
    const { env } = makeEnv(inkRow);
    const res = await handleUpdateInkPrefs(req({ style: "aurora" }), env);
    expect(res.status).toBe(401);
  });

  it("rejects an empty body", async () => {
    const { env, prepare } = makeEnv(inkRow);
    const res = await handleUpdateInkPrefs(req({}), env);
    expect(res.status).toBe(400);
    expect(prepare).not.toHaveBeenCalled();
  });

  it("rejects a bogus ring style", async () => {
    const { env } = makeEnv(inkRow);
    const res = await handleUpdateInkPrefs(req({ style: "rainbow" }), env);
    expect(res.status).toBe(400);
  });

  it("rejects a non-hex presence colour", async () => {
    const { env } = makeEnv(inkRow);
    const res = await handleUpdateInkPrefs(req({ presenceColor: "red" }), env);
    expect(res.status).toBe(400);
  });

  it("rejects a non-boolean critSparkles", async () => {
    const { env } = makeEnv(inkRow);
    const res = await handleUpdateInkPrefs(req({ critSparkles: "yes" }), env);
    expect(res.status).toBe(400);
  });

  it("returns 403 for a free (non-Ink) user", async () => {
    const { env, run } = makeEnv(freeRow);
    const res = await handleUpdateInkPrefs(req({ style: "aurora" }), env);
    expect(res.status).toBe(403);
    expect(run).not.toHaveBeenCalled();
  });

  it("writes a valid style for an Ink user", async () => {
    const { env, run, bind } = makeEnv(inkRow);
    const res = await handleUpdateInkPrefs(req({ style: "aurora" }), env);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { style: string | null } };
    expect(json.data.style).toBe("aurora");
    expect(run).toHaveBeenCalledOnce();
    expect(bind).toHaveBeenLastCalledWith("user-1", "aurora");
  });

  it("persists critSparkles as 0/1", async () => {
    const { env, bind } = makeEnv(inkRow);
    await handleUpdateInkPrefs(req({ critSparkles: false }), env);
    expect(bind).toHaveBeenLastCalledWith("user-1", 0);
  });

  it("writes all three prefs together", async () => {
    const { env, bind } = makeEnv(inkRow);
    const res = await handleUpdateInkPrefs(
      req({ style: "ember", presenceColor: "#aabbcc", critSparkles: true }),
      env,
    );
    expect(res.status).toBe(200);
    expect(bind).toHaveBeenLastCalledWith("user-1", "ember", "#aabbcc", 1);
  });
});
