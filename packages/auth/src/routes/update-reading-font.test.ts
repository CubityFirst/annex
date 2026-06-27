import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleUpdateReadingFont } from "./update-reading-font";

vi.mock("../auth-session", () => ({
  requireAuthenticatedSession: vi.fn(),
}));

import { requireAuthenticatedSession } from "../auth-session";

const mockSession = { userId: "user-1", email: "test@example.com", expiresAt: Date.now() + 3600_000 };

function makeEnv() {
  const run = vi.fn().mockResolvedValue({});
  const bind = vi.fn().mockReturnValue({ run });
  const prepare = vi.fn().mockReturnValue({ bind });
  return {
    env: { DB: { prepare } } as unknown as Parameters<typeof handleUpdateReadingFont>[1],
    prepare,
    bind,
    run,
  };
}

function req(body: unknown) {
  return new Request("http://localhost/update-reading-font", {
    method: "POST",
    headers: { Authorization: "Bearer t", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAuthenticatedSession).mockResolvedValue(mockSession);
});

describe("handleUpdateReadingFont", () => {
  it("returns 401 when session is invalid", async () => {
    vi.mocked(requireAuthenticatedSession).mockResolvedValue(
      Response.json({ ok: false, error: "Unauthorized" }, { status: 401 }),
    );
    const { env } = makeEnv();
    const res = await handleUpdateReadingFont(req({ readingFont: "mono" }), env);
    expect(res.status).toBe(401);
  });

  it("rejects empty body", async () => {
    const { env, prepare } = makeEnv();
    const res = await handleUpdateReadingFont(req({}), env);
    expect(res.status).toBe(400);
    expect(prepare).not.toHaveBeenCalled();
  });

  it("rejects bogus readingFont value", async () => {
    const { env, prepare } = makeEnv();
    const res = await handleUpdateReadingFont(req({ readingFont: "comic-sans" }), env);
    expect(res.status).toBe(400);
    expect(prepare).not.toHaveBeenCalled();
  });

  it("rejects bogus editingFont value", async () => {
    const { env, prepare } = makeEnv();
    const res = await handleUpdateReadingFont(req({ editingFont: "papyrus" }), env);
    expect(res.status).toBe(400);
    expect(prepare).not.toHaveBeenCalled();
  });

  it("writes valid readingFont and returns echo", async () => {
    const { env, prepare, run, bind } = makeEnv();
    const res = await handleUpdateReadingFont(req({ readingFont: "dyslexic" }), env);
    expect(res.status).toBe(200);
    const json = await res.json() as { ok: boolean; data: { readingFont: string | null } };
    expect(json.ok).toBe(true);
    expect(json.data.readingFont).toBe("dyslexic");
    expect(prepare).toHaveBeenCalledWith(expect.stringContaining("reading_font"));
    // user_id leads (UPSERT key), then the column values
    expect(bind).toHaveBeenCalledWith("user-1", "dyslexic");
    expect(run).toHaveBeenCalledOnce();
  });

  it("writes both fields when both are present", async () => {
    const { env, prepare, bind } = makeEnv();
    const res = await handleUpdateReadingFont(req({ readingFont: "sans", editingFont: "mono" }), env);
    expect(res.status).toBe(200);
    const sql = prepare.mock.calls[0]?.[0] as string;
    expect(sql).toContain("reading_font");
    expect(sql).toContain("editing_font");
    expect(bind).toHaveBeenCalledWith("user-1", "sans", "mono");
  });

  it("writes uiFont when present", async () => {
    const { env, prepare, bind } = makeEnv();
    const res = await handleUpdateReadingFont(req({ uiFont: "dyslexic" }), env);
    expect(res.status).toBe(200);
    expect(prepare.mock.calls[0]?.[0]).toContain("ui_font");
    expect(bind).toHaveBeenCalledWith("user-1", "dyslexic");
  });

  it("rejects bogus uiFont value", async () => {
    const { env, prepare } = makeEnv();
    const res = await handleUpdateReadingFont(req({ uiFont: "wingdings" }), env);
    expect(res.status).toBe(400);
    expect(prepare).not.toHaveBeenCalled();
  });

  it("writes all three fields together", async () => {
    const { env, bind } = makeEnv();
    const res = await handleUpdateReadingFont(req({ readingFont: "sans", editingFont: "mono", uiFont: "dyslexic" }), env);
    expect(res.status).toBe(200);
    expect(bind).toHaveBeenCalledWith("user-1", "sans", "mono", "dyslexic");
  });

  it("treats null as a reset (NULL on the row)", async () => {
    const { env, bind } = makeEnv();
    const res = await handleUpdateReadingFont(req({ readingFont: null }), env);
    expect(res.status).toBe(200);
    expect(bind).toHaveBeenCalledWith("user-1", null);
  });

  it("does not consult plan / Ink gate - any user can change fonts", async () => {
    // The handler never reads personal_plan / granted_plan - so a free user
    // (no extra setup needed) should succeed. If we ever add a gate, this
    // test should fail and prompt a review.
    const { env } = makeEnv();
    const res = await handleUpdateReadingFont(req({ readingFont: "dyslexic" }), env);
    expect(res.status).toBe(200);
  });
});
