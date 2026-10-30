import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createSqliteD1 } from "../../api/src/test/sqliteD1";
import type { Env } from "./index";
import {
  consumeChallenge,
  deleteExpiredWebauthnChallenges,
  WEBAUTHN_CHALLENGE_TTL_MS,
} from "./webauthn";

// Real SQLite with every auth migration applied: both functions are a single
// scoped DELETE, so only running it shows which rows it actually takes.
const AUTH_MIGRATIONS = fileURLToPath(new URL("../migrations", import.meta.url));

function makeEnv(challenges: Array<{ id: string; userId?: string; type?: string; createdAt: number }>) {
  const { db, sqlite } = createSqliteD1(AUTH_MIGRATIONS);
  const insert = sqlite.prepare("INSERT INTO webauthn_challenges (id, user_id, challenge, type, created_at) VALUES (?, ?, ?, ?, ?)");
  for (const c of challenges) insert.run(c.id, c.userId ?? "user-1", `challenge-of-${c.id}`, c.type ?? "authentication", c.createdAt);
  const remaining = () => sqlite.prepare("SELECT id FROM webauthn_challenges ORDER BY id").all().map(r => r.id);
  return { env: { DB: db } as unknown as Env, remaining };
}

describe("consumeChallenge", () => {
  it("atomically deletes and returns a valid challenge", async () => {
    const { env, remaining } = makeEnv([{ id: "challenge-1", createdAt: Date.now() }, { id: "challenge-2", createdAt: Date.now() }]);

    expect(await consumeChallenge(env, "challenge-1", "user-1", "authentication"))
      .toBe("challenge-of-challenge-1");
    expect(remaining()).toEqual(["challenge-2"]);
    // Single use: a replay finds nothing.
    expect(await consumeChallenge(env, "challenge-1", "user-1", "authentication")).toBeNull();
  });

  it("refuses (and leaves in place) a challenge for another user or ceremony type", async () => {
    const { env, remaining } = makeEnv([{ id: "challenge-1", createdAt: Date.now() }]);

    expect(await consumeChallenge(env, "challenge-1", "user-2", "authentication")).toBeNull();
    expect(await consumeChallenge(env, "challenge-1", "user-1", "registration")).toBeNull();
    expect(remaining()).toEqual(["challenge-1"]);
  });

  it("still consumes an expired challenge before rejecting it", async () => {
    const { env, remaining } = makeEnv([{ id: "challenge-1", createdAt: Date.now() - WEBAUTHN_CHALLENGE_TTL_MS - 1 }]);

    expect(await consumeChallenge(env, "challenge-1", "user-1", "authentication"))
      .toBeNull();
    expect(remaining()).toEqual([]);
  });
});

describe("deleteExpiredWebauthnChallenges", () => {
  it("deletes challenges at or beyond the ceremony TTL", async () => {
    const now = 1_700_000_000_000;
    const { env, remaining } = makeEnv([
      { id: "older", createdAt: now - WEBAUTHN_CHALLENGE_TTL_MS - 1 },
      { id: "at-ttl", createdAt: now - WEBAUTHN_CHALLENGE_TTL_MS },
      { id: "fresh", createdAt: now - WEBAUTHN_CHALLENGE_TTL_MS + 1 },
    ]);

    await deleteExpiredWebauthnChallenges(env, now);

    expect(remaining()).toEqual(["fresh"]);
  });
});
