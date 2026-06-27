import { describe, it, expect } from "vitest";
import { signContentToken, verifyContentToken, CONTENT_TOKEN_TTL_SECONDS } from "./contentToken";

const SECRET = "test-secret-please-ignore";
const NOW = 1_700_000_000;

describe("contentToken", () => {
  it("verifies a freshly minted token for the same file", async () => {
    const token = await signContentToken(SECRET, "file-abc", NOW);
    expect(await verifyContentToken(SECRET, "file-abc", token, NOW)).toBe(true);
  });

  it("is scoped to one file id - a token for A does not authorize B", async () => {
    const token = await signContentToken(SECRET, "file-A", NOW);
    expect(await verifyContentToken(SECRET, "file-B", token, NOW)).toBe(false);
  });

  it("rejects after expiry", async () => {
    const token = await signContentToken(SECRET, "file-abc", NOW);
    const afterExpiry = NOW + CONTENT_TOKEN_TTL_SECONDS + 1;
    expect(await verifyContentToken(SECRET, "file-abc", token, afterExpiry)).toBe(false);
  });

  it("is still valid just before expiry", async () => {
    const token = await signContentToken(SECRET, "file-abc", NOW);
    const justBefore = NOW + CONTENT_TOKEN_TTL_SECONDS - 1;
    expect(await verifyContentToken(SECRET, "file-abc", token, justBefore)).toBe(true);
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await signContentToken(SECRET, "file-abc", NOW);
    expect(await verifyContentToken("other-secret", "file-abc", token, NOW)).toBe(false);
  });

  it("rejects tampered expiry (signature no longer matches)", async () => {
    const token = await signContentToken(SECRET, "file-abc", NOW);
    const [, sig] = token.split(".");
    const forged = `${NOW + 999_999}.${sig}`;
    expect(await verifyContentToken(SECRET, "file-abc", forged, NOW)).toBe(false);
  });

  it("rejects null / malformed tokens", async () => {
    expect(await verifyContentToken(SECRET, "file-abc", null, NOW)).toBe(false);
    expect(await verifyContentToken(SECRET, "file-abc", "", NOW)).toBe(false);
    expect(await verifyContentToken(SECRET, "file-abc", "garbage", NOW)).toBe(false);
    expect(await verifyContentToken(SECRET, "file-abc", "123.!!!notbase64!!!", NOW)).toBe(false);
  });
});
