import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Env } from "./index";

vi.mock("@simplewebauthn/server", () => ({
  generateRegistrationOptions: vi.fn(),
  verifyRegistrationResponse: vi.fn(),
  generateAuthenticationOptions: vi.fn(),
  verifyAuthenticationResponse: vi.fn(),
}));

import { verifyAuthenticationResponse } from "@simplewebauthn/server";
import { verifyDiscoverableAssertion, verifyWebauthnAssertion } from "./webauthn";

// verifyWebauthnAssertion runs: consumeChallenge (DELETE ... RETURNING .first),
// credential SELECT (.first), then the counter UPDATE (.run).
function makeEnv(counterChanges: number) {
  const sqls: string[] = [];
  const firsts: unknown[] = [
    { challenge: "chal", created_at: Date.now() },
    { id: "AQID", public_key: "AQID", counter: 4 },
  ];
  const first = vi.fn(async () => firsts.shift() ?? null);
  const run = vi.fn(async () => ({ meta: { changes: counterChanges } }));
  const prepare = vi.fn((sql: string) => {
    sqls.push(sql);
    return { bind: vi.fn(() => ({ first, run })) };
  });
  return {
    env: { DB: { prepare }, WEBAUTHN_ORIGIN: "https://x", WEBAUTHN_RP_ID: "x" } as unknown as Env,
    sqls,
    run,
  };
}

function verified(newCounter: number) {
  vi.mocked(verifyAuthenticationResponse).mockResolvedValue({
    verified: true,
    authenticationInfo: { newCounter },
  } as unknown as Awaited<ReturnType<typeof verifyAuthenticationResponse>>);
}

beforeEach(() => vi.clearAllMocks());

describe("verifyWebauthnAssertion signature counter", () => {
  it("advances the counter with a conditional UPDATE and succeeds when it wins", async () => {
    verified(5);
    const { env, sqls } = makeEnv(1);
    expect(await verifyWebauthnAssertion(env, "u1", "c1", { id: "AQID" })).toBeNull();
    expect(sqls.some(s => s.includes("SET counter = ? WHERE id = ? AND counter < ?"))).toBe(true);
  });

  it("rejects a concurrent assertion that lost the counter race (cloned authenticator)", async () => {
    verified(5);
    const { env } = makeEnv(0);
    const res = await verifyWebauthnAssertion(env, "u1", "c1", { id: "AQID" });
    expect(res?.status).toBe(401);
  });

  it("does not touch the counter for counter-less authenticators (synced passkeys report 0)", async () => {
    verified(0);
    const { env, run } = makeEnv(0);
    expect(await verifyWebauthnAssertion(env, "u1", "c1", { id: "AQID" })).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });
});

// verifyDiscoverableAssertion runs: consumeChallenge (.first), credential
// SELECT by id only (.first), then the shared verify + counter UPDATE (.run).
function makeDiscoverableEnv(cred: Record<string, unknown> | null) {
  const binds: unknown[][] = [];
  const firsts: unknown[] = [{ challenge: "chal", created_at: Date.now() }, cred];
  const first = vi.fn(async () => firsts.shift() ?? null);
  const run = vi.fn(async () => ({ meta: { changes: 1 } }));
  const prepare = vi.fn(() => ({
    bind: vi.fn((...args: unknown[]) => {
      binds.push(args);
      return { first, run };
    }),
  }));
  return {
    env: { DB: { prepare }, WEBAUTHN_ORIGIN: "https://x", WEBAUTHN_RP_ID: "x" } as unknown as Env,
    binds,
  };
}

const storedCred = { id: "AQID", user_id: "user-1", public_key: "AQID", counter: 0 };

describe("verifyDiscoverableAssertion", () => {
  it("consumes only a user-less passkey challenge", async () => {
    verified(0);
    const { env, binds } = makeDiscoverableEnv(storedCred);
    await verifyDiscoverableAssertion(env, "c1", { id: "AQID", response: { userHandle: "user-1" } });
    // consumeChallenge binds (id, user_id, type): sentinel user + its own type,
    // so a user-bound authentication challenge can't be redeemed here.
    expect(binds[0]).toEqual(["c1", "", "passkey"]);
  });

  it("resolves the account from the credential when userHandle matches", async () => {
    verified(0);
    const { env } = makeDiscoverableEnv(storedCred);
    const result = await verifyDiscoverableAssertion(env, "c1", { id: "AQID", response: { userHandle: "user-1" } });
    expect(result).toEqual({ userId: "user-1" });
  });

  it.each([
    ["names another account", "user-2"],
    ["is missing", undefined],
  ])("rejects when userHandle %s, before verifying the signature", async (_label, userHandle) => {
    verified(0);
    const { env } = makeDiscoverableEnv(storedCred);
    const result = await verifyDiscoverableAssertion(env, "c1", { id: "AQID", response: { userHandle } });
    expect((result as Response).status).toBe(401);
    expect(verifyAuthenticationResponse).not.toHaveBeenCalled();
  });

  it("rejects an unknown credential", async () => {
    verified(0);
    const { env } = makeDiscoverableEnv(null);
    const result = await verifyDiscoverableAssertion(env, "c1", { id: "nope", response: { userHandle: "user-1" } });
    expect((result as Response).status).toBe(401);
  });

  it("rejects a failed signature", async () => {
    vi.mocked(verifyAuthenticationResponse).mockResolvedValue({ verified: false } as unknown as Awaited<ReturnType<typeof verifyAuthenticationResponse>>);
    const { env } = makeDiscoverableEnv(storedCred);
    const result = await verifyDiscoverableAssertion(env, "c1", { id: "AQID", response: { userHandle: "user-1" } });
    expect((result as Response).status).toBe(401);
  });
});
