import { describe, it, expect } from "vitest";
import { resolveImageUrl } from "./index";

const reqUrl = new URL("https://docs.example.com/s/proj/abc");
const projectId = "proj-123";

describe("resolveImageUrl", () => {
  it("returns null for empty input", () => {
    expect(resolveImageUrl("", reqUrl, projectId)).toBeNull();
  });

  it("returns null for whitespace-only input", () => {
    expect(resolveImageUrl("   ", reqUrl, projectId)).toBeNull();
  });

  it("passes https URLs through unchanged", () => {
    expect(resolveImageUrl("https://example.com/cover.png", reqUrl, projectId))
      .toBe("https://example.com/cover.png");
  });

  it("passes http URLs through unchanged", () => {
    expect(resolveImageUrl("http://example.com/cover.png", reqUrl, projectId))
      .toBe("http://example.com/cover.png");
  });

  it("trims surrounding whitespace before matching", () => {
    expect(resolveImageUrl("  https://example.com/x.png  ", reqUrl, projectId))
      .toBe("https://example.com/x.png");
  });

  it("rewrites /api/files/<id>/content to public absolute URL with projectId", () => {
    expect(resolveImageUrl("/api/files/abc/content", reqUrl, projectId))
      .toBe("https://docs.example.com/api/public/files/abc/content?projectId=proj-123");
  });

  it("rewrites /api/files/<id> without /content suffix", () => {
    expect(resolveImageUrl("/api/files/abc", reqUrl, projectId))
      .toBe("https://docs.example.com/api/public/files/abc?projectId=proj-123");
  });

  it("preserves existing query string when rewriting /api/files/", () => {
    expect(resolveImageUrl("/api/files/abc/content?v=2", reqUrl, projectId))
      .toBe("https://docs.example.com/api/public/files/abc/content?v=2&projectId=proj-123");
  });

  it("URL-encodes the projectId", () => {
    expect(resolveImageUrl("/api/files/abc/content", reqUrl, "proj id/with spaces"))
      .toBe("https://docs.example.com/api/public/files/abc/content?projectId=proj%20id%2Fwith%20spaces");
  });

  it("prepends origin to other absolute paths", () => {
    expect(resolveImageUrl("/static/cover.png", reqUrl, projectId))
      .toBe("https://docs.example.com/static/cover.png");
  });

  it("returns null for relative paths starting with ./", () => {
    expect(resolveImageUrl("./cover.png", reqUrl, projectId)).toBeNull();
  });

  it("returns null for bare relative filenames", () => {
    expect(resolveImageUrl("cover.png", reqUrl, projectId)).toBeNull();
  });

  it("returns null for javascript: scheme", () => {
    expect(resolveImageUrl("javascript:alert(1)", reqUrl, projectId)).toBeNull();
  });

  it("returns null for data: scheme", () => {
    expect(resolveImageUrl("data:image/png;base64,iVBOR", reqUrl, projectId)).toBeNull();
  });

  it("uses the request origin, not the api origin", () => {
    const customOrigin = new URL("https://shared.example.org/s/p/d");
    expect(resolveImageUrl("/api/files/x/content", customOrigin, "p"))
      .toBe("https://shared.example.org/api/public/files/x/content?projectId=p");
  });

  // Gap-closer: ensures the `/i` flag on the scheme regex stays. Without it,
  // upstream metadata or CDNs that return uppercase schemes break silently.
  it("matches uppercase HTTPS:// scheme", () => {
    expect(resolveImageUrl("HTTPS://example.com/x.png", reqUrl, projectId))
      .toBe("HTTPS://example.com/x.png");
  });

  // Gap-closer: trim must apply to all branches, not just the https one.
  // Without unconditional trim, this falls through to null.
  it("trims whitespace before /api/files/ rewrite", () => {
    expect(resolveImageUrl("  /api/files/abc/content  ", reqUrl, projectId))
      .toBe("https://docs.example.com/api/public/files/abc/content?projectId=proj-123");
  });

  // Gap-closer: pins down current behavior for empty projectId. Today the
  // function still rewrites and emits `?projectId=`. If a future change adds
  // validation, this test must be updated deliberately.
  it("emits an empty projectId param when projectId is empty (current behavior)", () => {
    expect(resolveImageUrl("/api/files/abc/content", reqUrl, ""))
      .toBe("https://docs.example.com/api/public/files/abc/content?projectId=");
  });

  // Gap-closer: encodeURIComponent escapes `&`, `=`, `?`, `+`; encodeURI does
  // not. A regression to encodeURI (or to no encoding at all) would corrupt
  // the resulting query string in real ways - this test catches both.
  it("URL-encodes query-significant characters in projectId", () => {
    expect(resolveImageUrl("/api/files/abc/content", reqUrl, "a&b=c?d+e"))
      .toBe("https://docs.example.com/api/public/files/abc/content?projectId=a%26b%3Dc%3Fd%2Be");
  });
});
