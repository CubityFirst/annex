// Real-SQLite scenarios (every auth migration applied) for the cleanup and
// batching paths whose correctness lives in the SQL: the weekly sweep, the
// per-user session GC in createSession, the handoff/OAuth-code GC, and the
// batched lookup-by-id reads.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fileURLToPath } from "node:url";
import { createSqliteD1 } from "../../api/src/test/sqliteD1";

vi.mock("./auth-session", () => ({ requireAuthenticatedSession: vi.fn() }));
vi.mock("./admin-handoff", () => ({
  normalizeAdminCallbackUrl: vi.fn(() => "https://admin.example/auth/callback"),
  writeAdminHandoffAudit: vi.fn(async () => {}),
}));

import { sweepExpiredRows, SWEEP_RETENTION_MS } from "./cleanup";
import { createSession, SESSION_TTL_MS } from "./sessions";
import { handleLookupById } from "./routes/lookup-by-id";
import { handleAdminHandoffStart } from "./routes/admin-handoff-start";
import { handleOAuthAuthorize } from "./routes/oauth-authorize";
import { requireAuthenticatedSession } from "./auth-session";
import type { Env } from "./index";

const AUTH_MIGRATIONS = fileURLToPath(new URL("../migrations", import.meta.url));
const DAY = 24 * 60 * 60 * 1000;

function setup() {
  const { db, sqlite } = createSqliteD1(AUTH_MIGRATIONS);
  const env = {
    DB: db,
    RATE_LIMITER_OIDC: { limit: async () => ({ success: true }) },
  } as unknown as Env;
  const addUser = (id: string) =>
    sqlite.prepare(
      "INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, 'U', 'x', datetime('now'))",
    ).run(id, `${id}@example.com`);
  const ids = (sql: string) =>
    (sqlite.prepare(sql).all() as Array<{ id: string }>).map(r => r.id).sort();
  return { env, sqlite, addUser, ids };
}

function addSession(
  sqlite: ReturnType<typeof setup>["sqlite"],
  id: string,
  userId: string,
  createdAt: number,
  revokedAt: number | null = null,
  ttl = SESSION_TTL_MS,
) {
  sqlite.prepare(
    "INSERT INTO sessions (id, user_id, created_at, expires_at, last_used_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(id, userId, createdAt, createdAt + ttl, createdAt, revokedAt);
}

function addToken(
  sqlite: ReturnType<typeof setup>["sqlite"],
  id: string,
  userId: string,
  expiresAt: number,
  email: string | null = null,
  consumedAt: number | null = null,
) {
  sqlite.prepare(
    "INSERT INTO email_verification_tokens (id, user_id, created_at, expires_at, consumed_at, email) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(id, userId, expiresAt - DAY, expiresAt, consumedAt, email);
}

const session = { userId: "u1", email: "u1@example.com", isAdmin: true, expiresAt: Date.now() + DAY };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAuthenticatedSession).mockResolvedValue(session as never);
});

