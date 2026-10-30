import { describe, it, expect, vi, beforeEach } from "vitest";
import { fileURLToPath } from "node:url";
import { createSqliteD1 } from "../../../api/src/test/sqliteD1";
import { handleChangeEmailCancel } from "./change-email-cancel";

vi.mock("../auth-session", () => ({
  requireAuthenticatedSession: vi.fn(),
}));

import { requireAuthenticatedSession } from "../auth-session";

// Real SQLite with every auth migration applied: which tokens the DELETE
// matches is the whole behaviour.
const AUTH_MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

const mockSession = { userId: "user-1", email: "old@example.com", expiresAt: Date.now() + 3600_000 };

function makeEnv() {
  const { db, sqlite } = createSqliteD1(AUTH_MIGRATIONS);
  const user = sqlite.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, 'U', 'x', datetime('now'))");
  user.run("user-1", "old@example.com");
  user.run("user-2", "b@example.com");
  const token = sqlite.prepare("INSERT INTO email_verification_tokens (id, user_id, created_at, expires_at, email) VALUES (?, ?, 0, 9999999999999, ?)");
  token.run("change-1", "user-1", "new@example.com");
  token.run("change-2", "user-1", "newer@example.com");
  token.run("signup", "user-1", null); // pending signup verification
  token.run("other-change", "user-2", "x@example.com");
  const remaining = () =>
    sqlite.prepare("SELECT id FROM email_verification_tokens ORDER BY id").all().map(r => r.id);
  return { env: { DB: db } as unknown as Parameters<typeof handleChangeEmailCancel>[1], remaining };
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
    const { env, remaining } = makeEnv();
    const res = await handleChangeEmailCancel(req(), env);
    expect(res.status).toBe(401);
    expect(remaining()).toEqual(["change-1", "change-2", "other-change", "signup"]);
  });

  it("deletes only the caller's pending change tokens (idempotent)", async () => {
    const { env, remaining } = makeEnv();
    expect((await handleChangeEmailCancel(req(), env)).status).toBe(200);
    // Scoped to change tokens only - a pending signup verification survives.
    expect(remaining()).toEqual(["other-change", "signup"]);
    expect((await handleChangeEmailCancel(req(), env)).status).toBe(200);
    expect(remaining()).toEqual(["other-change", "signup"]);
  });
});
