// Short-lived, file-scoped capability token for streaming a private file's
// bytes by URL. A browser media element (<video>/<audio>) or <iframe> can't set
// the Authorization header on its range/seek subrequests, so the content route
// also accepts a `?token=` it can carry in the URL instead.
//
// The token is an HMAC-SHA256 over "<prefix>:<fileId>:<exp>" keyed by the
// worker's JWT_SECRET (domain-separated by the prefix so it can't be confused
// with a session JWT). It is minted only AFTER a normal authenticated access
// check (GET /files/:id) and is a capability for exactly ONE file id until exp.
// Unlike putting the raw session JWT in the URL, a leaked/shared content URL
// grants only that single file for the TTL - not the user's whole account.

const PREFIX = "filecontent.v1";

// Long enough to watch a long video straight through, short enough to bound the
// blast radius of a leaked URL. A fresh token is minted on every metadata load.
export const CONTENT_TOKEN_TTL_SECONDS = 6 * 60 * 60; // 6h

function bytesToB64Url(buf: ArrayBuffer): string {
  const arr = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64UrlToBytes(b64url: string): Uint8Array<ArrayBuffer> | null {
  try {
    const bin = atob(b64url.replace(/-/g, "+").replace(/_/g, "/"));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function message(fileId: string, exp: number): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`${PREFIX}:${fileId}:${exp}`);
}

export async function signContentToken(
  secret: string,
  fileId: string,
  nowSeconds: number,
  ttl = CONTENT_TOKEN_TTL_SECONDS,
): Promise<string> {
  const exp = nowSeconds + ttl;
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), message(fileId, exp));
  return `${exp}.${bytesToB64Url(sig)}`;
}

// Constant-time verification via crypto.subtle.verify. Returns true only for a
// well-formed, unexpired token whose signature matches this exact fileId.
export async function verifyContentToken(
  secret: string,
  fileId: string,
  token: string | null,
  nowSeconds: number,
): Promise<boolean> {
  if (!token) return false;
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const exp = parseInt(token.slice(0, dot), 10);
  if (!Number.isFinite(exp) || exp < nowSeconds) return false;
  const sig = b64UrlToBytes(token.slice(dot + 1));
  if (!sig) return false;
  return crypto.subtle.verify("HMAC", await hmacKey(secret), sig, message(fileId, exp));
}
