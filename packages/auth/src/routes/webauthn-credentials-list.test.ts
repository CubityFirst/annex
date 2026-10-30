import { describe, it, expect, vi, beforeEach } from "vitest";
import { fileURLToPath } from "node:url";
import { createSqliteD1 } from "../../../api/src/test/sqliteD1";
import { handleWebauthnCredentialsList } from "./webauthn-credentials-list";

vi.mock("../auth-session", () => ({
  requireAuthenticatedSession: vi.fn(),
}));

import { requireAuthenticatedSession } from "../auth-session";

// Real SQLite with every auth migration applied, so the user scoping and
// ordering are actually evaluated.
const AUTH_MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

const mockSession = { userId: "user-1", email: "test@example.com", expiresAt: Date.now() + 3600_000 };

function makeEnv() {
  const { db, sqlite } = createSqliteD1(AUTH_MIGRATIONS);
  const user = sqlite.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, 'U', 'x', datetime('now'))");
  user.run("user-1", "a@example.com");
  user.run("user-2", "b@example.com");
  const cred = sqlite.prepare("INSERT INTO webauthn_credentials (id, user_id, name, public_key, created_at) VALUES (?, ?, ?, 'pk', ?)");
  cred.run("c2", "user-1", "Phone", "2026-02-01");
  cred.run("c1", "user-1", "Yubikey", "2026-01-01");
  cred.run("c3", "user-2", "Not mine", "2026-01-15");
  return { env: { DB: db } as unknown as Parameters<typeof handleWebauthnCredentialsList>[1] };
}

function req() {
  return new Request("http://localhost/webauthn/credentials", { headers: { Authorization: "Bearer t" } });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAuthenticatedSession).mockResolvedValue(mockSession);
});

describe("handleWebauthnCredentialsList", () => {
  it("returns 401 when the session is invalid", async () => {
    vi.mocked(requireAuthenticatedSession).mockResolvedValue(
      Response.json({ ok: false, error: "Unauthorized" }, { status: 401 }),
    );
    const { env } = makeEnv();
    const res = await handleWebauthnCredentialsList(req(), env);
    expect(res.status).toBe(401);
  });

  it("lists only the caller's credentials, oldest first, without key material", async () => {
    const { env } = makeEnv();
    const res = await handleWebauthnCredentialsList(req(), env);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { credentials: unknown[] } };
    expect(json.data.credentials).toEqual([
      { id: "c1", name: "Yubikey", created_at: "2026-01-01" },
      { id: "c2", name: "Phone", created_at: "2026-02-01" },
    ]);
  });
});
