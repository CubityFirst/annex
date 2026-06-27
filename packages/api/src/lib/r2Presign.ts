import { AwsClient } from "aws4fetch";

// R2 S3-API credentials for presigning. All optional: when any is missing
// (local dev, demo, or not yet set up) presigning is disabled and callers fall
// back to the in-Worker token streaming path. Mirrors the custom-domains
// "report not-configured instead of calling out" pattern.
export interface R2PresignEnv {
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_ACCOUNT_ID?: string;
  R2_BUCKET_NAME?: string;
}

export function r2PresignConfigured(env: R2PresignEnv): boolean {
  return !!(env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_ACCOUNT_ID && env.R2_BUCKET_NAME);
}

// TTL for presigned video URLs. Deliberately shorter than the 6h content token:
// the presigned URL is the one capability that R2 serves WITHOUT the Worker, so
// it cannot be revoked server-side before it expires - a tighter window is the
// only lever on its blast radius. A fresh URL is minted on every metadata load.
export const PRESIGN_URL_TTL_SECONDS = 3 * 60 * 60; // 3h

// Presign an S3-style GET URL for an R2 object so a browser media element can
// stream it (with Range/seek) directly from R2 - keeping the Worker out of the
// byte path entirely. The URL is a time-limited bearer capability (same model
// as the in-Worker content token). Returns null when unconfigured so callers
// fall back to the Worker streaming route.
//
// R2 serves this object with NO `nosniff`/`Content-Disposition` (fileServeHeaders
// never runs on the direct path), and echoes the stored Content-Type. Callers
// MUST therefore only presign objects whose stored type is inline-safe, and
// SHOULD pass `responseOverrides.contentType` to force a Worker-controlled type
// rather than trust the (caller-set-at-upload) stored value.
export async function presignR2GetUrl(
  env: R2PresignEnv,
  key: string,
  expiresSeconds: number,
  responseOverrides?: { contentType?: string; contentDisposition?: string },
): Promise<string | null> {
  if (!r2PresignConfigured(env)) return null;
  const client = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID!,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY!,
    service: "s3",
    region: "auto",
  });
  // Key segments (e.g. "files/<id>") stay as path separators; AwsClient handles
  // canonical-URI encoding. SigV4 caps presigned expiry at 7 days.
  const endpoint = `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET_NAME}/${key}`;
  const url = new URL(endpoint);
  url.searchParams.set("X-Amz-Expires", String(Math.min(expiresSeconds, 7 * 24 * 60 * 60)));
  // S3 response-header overrides - force the Content-Type/Disposition R2 returns
  // so the header-less direct path can't echo an attacker-controlled upload mime.
  // These are part of the signed query string, so they can't be tampered with.
  if (responseOverrides?.contentType) url.searchParams.set("response-content-type", responseOverrides.contentType);
  if (responseOverrides?.contentDisposition) url.searchParams.set("response-content-disposition", responseOverrides.contentDisposition);
  const signed = await client.sign(url.toString(), { method: "GET", aws: { signQuery: true } });
  return signed.url;
}
