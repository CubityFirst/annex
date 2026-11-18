import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleUpdateBio } from "./update-bio";
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

// The handler calls .first() for the plan-gate query and .run() for the upsert,
// both off the same prepare().bind() chain, so the chain exposes both.
function makeEnv(planRow: PlanRow | null) {
  const first = vi.fn().mockResolvedValue(planRow);
  const run = vi.fn().mockResolvedValue({});
  const bind = vi.fn().mockReturnValue({ first, run });
  const prepare = vi.fn().mockReturnValue({ bind });
  return {
    env: { DB: { prepare } } as unknown as Parameters<typeof handleUpdateBio>[1],
    prepare,
    bind,
    first,
    run,
  };
}

function req(body: unknown) {
  return new Request("http://localhost/update-bio", {
    method: "POST",
    headers: { Authorization: "Bearer t", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAuthenticatedSession).mockResolvedValue(mockSession);
});

describe("handleUpdateBio", () => {
  it("returns 401 when the session is invalid", async () => {
    vi.mocked(requireAuthenticatedSession).mockResolvedValue(
      Response.json({ ok: false, error: "Unauthorized" }, { status: 401 }),
    );
    const { env } = makeEnv(inkRow);
    const res = await handleUpdateBio(req({ bio: "hello" }), env);
    expect(res.status).toBe(401);
  });

  it("rejects a body without a bio field", async () => {
    const { env, prepare } = makeEnv(inkRow);
    const res = await handleUpdateBio(req({}), env);
    expect(res.status).toBe(400);
    expect(prepare).not.toHaveBeenCalled();
  });

  it("rejects a bio over the length cap", async () => {
    const { env } = makeEnv(inkRow);
    const res = await handleUpdateBio(req({ bio: "x".repeat(281) }), env);
    expect(res.status).toBe(400);
  });

  it("returns 403 for a free (non-Ink) user", async () => {
    const { env, run } = makeEnv(freeRow);
    const res = await handleUpdateBio(req({ bio: "supporter" }), env);
    expect(res.status).toBe(403);
    expect(run).not.toHaveBeenCalled();
  });

  it("returns 404 when the user row is missing", async () => {
    const { env } = makeEnv(null);
    const res = await handleUpdateBio(req({ bio: "supporter" }), env);
    expect(res.status).toBe(404);
  });

  it("writes a trimmed bio for an Ink user", async () => {
    const { env, run, bind } = makeEnv(inkRow);
    const res = await handleUpdateBio(req({ bio: "  My bio  " }), env);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; data: { bio: string | null } };
    expect(json.data.bio).toBe("My bio");
    expect(run).toHaveBeenCalledOnce();
    expect(bind).toHaveBeenLastCalledWith("user-1", "My bio");
  });

  it("treats an empty/whitespace bio as a clear (null)", async () => {
    const { env, bind } = makeEnv(inkRow);
    const res = await handleUpdateBio(req({ bio: "   " }), env);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { bio: string | null } };
    expect(json.data.bio).toBeNull();
    expect(bind).toHaveBeenLastCalledWith("user-1", null);
  });

  it("treats explicit null as a clear", async () => {
    const { env, bind } = makeEnv(inkRow);
    const res = await handleUpdateBio(req({ bio: null }), env);
    expect(res.status).toBe(200);
    expect(bind).toHaveBeenLastCalledWith("user-1", null);
  });
});
