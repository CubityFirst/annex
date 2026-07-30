import { describe, expect, it, vi } from "vitest";
import type { Env } from "./index";
import {
  consumeChallenge,
  deleteExpiredWebauthnChallenges,
  WEBAUTHN_CHALLENGE_TTL_MS,
} from "./webauthn";

function makeConsumeEnv(row: { challenge: string; created_at: number } | null) {
  const first = vi.fn().mockResolvedValue(row);
  const bind = vi.fn().mockReturnValue({ first });
  const prepare = vi.fn().mockReturnValue({ bind });
  return { env: { DB: { prepare } } as unknown as Env, prepare, bind };
}

describe("consumeChallenge", () => {
  it("atomically deletes and returns a valid challenge", async () => {
    const { env, prepare, bind } = makeConsumeEnv({
      challenge: "expected-challenge",
      created_at: Date.now(),
    });

    expect(await consumeChallenge(env, "challenge-1", "user-1", "authentication"))
      .toBe("expected-challenge");
    expect(prepare).toHaveBeenCalledTimes(1);
    const sql = prepare.mock.calls[0][0] as string;
    expect(sql).toContain("DELETE FROM webauthn_challenges");
    expect(sql).toContain("RETURNING challenge, created_at");
    expect(bind).toHaveBeenCalledWith("challenge-1", "user-1", "authentication");
  });

  it("still consumes an expired challenge before rejecting it", async () => {
    const { env, prepare } = makeConsumeEnv({
      challenge: "expired-challenge",
      created_at: Date.now() - WEBAUTHN_CHALLENGE_TTL_MS - 1,
    });

    expect(await consumeChallenge(env, "challenge-1", "user-1", "authentication"))
      .toBeNull();
    expect(prepare).toHaveBeenCalledTimes(1);
  });
});

describe("deleteExpiredWebauthnChallenges", () => {
  it("deletes challenges at or beyond the ceremony TTL", async () => {
    const run = vi.fn().mockResolvedValue({});
    const bind = vi.fn().mockReturnValue({ run });
    const prepare = vi.fn().mockReturnValue({ bind });
    const env = { DB: { prepare } } as unknown as Env;
    const now = 1_700_000_000_000;

    await deleteExpiredWebauthnChallenges(env, now);

    expect(prepare).toHaveBeenCalledWith(expect.stringContaining("created_at <= ?"));
    expect(bind).toHaveBeenCalledWith(now - WEBAUTHN_CHALLENGE_TTL_MS);
    expect(run).toHaveBeenCalledOnce();
  });
});
