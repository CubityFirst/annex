import { describe, it, expect, vi, beforeEach } from "vitest";
import { fileURLToPath } from "node:url";
import { createSqliteD1 } from "../../../api/src/test/sqliteD1";
import { handleSessionsList } from "./sessions-list";

vi.mock("../auth-session", () => ({
  requireAuthenticatedSession: vi.fn(),
}));

import { requireAuthenticatedSession } from "../auth-session";

// Real SQLite with every auth migration applied: the listing is a SQL filter
// (revoked / expired / other users excluded) plus the `current` flag mapping.
const AUTH_MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

const mockSession = { userId: "user-1", email: "test@example.com", expiresAt: Date.now() + 3600_000, sid: "sess-current" };

function makeEnv() {
  const { db, sqlite } = createSqliteD1(AUTH_MIGRATIONS);
  const now = Date.now();
  const user = sqlite.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, 'U', 'x', datetime('now'))");
  user.run("user-1", "a@example.com");
  user.run("user-2", "b@example.com");
  const session = sqlite.prepare(
    "INSERT INTO sessions (id, user_id, created_at, expires_at, last_used_at, device_kind, client_label, ip, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  session.run("sess-current", "user-1", now - 5000, now + 60_000, now - 100, "desktop", "Firefox on Linux", "203.0.113.1", null);
  session.run("sess-other", "user-1", now - 9000, now + 60_000, now - 2000, null, null, null, null);
  session.run("sess-revoked", "user-1", now - 9000, now + 60_000, now - 50, null, null, null, now - 10);
  session.run("sess-expired", "user-1", now - 9000, now - 1, now - 40, null, null, null, null);
  session.run("sess-someone-else", "user-2", now - 9000, now + 60_000, now - 30, null, null, null, null);
  return { env: { DB: db } as unknown as Parameters<typeof handleSessionsList>[1], now };
}

function req() {
  return new Request("http://localhost/sessions/list", {
    headers: { Authorization: "Bearer t" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAuthenticatedSession).mockResolvedValue(mockSession);
});

describe("handleSessionsList", () => {
  it("returns 401 when the session is invalid", async () => {
    vi.mocked(requireAuthenticatedSession).mockResolvedValue(
      Response.json({ ok: false, error: "Unauthorized" }, { status: 401 }),
    );
    const { env } = makeEnv();
    const res = await handleSessionsList(req(), env);
    expect(res.status).toBe(401);
  });

  it("lists only the caller's live sessions, most recent first, flagging the current one", async () => {
    const { env, now } = makeEnv();
    const res = await handleSessionsList(req(), env);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; data: { sessions: unknown[] } };
    expect(json.ok).toBe(true);
    expect(json.data.sessions).toEqual([
      {
        id: "sess-current", createdAt: now - 5000, lastUsedAt: now - 100, expiresAt: now + 60_000,
        deviceKind: "desktop", clientLabel: "Firefox on Linux", ip: "203.0.113.1", current: true,
      },
      {
        id: "sess-other", createdAt: now - 9000, lastUsedAt: now - 2000, expiresAt: now + 60_000,
        deviceKind: null, clientLabel: null, ip: null, current: false,
      },
    ]);
  });
});