describe("sweepExpiredRows", () => {
  it("deletes only rows past the retention window across every swept table", async () => {
    const { env, sqlite, addUser, ids } = setup();
    addUser("u1");
    const now = Date.now();
    const cutoff = now - SWEEP_RETENTION_MS;

    // Sessions: expired before the cutoff, or revoked before it (even when
    // it only expired after the cutoff).
    addSession(sqlite, "s-expired-old", "u1", cutoff - SESSION_TTL_MS - DAY);
    addSession(sqlite, "s-revoked-old", "u1", cutoff - 10 * DAY, cutoff - 9 * DAY);
    addSession(sqlite, "s-revoked-old-unexpired-at-cutoff", "u1", cutoff - 2 * DAY, cutoff - DAY);
    addSession(sqlite, "s-expired-after-cutoff", "u1", cutoff - 2 * DAY);
    addSession(sqlite, "s-expired-recent", "u1", now - SESSION_TTL_MS - DAY);
    addSession(sqlite, "s-revoked-recent", "u1", now - DAY, now - DAY / 2);
    addSession(sqlite, "s-active", "u1", now - DAY);
    addSession(sqlite, "s-admin-old", "u1", cutoff - DAY, null, 12 * 60 * 60 * 1000);

    sqlite.prepare("INSERT INTO webhook_events (event_id, type, processed_at) VALUES (?, 't', ?)").run("evt-old", cutoff - 1);
    sqlite.prepare("INSERT INTO webhook_events (event_id, type, processed_at) VALUES (?, 't', ?)").run("evt-recent", now - 3 * DAY);

    addToken(sqlite, "t-expired-old", "u1", cutoff - 1, "new@example.com");
    addToken(sqlite, "t-consumed-old", "u1", cutoff - DAY, null, cutoff - 2 * DAY);
    addToken(sqlite, "t-expired-recent", "u1", now - DAY, "new@example.com");
    addToken(sqlite, "t-active", "u1", now + DAY);

    sqlite.prepare("INSERT INTO webauthn_challenges (id, user_id, challenge, type, created_at) VALUES (?, 'u1', 'c', 'authentication', ?)").run("c-old", now - 10 * 60 * 1000);
    sqlite.prepare("INSERT INTO webauthn_challenges (id, user_id, challenge, type, created_at) VALUES (?, 'u1', 'c', 'authentication', ?)").run("c-new", now - 1000);

    await sweepExpiredRows(env, now);

    expect(ids("SELECT id FROM sessions")).toEqual(["s-active", "s-expired-after-cutoff", "s-expired-recent", "s-revoked-recent"]);
    expect(ids("SELECT event_id AS id FROM webhook_events")).toEqual(["evt-recent"]);
    // Recently-expired change tokens survive so verify-email can still
    // answer "change_link_expired" for a stale link.
    expect(ids("SELECT id FROM email_verification_tokens")).toEqual(["t-active", "t-expired-recent"]);
    expect(ids("SELECT id FROM webauthn_challenges")).toEqual(["c-new"]);
  });
});

describe("createSession", () => {
  it("GCs the user's dead sessions and inserts the new one in one batch", async () => {
    const { env, sqlite, addUser, ids } = setup();
    addUser("u1");
    addUser("u2");
    const now = Date.now();
    addSession(sqlite, "u1-expired", "u1", now - SESSION_TTL_MS - DAY);
    addSession(sqlite, "u1-revoked", "u1", now - DAY, now - 1000);
    addSession(sqlite, "u1-active", "u1", now - DAY);
    addSession(sqlite, "u2-expired", "u2", now - SESSION_TTL_MS - DAY);

    const request = new Request("http://auth/login", {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0) Chrome/120.0", "CF-Connecting-IP": "203.0.113.1" },
    });
    const sid = await createSession(env, "u1", request, now + SESSION_TTL_MS);

    expect(ids("SELECT id FROM sessions WHERE user_id = 'u1'")).toEqual(["u1-active", sid].sort());
    expect(ids("SELECT id FROM sessions WHERE user_id = 'u2'")).toEqual(["u2-expired"]);
    const row = sqlite.prepare("SELECT expires_at, client_label, revoked_at FROM sessions WHERE id = ?").get(sid);
    expect(row).toEqual({ expires_at: now + SESSION_TTL_MS, client_label: "Chrome on Windows", revoked_at: null });
  });
});

