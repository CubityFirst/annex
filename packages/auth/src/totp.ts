import { toArrayBuffer } from "./crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Uint8Array): string {
  let result = "";
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += BASE32_ALPHABET[(value >>> bits) & 31];
    }
  }
  if (bits > 0) {
    result += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return result;
}

export function base32Decode(str: string): Uint8Array {
  const clean = str.toUpperCase().replace(/[^A-Z2-7]/g, "");
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of clean) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 255);
    }
  }
  return new Uint8Array(bytes);
}

async function hotp(secretBytes: Uint8Array, counter: bigint): Promise<number> {
  const key = await crypto.subtle.importKey(
    "raw", toArrayBuffer(secretBytes),
    { name: "HMAC", hash: "SHA-1" },
    false, ["sign"],
  );
  const counterBuffer = new ArrayBuffer(8);
  new DataView(counterBuffer).setBigUint64(0, counter, false);
  const hmac = new Uint8Array(await crypto.subtle.sign("HMAC", key, counterBuffer));
  const offset = hmac[19] & 0x0f;
  const code = (
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff)
  ) % 1_000_000;
  return code;
}

// Returns the 30-second time step the code matched (within the ±1-step clock
// drift window), or null when invalid. Login-flow callers must go through
// verifyAndConsumeTotp (mfa.ts), which persists the step to enforce the
// RFC 6238 never-accept-the-same-or-earlier-OTP replay rule.
export async function matchTotpStep(secret: string, code: string, timeMs: number = Date.now()): Promise<number | null> {
  if (!/^\d{6}$/.test(code)) return null;
  const secretBytes = base32Decode(secret);
  const counter = Math.floor(timeMs / 1000 / 30);
  for (let delta = -1; delta <= 1; delta++) {
    const expected = await hotp(secretBytes, BigInt(counter + delta));
    if (expected.toString().padStart(6, "0") === code) return counter + delta;
  }
  return null;
}

export async function verifyTOTP(secret: string, code: string, timeMs: number = Date.now()): Promise<boolean> {
  return (await matchTotpStep(secret, code, timeMs)) !== null;
}

export function generateSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  return base32Encode(bytes);
}

export function buildOtpauthUri(secret: string, email: string, issuer = "Annex"): string {
  const label = encodeURIComponent(`${issuer}:${email}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
