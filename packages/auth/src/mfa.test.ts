import { describe, it, expect, vi } from "vitest";
import { verifyAndConsumeTotp } from "./mfa";
import { base32Decode } from "./totp";
import { toArrayBuffer } from "./crypto";
import type { Env } from "./index";

const SECRET = "JBSWY3DPEHPK3PXP";

// Reimplements HOTP so tests can generate expected codes independently
// (same helper as totp.test.ts).
async function computeTOTP(secret: string, timeMs: number): Promise<string> {
  const secretBytes = base32Decode(secret);
  const counter = Math.floor(timeMs / 1000 / 30);
  const key = await crypto.subtle.importKey(
    "raw", toArrayBuffer(secretBytes),
    { name: "HMAC", hash: "SHA-1" },
    false, ["sign"],
  );
  const counterBuffer = new ArrayBuffer(8);
  new DataView(counterBuffer).setBigUint64(0, BigInt(counter), false);
  const hmac = new Uint8Array(await crypto.subtle.sign("HMAC", key, counterBuffer));
  const offset = hmac[19] & 0x0f;
  const code = (
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff)
  ) % 1_000_000;
  return code.toString().padStart(6, "0");
}

function makeEnv(updateChanges: number) {
  const run = vi.fn().mockResolvedValue({ meta: { changes: updateChanges } });
  const bind = vi.fn().mockReturnValue({ run });
  const prepare = vi.fn().mockReturnValue({ bind });
  return { env: { DB: { prepare } } as unknown as Env, prepare, bind };
}

describe("verifyAndConsumeTotp", () => {
  it("accepts a valid code when the step consume updates a row", async () => {
    const { env, bind } = makeEnv(1);
    const code = await computeTOTP(SECRET, Date.now());
    expect(await verifyAndConsumeTotp(env, "user-1", SECRET, code)).toBe(true);
    // The consumed step must be bound for both the SET and the strictly-less
    // guard, scoped to the user.
    const expectedStep = Math.floor(Date.now() / 1000 / 30);
    const [setStep, userId, guardStep] = bind.mock.calls[0];
    expect(userId).toBe("user-1");
    expect(setStep).toBe(guardStep);
    // Allow the adjacent drift steps in case the clock ticked mid-test.
    expect(Math.abs(setStep - expectedStep)).toBeLessThanOrEqual(1);
  });

  it("rejects a replayed code: valid code but the conditional update matches no row", async () => {
    const { env } = makeEnv(0);
    const code = await computeTOTP(SECRET, Date.now());
    expect(await verifyAndConsumeTotp(env, "user-1", SECRET, code)).toBe(false);
  });

  it("rejects an invalid code without touching the database", async () => {
    const { env, prepare } = makeEnv(1);
    expect(await verifyAndConsumeTotp(env, "user-1", SECRET, "abcdef")).toBe(false);
    expect(prepare).not.toHaveBeenCalled();
  });
});
