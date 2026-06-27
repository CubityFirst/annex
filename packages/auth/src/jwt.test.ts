import { describe, it, expect } from "vitest";
import { signJwt, verifyJwt } from "./jwt";
import type { Session } from "./lib";

const SECRET = "test-jwt-secret";
const PAYLOAD: Session = {
  userId: "user-abc",
  email: "test@example.com",
  expiresAt: Date.now() + 60_000,
};

describe("signJwt / verifyJwt", () => {
  it("round-trips: verify returns the original payload", async () => {
    const token = await signJwt(PAYLOAD, SECRET);
    const session = await verifyJwt(token, SECRET);
    expect(session).not.toBeNull();
    expect(session!.userId).toBe(PAYLOAD.userId);
    expect(session!.email).toBe(PAYLOAD.email);
    expect(session!.expiresAt).toBe(PAYLOAD.expiresAt);
  });

  it("produces a three-part dot-separated string", async () => {
    const token = await signJwt(PAYLOAD, SECRET);
    expect(token.split(".")).toHaveLength(3);
  });

  it("returns null when verified with the wrong secret", async () => {
    const token = await signJwt(PAYLOAD, SECRET);
    expect(await verifyJwt(token, "wrong-secret")).toBeNull();
  });

  it("returns null for a token with only two parts", async () => {
    expect(await verifyJwt("header.payload", SECRET)).toBeNull();
  });

  it("returns null for an empty string", async () => {
    expect(await verifyJwt("", SECRET)).toBeNull();
  });

  it("returns null for a token with a tampered payload", async () => {
    const token = await signJwt(PAYLOAD, SECRET);
    const [h, , s] = token.split(".");
    const tampered = btoa(JSON.stringify({ ...PAYLOAD, isAdmin: true }))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
    expect(await verifyJwt(`${h}.${tampered}.${s}`, SECRET)).toBeNull();
  });

  it("returns null for an expired token", async () => {
    const expired: Session = { ...PAYLOAD, expiresAt: Date.now() - 1000 };
    const token = await signJwt(expired, SECRET);
    expect(await verifyJwt(token, SECRET)).toBeNull();
  });

  it("preserves optional isAdmin field", async () => {
    const admin: Session = { ...PAYLOAD, isAdmin: true };
    const token = await signJwt(admin, SECRET);
    const session = await verifyJwt(token, SECRET);
    expect(session!.isAdmin).toBe(true);
  });

  it("preserves optional forcePasswordChange field", async () => {
    const forced: Session = { ...PAYLOAD, forcePasswordChange: true };
    const token = await signJwt(forced, SECRET);
    const session = await verifyJwt(token, SECRET);
    expect(session!.forcePasswordChange).toBe(true);
  });

  it("different secrets produce different tokens for the same payload", async () => {
    const t1 = await signJwt(PAYLOAD, "secret-a");
    const t2 = await signJwt(PAYLOAD, "secret-b");
    expect(t1).not.toBe(t2);
  });

  it("preserves optional sid field", async () => {
    const withSid: Session = { ...PAYLOAD, sid: "session-uuid" };
    const token = await signJwt(withSid, SECRET);
    const session = await verifyJwt(token, SECRET);
    expect(session!.sid).toBe("session-uuid");
  });

  it("rejects a token whose header alg is not HS256", async () => {
    const token = await signJwt(PAYLOAD, SECRET);
    const [, body, sig] = token.split(".");
    // Replace the header with one that claims `alg: none` while keeping the
    // body and (now-invalid) signature - the alg check must reject before
    // the signature is consulted.
    const noneHeader = btoa(JSON.stringify({ alg: "none", typ: "JWT" }))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
    expect(await verifyJwt(`${noneHeader}.${body}.${sig}`, SECRET)).toBeNull();
  });

  it("rejects a token whose header typ is not JWT", async () => {
    const token = await signJwt(PAYLOAD, SECRET);
    const [, body, sig] = token.split(".");
    const wrongTyp = btoa(JSON.stringify({ alg: "HS256", typ: "JWE" }))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
    expect(await verifyJwt(`${wrongTyp}.${body}.${sig}`, SECRET)).toBeNull();
  });

  it("rejects a token with an unparseable header", async () => {
    const token = await signJwt(PAYLOAD, SECRET);
    const [, body, sig] = token.split(".");
    expect(await verifyJwt(`!!!.${body}.${sig}`, SECRET)).toBeNull();
  });

  it("returns null (not a throw) for a signature that is not valid base64", async () => {
    const token = await signJwt(PAYLOAD, SECRET);
    const [h, body] = token.split(".");
    await expect(verifyJwt(`${h}.${body}.!!!not-base64!!!`, SECRET)).resolves.toBeNull();
  });

  it("rejects a correctly-signed token that lacks expiresAt", async () => {
    const noExpiry = { userId: "user-abc", email: "test@example.com" } as unknown as Session;
    const token = await signJwt(noExpiry, SECRET);
    expect(await verifyJwt(token, SECRET)).toBeNull();
  });

  it("rejects a correctly-signed token whose expiresAt is not a number", async () => {
    const badExpiry = { ...PAYLOAD, expiresAt: "9999999999999" } as unknown as Session;
    const token = await signJwt(badExpiry, SECRET);
    expect(await verifyJwt(token, SECRET)).toBeNull();
  });
});