describe("handleLookupById", () => {
  const lookup = (env: Env, userId: string) =>
    handleLookupById(
      new Request("http://auth/lookup-by-id", { method: "POST", body: JSON.stringify({ userId }) }),
      env,
    );

  it("returns the user with the newest live pending email", async () => {
    const { env, sqlite, addUser } = setup();
    addUser("u1");
    sqlite.prepare("INSERT INTO user_preferences (user_id, timezone, bio) VALUES ('u1', 'Europe/London', 'hi')").run();
    const now = Date.now();
    addToken(sqlite, "t-old", "u1", now + DAY / 2, "older@example.com");
    addToken(sqlite, "t-new", "u1", now + DAY, "newer@example.com");
    addToken(sqlite, "t-expired", "u1", now - 1000, "expired@example.com");
    addToken(sqlite, "t-signup", "u1", now + 2 * DAY, null);

    const res = await lookup(env, "u1");
    expect(res.status).toBe(200);
    const json = await res.json<{ ok: boolean; data: Record<string, unknown> }>();
    expect(json.data).toEqual({
      userId: "u1",
      email: "u1@example.com",
      name: "U",
      emailVerified: false,
      emailVerificationEnabled: false,
      pendingEmail: "newer@example.com",
      createdAt: expect.any(String),
      timezone: "Europe/London",
      badges: 0,
      bio: "hi",
      handle: null,
      handleLocked: false,
    });
  });

  it("returns pendingEmail null when no change is in flight", async () => {
    const { env, sqlite, addUser } = setup();
    addUser("u1");
    addToken(sqlite, "t-consumed", "u1", Date.now() + DAY, "x@example.com", Date.now());

    const json = await (await lookup(env, "u1")).json<{ data: { pendingEmail: string | null; timezone: string | null } }>();
    expect(json.data.pendingEmail).toBeNull();
    expect(json.data.timezone).toBeNull();
  });

  it("404s for an unknown user", async () => {
    const { env } = setup();
    expect((await lookup(env, "nobody")).status).toBe(404);
  });
});

describe("handoff / authorization-code GC", () => {
  it("admin-handoff-start drops expired handoffs and keeps unexpired (incl. consumed) ones", async () => {
    const { env, sqlite, addUser, ids } = setup();
    addUser("u1");
    const now = Date.now();
    const add = sqlite.prepare(
      "INSERT INTO admin_handoffs (id, user_id, return_to, created_at, expires_at, consumed_at) VALUES (?, 'u1', 'x', ?, ?, ?)",
    );
    add.run("h-expired", now - 10 * 60 * 1000, now - 5 * 60 * 1000, null);
    add.run("h-expired-consumed", now - 10 * 60 * 1000, now - 5 * 60 * 1000, now - 9 * 60 * 1000);
    add.run("h-consumed-live", now - 60 * 1000, now + 4 * 60 * 1000, now - 30 * 1000);

    const res = await handleAdminHandoffStart(
      new Request("http://auth/admin/handoff/start", { method: "POST", body: JSON.stringify({ returnTo: "https://admin.example/auth/callback" }) }),
      env,
    );
    expect(res.status).toBe(200);
    const left = ids("SELECT id FROM admin_handoffs");
    expect(left).toHaveLength(2);
    expect(left).toContain("h-consumed-live");
    expect(left).not.toContain("h-expired");
    expect(left).not.toContain("h-expired-consumed");
  });

  it("oauth-authorize drops expired codes and keeps unexpired (incl. consumed) ones", async () => {
    const { env, sqlite, addUser, ids } = setup();
    addUser("u1");
    const now = Date.now();
    sqlite.prepare(
      "INSERT INTO oauth_clients (client_id, client_name, redirect_uris, allowed_scopes, trusted, disabled, created_at) VALUES ('c1', 'App', ?, 'openid profile email', 1, 0, ?)",
    ).run(JSON.stringify(["https://app.example/cb"]), now);
    const add = sqlite.prepare(
      `INSERT INTO oauth_codes (code, client_id, user_id, redirect_uri, scope, code_challenge, created_at, expires_at, consumed_at)
       VALUES (?, 'c1', 'u1', 'https://app.example/cb', 'openid', 'x', ?, ?, ?)`,
    );
    add.run("code-expired", now - 10 * 60 * 1000, now - 5 * 60 * 1000, null);
    add.run("code-consumed-live", now - 60 * 1000, now + 4 * 60 * 1000, now - 30 * 1000);

    const res = await handleOAuthAuthorize(
      new Request("http://auth/oauth/authorize", {
        method: "POST",
        body: JSON.stringify({
          client_id: "c1", redirect_uri: "https://app.example/cb", response_type: "code",
          scope: "openid", code_challenge: "abc", code_challenge_method: "S256",
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const left = ids("SELECT code AS id FROM oauth_codes");
    expect(left).toHaveLength(2);
    expect(left).toContain("code-consumed-live");
    expect(left).not.toContain("code-expired");
  });
});
