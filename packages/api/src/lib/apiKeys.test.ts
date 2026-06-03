import { describe, it, expect, vi } from "vitest";
import {
  API_KEY_PREFIX,
  isApiKeyToken,
  generateApiKeySecret,
  keyDisplayPrefix,
  hashApiKey,
  scopeAllowsWrite,
  apiKeyInviteRoleAllowed,
  apiKeyRemoveAllowed,
  authenticateApiKey,
} from "./apiKeys";
import type { Env } from "../index";

describe("isApiKeyToken (credential discrimination)", () => {
  it("recognises only tokens carrying the api-key prefix", () => {
    expect(isApiKeyToken(`${API_KEY_PREFIX}abc123`)).toBe(true);
    expect(isApiKeyToken("annx_")).toBe(true);
  });

  it("rejects JWTs (three dot-separated segments) and junk", () => {
    // A JWT must never be mistaken for an API key — that's the whole basis for
    // keeping the two auth paths isolated.
    expect(isApiKeyToken("aaa.bbb.ccc")).toBe(false);
    expect(isApiKeyToken("eyJhbGciOiJIUzI1NiJ9.eyJ1c2VyIjoieCJ9.sig")).toBe(false);
    expect(isApiKeyToken("")).toBe(false);
    expect(isApiKeyToken("Bearer annx_x")).toBe(false); // prefix must be at the start
    expect(isApiKeyToken("random-token")).toBe(false);
  });
});

