import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleUpdateTheme } from "./update-theme";

vi.mock("../auth-session", () => ({
  requireAuthenticatedSession: vi.fn(),
}));

import { requireAuthenticatedSession } from "../auth-session";

const adminSession = { userId: "user-1", email: "a@example.com", expiresAt: Date.now() + 3600_000, isAdmin: true };

function makeEnv() {
  const run = vi.fn().mockResolvedValue({});
  const bind = vi.fn().mockReturnValue({ run });
  const prepare = vi.fn().mockReturnValue({ bind });
  return {
    env: { DB: { prepare } } as unknown as Parameters<typeof handleUpdateTheme>[1],
    prepare,
    bind,
    run,
  };
}

function req(body: unknown) {
  return new Request("http://localhost/update-theme", {
    method: "POST",
    headers: { Authorization: "Bearer t", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAuthenticatedSession).mockResolvedValue(adminSession);
});

describe("handleUpdateTheme", () => {
  it("returns 401 when the session is invalid", async () => {
    vi.mocked(requireAuthenticatedSession).mockResolvedValue(
      Response.json({ ok: false, error: "Unauthorized" }, { status: 401 }),
    );
    const { env } = makeEnv();
    expect((await handleUpdateTheme(req({ theme: "dark" }), env)).status).toBe(401);
  });

  // The admin / custom-theming gate intentionally lives in the API worker's
  // PATCH /me/theme, NOT in this handler - so a non-admin session still writes
  // here. This guards against the handler accidentally growing its own gate.
  it("does not self-gate on admin (gate lives in the API worker's PATCH /me/theme)", async () => {
    vi.mocked(requireAuthenticatedSession).mockResolvedValue({ ...adminSession, isAdmin: false });
    const { env, prepare } = makeEnv();
    const res = await handleUpdateTheme(req({ theme: "light" }), env);
    expect(res.status).toBe(200);
    expect(prepare).toHaveBeenCalled();
  });

  it("rejects a missing / unknown theme", async () => {
    const { env, prepare } = makeEnv();
    expect((await handleUpdateTheme(req({}), env)).status).toBe(400);
    expect((await handleUpdateTheme(req({ theme: "solarized" }), env)).status).toBe(400);
    expect(prepare).not.toHaveBeenCalled();
  });

  it("rejects custom without a valid #rrggbb colour", async () => {
    const { env, prepare } = makeEnv();
    expect((await handleUpdateTheme(req({ theme: "custom" }), env)).status).toBe(400);
    expect((await handleUpdateTheme(req({ theme: "custom", customColor: "teal" }), env)).status).toBe(400);
    expect((await handleUpdateTheme(req({ theme: "custom", customColor: "#abc" }), env)).status).toBe(400);
    expect(prepare).not.toHaveBeenCalled();
  });

  it("writes dark and nulls the custom colour", async () => {
    const { env, prepare, bind, run } = makeEnv();
    const res = await handleUpdateTheme(req({ theme: "dark" }), env);
    expect(res.status).toBe(200);
    const json = await res.json() as { ok: boolean; data: { theme: string; customColor: string | null } };
    expect(json.ok).toBe(true);
    expect(json.data).toEqual({ theme: "dark", customColor: null });
    expect(prepare).toHaveBeenCalledWith(expect.stringContaining("theme_mode"));
    expect(bind).toHaveBeenCalledWith("user-1", "dark", null);
    expect(run).toHaveBeenCalledOnce();
  });

  it("writes light and ignores any supplied colour", async () => {
    const { env, bind } = makeEnv();
    const res = await handleUpdateTheme(req({ theme: "light", customColor: "#2e7d6b" }), env);
    expect(res.status).toBe(200);
    expect(bind).toHaveBeenCalledWith("user-1", "light", null);
  });

  it("writes custom with a normalised (lower-cased) colour", async () => {
    const { env, bind } = makeEnv();
    const res = await handleUpdateTheme(req({ theme: "custom", customColor: "#2E7D6B" }), env);
    expect(res.status).toBe(200);
    const json = await res.json() as { data: { theme: string; customColor: string | null } };
    expect(json.data).toEqual({ theme: "custom", customColor: "#2e7d6b" });
    expect(bind).toHaveBeenCalledWith("user-1", "custom", "#2e7d6b");
  });
});
