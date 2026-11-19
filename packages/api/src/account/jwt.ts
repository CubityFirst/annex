// HS256 session tokens for Annex's own sessions (docs app and admin panel).
//
// Since the identity split this secret is Annex-only: the identity service
// signs its id_tokens with its own RS256 key and never sees JWT_SECRET. The
// token is proof that Annex minted a session; every claim that can change is
// re-read from the database on each request (see account/session.ts).

export interface SessionToken {
  userId: string;
  email: string;
  expiresAt: number;
  isAdmin?: boolean;
  // Server-side session row id (sessions.id). Required: a token without one
  // is refused by loadCurrentSession.
  sid?: string;
}

const ALG = { name: "HMAC", hash: "SHA-256" };
const enc = new TextEncoder();

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const { buffer, byteOffset, byteLength } = bytes;
  if (buffer instanceof ArrayBuffer) return buffer.slice(byteOffset, byteOffset + byteLength);
  const copy = new Uint8Array(byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function importKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", toArrayBuffer(enc.encode(secret)), ALG, false, ["sign", "verify"]);
}

export function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

export function b64urlDecodeBytes(str: string): Uint8Array {
  return Uint8Array.from(atob(str.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
}

function b64urlDecode(str: string): string {
  return new TextDecoder().decode(b64urlDecodeBytes(str));
}

function encodeJSON(obj: unknown): string {
  return b64url(enc.encode(JSON.stringify(obj)));
}

export async function hmacSign(data: string, secret: string): Promise<string> {
  const key = await importKey(secret);
  return b64url(await crypto.subtle.sign(ALG, key, enc.encode(data)));
}

export async function hmacVerify(data: string, sig: string, secret: string): Promise<boolean> {
  let sigBytes: Uint8Array;
  try {
    sigBytes = b64urlDecodeBytes(sig);
  } catch {
    return false;
  }
  const key = await importKey(secret);
  return crypto.subtle.verify(ALG, key, toArrayBuffer(sigBytes), enc.encode(data));
}

export async function signJwt(payload: SessionToken, secret: string): Promise<string> {
  const header = encodeJSON({ alg: "HS256", typ: "JWT" });
  const body = encodeJSON(payload);
  return `${header}.${body}.${await hmacSign(`${header}.${body}`, secret)}`;
}

export async function verifyJwt(token: string, secret: string): Promise<SessionToken | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  // Pin the algorithm: a verifier that accepted several algs would be one
  // bug away from `alg: none` / RS-HS confusion.
  let header: { alg?: unknown; typ?: unknown };
  try {
    header = JSON.parse(b64urlDecode(parts[0]));
  } catch {
    return null;
  }
  if (header.alg !== "HS256" || header.typ !== "JWT") return null;

  if (!(await hmacVerify(`${parts[0]}.${parts[1]}`, parts[2], secret))) return null;

  let payload: SessionToken;
  try {
    payload = JSON.parse(b64urlDecode(parts[1]));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object" || typeof payload.userId !== "string") return null;
  // Fail closed on a missing/malformed expiry: `undefined < n` is false.
  if (typeof payload.expiresAt !== "number" || payload.expiresAt < Date.now()) return null;
  return payload;
}

export async function sha256b64url(input: string): Promise<string> {
  return b64url(await crypto.subtle.digest("SHA-256", enc.encode(input)));
}

export function randomToken(bytes = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}
