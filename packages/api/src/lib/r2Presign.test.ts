import { describe, it, expect } from "vitest";
import { r2PresignConfigured, presignR2GetUrl } from "./r2Presign";

const FULL = {
  R2_ACCESS_KEY_ID: "AKIAEXAMPLE",
  R2_SECRET_ACCESS_KEY: "secretexamplekey",
  R2_ACCOUNT_ID: "abc123account",
  R2_BUCKET_NAME: "cubedocs-assets",
};

describe("r2PresignConfigured", () => {
  it("is true only when all four values are present", () => {
    expect(r2PresignConfigured(FULL)).toBe(true);
    expect(r2PresignConfigured({ ...FULL, R2_ACCESS_KEY_ID: undefined })).toBe(false);
    expect(r2PresignConfigured({ ...FULL, R2_SECRET_ACCESS_KEY: undefined })).toBe(false);
    expect(r2PresignConfigured({ ...FULL, R2_ACCOUNT_ID: undefined })).toBe(false);
    expect(r2PresignConfigured({ ...FULL, R2_BUCKET_NAME: undefined })).toBe(false);
    expect(r2PresignConfigured({})).toBe(false);
  });
});

describe("presignR2GetUrl", () => {
  it("returns null when unconfigured (caller falls back to the Worker route)", async () => {
    expect(await presignR2GetUrl({}, "files/abc", 3600)).toBeNull();
  });

  it("produces a SigV4 presigned GET URL for the object", async () => {
    const url = await presignR2GetUrl(FULL, "files/abc-123", 3600);
    expect(url).toBeTruthy();
    const u = new URL(url!);
    expect(u.host).toBe("abc123account.r2.cloudflarestorage.com");
    expect(u.pathname).toBe("/cubedocs-assets/files/abc-123");
    expect(u.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(u.searchParams.get("X-Amz-Expires")).toBe("3600");
    expect(u.searchParams.get("X-Amz-Signature")).toBeTruthy();
    expect(u.searchParams.get("X-Amz-Credential")).toContain("/auto/s3/aws4_request");
  });

  it("clamps expiry to the SigV4 7-day maximum", async () => {
    const url = await presignR2GetUrl(FULL, "files/x", 30 * 24 * 60 * 60);
    expect(new URL(url!).searchParams.get("X-Amz-Expires")).toBe(String(7 * 24 * 60 * 60));
  });

  it("folds response-type/disposition overrides into the signed query string", async () => {
    const url = await presignR2GetUrl(FULL, "files/x", 3600, {
      contentType: "video/mp4",
      contentDisposition: 'inline; filename="clip.mp4"',
    });
    const u = new URL(url!);
    expect(u.searchParams.get("response-content-type")).toBe("video/mp4");
    expect(u.searchParams.get("response-content-disposition")).toBe('inline; filename="clip.mp4"');
    // Overrides must be inside the signed set (X-Amz-SignedHeaders/Signature present),
    // so they can't be swapped by the client without breaking the signature.
    expect(u.searchParams.get("X-Amz-Signature")).toBeTruthy();
  });
});
