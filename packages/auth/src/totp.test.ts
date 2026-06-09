import { describe, it, expect } from "vitest";
import { base32Encode, base32Decode, buildOtpauthUri, verifyTOTP, matchTotpStep, generateSecret } from "./totp";
import { toArrayBuffer } from "./crypto";

// Reimplements HOTP so tests can generate expected codes independently.
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

// ── base32Encode / base32Decode ──────────────────────────────────────────────

describe("base32Encode / base32Decode", () => {
  it("round-trips arbitrary bytes", () => {
    const original = new Uint8Array([104, 101, 108, 108, 111]); // "hello"
    expect(base32Decode(base32Encode(original))).toEqual(original);
  });

  it("round-trips 20 random bytes", () => {
    const bytes = crypto.getRandomValues(new Uint8Array(20));
    expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
  });

  it("encodes to uppercase A-Z 2-7 characters only", () => {
    const bytes = new Uint8Array([0, 255, 128, 64, 32]);
    expect(base32Encode(bytes)).toMatch(/^[A-Z2-7]+$/);
  });

  it("base32Decode is case-insensitive", () => {
    expect(base32Decode("JBSWY3DP")).toEqual(base32Decode("jbswy3dp"));
  });

  it("base32Decode strips padding and non-alphabet characters", () => {
    expect(base32Decode("JBSWY3DP====")).toEqual(base32Decode("JBSWY3DP"));
  });
});

// ── generateSecret ───────────────────────────────────────────────────────────

describe("generateSecret", () => {
  it("returns a valid base32 string", () => {
    expect(generateSecret()).toMatch(/^[A-Z2-7]+$/);
  });

  it("generates unique values each time", () => {
    expect(generateSecret()).not.toBe(generateSecret());
  });

  it("decodes to exactly 20 bytes (160 bits)", () => {
    expect(base32Decode(generateSecret()).length).toBe(20);
  });
});

// ── buildOtpauthUri ──────────────────────────────────────────────────────────

describe("buildOtpauthUri", () => {
  it("produces a valid otpauth://totp/ URI", () => {
    expect(buildOtpauthUri("SECRET", "user@example.com")).toMatch(/^otpauth:\/\/totp\//);
  });

  it("includes the secret in the URI", () => {
    expect(buildOtpauthUri("MYSECRET", "u@e.com")).toContain("MYSECRET");
  });

  it("URL-encodes the email in the label", () => {
    const uri = buildOtpauthUri("S", "user@example.com");
    expect(uri).toContain(encodeURIComponent("user@example.com"));
  });

  it("uses Annex as the default issuer", () => {
    expect(buildOtpauthUri("S", "u@e.com")).toContain("issuer=Annex");
  });

  it("uses a custom issuer when provided", () => {
    expect(buildOtpauthUri("S", "u@e.com", "MyApp")).toContain("issuer=MyApp");
  });

  it("specifies SHA1 algorithm, 6 digits, 30 second period", () => {
    const uri = buildOtpauthUri("S", "u@e.com");
    expect(uri).toContain("algorithm=SHA1");
    expect(uri).toContain("digits=6");
    expect(uri).toContain("period=30");
  });
});

// ── verifyTOTP ───────────────────────────────────────────────────────────────

describe("verifyTOTP", () => {
  const SECRET = "JBSWY3DPEHPK3PXP";
  const NOW = 1_700_000_000_000; // fixed ms timestamp for deterministic tests

  it("accepts the current time step's code", async () => {
    const code = await computeTOTP(SECRET, NOW);
    expect(await verifyTOTP(SECRET, code, NOW)).toBe(true);
  });

  it("accepts a code from one step in the past (clock drift tolerance)", async () => {
    const code = await computeTOTP(SECRET, NOW - 30_000);
    expect(await verifyTOTP(SECRET, code, NOW)).toBe(true);
  });

  it("accepts a code from one step in the future (clock drift tolerance)", async () => {
    const code = await computeTOTP(SECRET, NOW + 30_000);
    expect(await verifyTOTP(SECRET, code, NOW)).toBe(true);
  });

  it("rejects a code from two steps in the past", async () => {
    const code = await computeTOTP(SECRET, NOW - 60_000);
    expect(await verifyTOTP(SECRET, code, NOW)).toBe(false);
  });

  it("rejects a code for a different secret", async () => {
    const code = await computeTOTP("AAAAAAAAAAAAAAAA", NOW);
    expect(await verifyTOTP(SECRET, code, NOW)).toBe(false);
  });

  it("rejects a 5-digit code (too short)", async () => {
    expect(await verifyTOTP(SECRET, "12345", NOW)).toBe(false);
  });

  it("rejects a 7-digit code (too long)", async () => {
    expect(await verifyTOTP(SECRET, "1234567", NOW)).toBe(false);
  });

  it("rejects an empty string", async () => {
    expect(await verifyTOTP(SECRET, "", NOW)).toBe(false);
  });

  it("rejects a non-numeric code", async () => {
    expect(await verifyTOTP(SECRET, "abcdef", NOW)).toBe(false);
  });
});

// ── matchTotpStep ────────────────────────────────────────────────────────────

describe("matchTotpStep", () => {
  const SECRET = "JBSWY3DPEHPK3PXP";
  const NOW = 1_700_000_000_000;
  const STEP_NOW = Math.floor(NOW / 1000 / 30);

  it("returns the current step for the current code", async () => {
    const code = await computeTOTP(SECRET, NOW);
    expect(await matchTotpStep(SECRET, code, NOW)).toBe(STEP_NOW);
  });

  it("returns the previous step for a one-step-old code", async () => {
    const code = await computeTOTP(SECRET, NOW - 30_000);
    expect(await matchTotpStep(SECRET, code, NOW)).toBe(STEP_NOW - 1);
  });

  it("returns the next step for a one-step-ahead code", async () => {
    const code = await computeTOTP(SECRET, NOW + 30_000);
    expect(await matchTotpStep(SECRET, code, NOW)).toBe(STEP_NOW + 1);
  });

  it("returns null for a code from a different secret", async () => {
    const code = await computeTOTP("AAAAAAAAAAAAAAAA", NOW);
    expect(await matchTotpStep(SECRET, code, NOW)).toBeNull();
  });

  it("returns null for a malformed code", async () => {
    expect(await matchTotpStep(SECRET, "abcdef", NOW)).toBeNull();
  });
});