describe("generateApiKeySecret", () => {
  it("is prefixed, url-safe, high-entropy and unique per call", () => {
    const a = generateApiKeySecret();
    const b = generateApiKeySecret();
    expect(a.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(a).not.toBe(b);
    // 32 random bytes → 43 base64url chars, plus the prefix.
    expect(a.length).toBeGreaterThanOrEqual(API_KEY_PREFIX.length + 40);
    // Only url-safe base64 characters after the prefix (no +, /, =).
    expect(a.slice(API_KEY_PREFIX.length)).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("keyDisplayPrefix", () => {
  it("exposes only the prefix + first 6 chars of the random part", () => {
    const secret = `${API_KEY_PREFIX}AbCdEf1234567890`;
    expect(keyDisplayPrefix(secret)).toBe(`${API_KEY_PREFIX}AbCdEf`);
    expect(keyDisplayPrefix(secret).length).toBe(API_KEY_PREFIX.length + 6);
  });
});

describe("hashApiKey", () => {
  it("matches a known SHA-256 vector (pins the algorithm)", async () => {
    // SHA-256("abc")
    expect(await hashApiKey("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("is deterministic and 64 hex chars; different inputs differ", async () => {
    const s = generateApiKeySecret();
    const h1 = await hashApiKey(s);
    const h2 = await hashApiKey(s);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashApiKey(s + "x")).not.toBe(h1);
  });
});

describe("scopeAllowsWrite", () => {
  it("only read-write keys may mutate", () => {
    expect(scopeAllowsWrite("read")).toBe(false);
    expect(scopeAllowsWrite("readwrite")).toBe(true);
  });
});

describe("apiKeyInviteRoleAllowed (no escalation, never owner)", () => {
  it("requires the caller to be admin or owner", () => {
    expect(apiKeyInviteRoleAllowed("viewer", "viewer")).toBe(false);
    expect(apiKeyInviteRoleAllowed("editor", "viewer")).toBe(false);
    expect(apiKeyInviteRoleAllowed("limited", "viewer")).toBe(false);
  });

  it("admins can assign roles up to their own, never owner", () => {
    expect(apiKeyInviteRoleAllowed("admin", "limited")).toBe(true);
    expect(apiKeyInviteRoleAllowed("admin", "viewer")).toBe(true);
    expect(apiKeyInviteRoleAllowed("admin", "editor")).toBe(true);
    expect(apiKeyInviteRoleAllowed("admin", "admin")).toBe(true);
    expect(apiKeyInviteRoleAllowed("admin", "owner")).toBe(false);
  });

  it("owners can assign any assignable role but never owner", () => {
    expect(apiKeyInviteRoleAllowed("owner", "admin")).toBe(true);
    expect(apiKeyInviteRoleAllowed("owner", "editor")).toBe(true);
    expect(apiKeyInviteRoleAllowed("owner", "owner")).toBe(false);
  });
});

describe("apiKeyRemoveAllowed (mirror members.ts removal rules)", () => {
  it("non-admins can remove nobody", () => {
    expect(apiKeyRemoveAllowed("editor", "viewer")).toBe(false);
    expect(apiKeyRemoveAllowed("viewer", "viewer")).toBe(false);
  });

  it("owner is never removable", () => {
    expect(apiKeyRemoveAllowed("admin", "owner")).toBe(false);
    expect(apiKeyRemoveAllowed("owner", "owner")).toBe(false);
  });

  it("admins cannot remove admins; owners can", () => {
    expect(apiKeyRemoveAllowed("admin", "admin")).toBe(false);
    expect(apiKeyRemoveAllowed("owner", "admin")).toBe(true);
    expect(apiKeyRemoveAllowed("admin", "editor")).toBe(true);
    expect(apiKeyRemoveAllowed("admin", "viewer")).toBe(true);
  });
});

// ── authenticateApiKey: the auth gate, against a mocked D1 ───────────────────

interface StubRow {
  id: string;
  user_id: string;
  project_id: string;
  scope: "read" | "readwrite";
  can_invite: number;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
}

function makeEnv(row: StubRow | null) {
  const run = vi.fn().mockResolvedValue({ meta: { changes: 1 } });
  const first = vi.fn().mockResolvedValue(row);
  const bind = vi.fn().mockReturnValue({ first, run });
  const prepare = vi.fn().mockReturnValue({ bind });
  return { env: { DB: { prepare } } as unknown as Env, prepare, bind, first, run };
}

function validRow(over: Partial<StubRow> = {}): StubRow {
  return {
    id: "key-1",
    user_id: "user-1",
    project_id: "proj-1",
    scope: "readwrite",
    can_invite: 1,
    last_used_at: new Date().toISOString(),
    expires_at: null,
    revoked_at: null,
    ...over,
  };
}

describe("authenticateApiKey", () => {
  it("returns null for a non-prefixed token without touching the DB", async () => {
    const { env, prepare } = makeEnv(validRow());
    expect(await authenticateApiKey("aaa.bbb.ccc", env)).toBeNull();
    expect(prepare).not.toHaveBeenCalled();
  });

  it("returns null when no key matches the hash", async () => {
    const { env } = makeEnv(null);
    expect(await authenticateApiKey("annx_doesnotexist", env)).toBeNull();
  });

  it("returns null for a revoked key", async () => {
    const { env } = makeEnv(validRow({ revoked_at: new Date().toISOString() }));
    expect(await authenticateApiKey("annx_revoked", env)).toBeNull();
  });

  it("returns null for an expired key", async () => {
    const { env } = makeEnv(validRow({ expires_at: new Date(Date.now() - 1000).toISOString() }));
    expect(await authenticateApiKey("annx_expired", env)).toBeNull();
  });

  it("resolves a valid key to its scope, mapping can_invite", async () => {
    const { env } = makeEnv(validRow({ scope: "read", can_invite: 0 }));
    const auth = await authenticateApiKey("annx_valid", env);
    expect(auth).toEqual({
      keyId: "key-1",
      userId: "user-1",
      projectId: "proj-1",
      scope: "read",
      canInvite: false,
    });
  });

  it("does NOT refresh last_used_at when it is fresh (<10 min)", async () => {
    const { env, run } = makeEnv(validRow({ last_used_at: new Date().toISOString() }));
    await authenticateApiKey("annx_fresh", env);
    expect(run).not.toHaveBeenCalled();
  });

  it("refreshes last_used_at when stale (>10 min) but never fails the request on a write error", async () => {
    const { env, run } = makeEnv(validRow({ last_used_at: new Date(Date.now() - 11 * 60 * 1000).toISOString() }));
    run.mockRejectedValueOnce(new Error("d1 down"));
    const auth = await authenticateApiKey("annx_stale", env);
    expect(run).toHaveBeenCalledTimes(1);
    expect(auth).not.toBeNull(); // write failure is swallowed
  });
});
