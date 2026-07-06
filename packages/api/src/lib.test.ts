import { describe, it, expect, vi } from "vitest";
import { fileServeHeaders, contentDispositionValue, deriveUploadMime, fileContentEtag, sanitizeUploadFileName, FILE_NAME_INVALID_CHARS, folderInProject, wouldCreateFolderCycle, parseByteRange, serveR2Object, isInlineSafeMime, isMutableFile, EXCALIDRAW_MIME } from "./lib";

// Minimal D1-ish stub: prepare().bind().first() resolves to the queued result.
function dbReturning(result: unknown) {
  const first = vi.fn().mockResolvedValue(result);
  const bind = vi.fn().mockReturnValue({ first });
  const prepare = vi.fn().mockReturnValue({ bind });
  return { db: { prepare } as unknown as D1Database, prepare, bind, first };
}

describe("folderInProject (cross-project relocation guard)", () => {
  it("treats null/empty target as the project root (always valid, no query)", async () => {
    const { db, prepare } = dbReturning(null);
    expect(await folderInProject(db, null, "proj-1")).toBe(true);
    expect(await folderInProject(db, undefined, "proj-1")).toBe(true);
    expect(await folderInProject(db, "", "proj-1")).toBe(true);
    expect(prepare).not.toHaveBeenCalled();
  });

  it("returns true only when a row matches the folder+project", async () => {
    const { db, bind } = dbReturning({ ok: 1 });
    expect(await folderInProject(db, "folder-A", "proj-1", "docs")).toBe(true);
    expect(bind).toHaveBeenCalledWith("folder-A", "proj-1", "docs");
  });

  it("returns false when the folder belongs to another project (no row)", async () => {
    const { db } = dbReturning(null);
    expect(await folderInProject(db, "folder-in-proj-2", "proj-1")).toBe(false);
  });
});

describe("wouldCreateFolderCycle", () => {
  it("true when the folder appears in the new parent's ancestor chain", async () => {
    const { db } = dbReturning({ ok: 1 });
    expect(await wouldCreateFolderCycle(db, "F", "descendant-of-F")).toBe(true);
  });
  it("false when no cycle (no row)", async () => {
    const { db } = dbReturning(null);
    expect(await wouldCreateFolderCycle(db, "F", "unrelated")).toBe(false);
  });
});

describe("contentDispositionValue (RFC 5987 filename encoding)", () => {
  // The Workers Headers constructor throws on non-ISO-8859-1 values, so every
  // produced value must construct a Headers without throwing.
  const headerSafe = (v: string) => new Headers({ "Content-Disposition": v });

  it("keeps a plain ASCII name as a bare filename= (no filename*)", () => {
    const v = contentDispositionValue("inline", "cat.png");
    expect(v).toBe('inline; filename="cat.png"');
    expect(() => headerSafe(v)).not.toThrow();
  });

  it("encodes a CJK name: ASCII fallback + RFC 5987 filename*", () => {
    const v = contentDispositionValue("attachment", "レポート.pdf");
    expect(() => headerSafe(v)).not.toThrow();
    expect(v).toMatch(/^attachment; filename="____\.pdf"/);
    expect(v).toContain("filename*=UTF-8''%E3%83%AC%E3%83%9D%E3%83%BC%E3%83%88.pdf");
    // The whole value must be printable ASCII (ISO-8859-1-safe by construction).
    expect(v).toMatch(/^[\x20-\x7e]+$/);
  });

  it("encodes emoji + accented names", () => {
    const v = contentDispositionValue("inline", "résumé 🎉.png");
    expect(() => headerSafe(v)).not.toThrow();
    expect(v).toMatch(/^[\x20-\x7e]+$/);
    // é = %C3%A9, 🎉 = %F0%9F%8E%89 (UTF-8 percent-encoded)
    expect(v).toContain("filename*=UTF-8''r%C3%A9sum%C3%A9%20%F0%9F%8E%89.png");
  });

  it("percent-encodes the RFC 5987 non-attr-chars ' ( ) * in filename*", () => {
    const v = contentDispositionValue("inline", "a'(b)*é.txt");
    expect(v).toContain("filename*=UTF-8''a%27%28b%29%2A%C3%A9.txt");
  });

  it("neutralizes quotes/CRLF in the fallback (header-injection defence)", () => {
    const v = contentDispositionValue("attachment", 'a".png\r\nSet-Cookie: x=1');
    expect(v).toMatch(/^[\x20-\x7e]+$/);
    expect(v).not.toContain('""');
    expect(v).not.toContain("\r");
    expect(v).not.toContain("\n");
    expect(() => headerSafe(v)).not.toThrow();
  });

  it("falls back to 'file' for an empty name", () => {
    expect(contentDispositionValue("attachment", "")).toBe('attachment; filename="file"');
  });
});

describe("fileServeHeaders (stored-XSS defence)", () => {
  it("serves real images inline with their declared type", () => {
    const h = fileServeHeaders("image/png", "cat.png");
    expect(h["Content-Type"]).toBe("image/png");
    expect(h["Content-Disposition"]).toBe('inline; filename="cat.png"');
    expect(h["X-Content-Type-Options"]).toBe("nosniff");
  });

  it("forces HTML uploads to download as octet-stream (no inline execution)", () => {
    const h = fileServeHeaders("text/html", "evil.html");
    expect(h["Content-Type"]).toBe("application/octet-stream");
    expect(h["Content-Disposition"]).toBe('attachment; filename="evil.html"');
    expect(h["X-Content-Type-Options"]).toBe("nosniff");
  });

  it("forces SVG (script-capable) to download", () => {
    const h = fileServeHeaders("image/svg+xml", "x.svg");
    expect(h["Content-Type"]).toBe("application/octet-stream");
    expect(h["Content-Disposition"]).toContain("attachment");
  });

  it("ignores parameters/case when matching the allowlist", () => {
    const h = fileServeHeaders("IMAGE/PNG; charset=binary", "a.png");
    expect(h["Content-Disposition"]).toContain("inline");
    // declared type is preserved verbatim for the browser
    expect(h["Content-Type"]).toBe("IMAGE/PNG; charset=binary");
  });

  it("treats html disguised with an image extension as still html → download", () => {
    // mime is the source of truth, not the name
    const h = fileServeHeaders("text/html", "notreally.png");
    expect(h["Content-Disposition"]).toContain("attachment");
  });

  it("strips quotes/control chars from the filename (header-injection defence)", () => {
    const h = fileServeHeaders("image/png", 'a".png\r\nSet-Cookie: x=1');
    expect(h["Content-Disposition"]).not.toContain('"a"');
    expect(h["Content-Disposition"]).not.toContain("\r");
    expect(h["Content-Disposition"]).not.toContain("\n");
  });

  it("defaults empty/unknown mime to download", () => {
    const h = fileServeHeaders(null, "x");
    expect(h["Content-Type"]).toBe("application/octet-stream");
    expect(h["Content-Disposition"]).toContain("attachment");
  });

  it("sets Referrer-Policy: no-referrer so a token URL can't leak via Referer", () => {
    expect(fileServeHeaders("image/png", "cat.png")["Referrer-Policy"]).toBe("no-referrer");
    expect(fileServeHeaders("text/html", "evil.html")["Referrer-Policy"]).toBe("no-referrer");
  });

  it("serves a non-Latin-1 filename without making the Headers constructor throw", () => {
    const h = fileServeHeaders("application/pdf", "レポート 🎉.pdf");
    expect(() => new Headers(h)).not.toThrow();
    expect(h["Content-Disposition"]).toContain("filename*=UTF-8''");
  });
});

describe("deriveUploadMime (server-side MIME, SC-H3)", () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).buffer as ArrayBuffer;
  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1]).buffer as ArrayBuffer;
  const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1]).buffer as ArrayBuffer;
  const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]).buffer as ArrayBuffer;
  const HTML = new TextEncoder().encode("<script>alert(1)</script>").buffer as ArrayBuffer;

  it("maps allowlisted extensions regardless of any client-declared type", () => {
    expect(deriveUploadMime("cat.png", PNG)).toBe("image/png");
    expect(deriveUploadMime("photo.JPG", JPEG)).toBe("image/jpeg");
    expect(deriveUploadMime("anim.gif", GIF)).toBe("image/gif");
    expect(deriveUploadMime("pic.webp", WEBP)).toBe("image/webp");
    expect(deriveUploadMime("doc.pdf", HTML)).toBe("application/pdf");
    expect(deriveUploadMime("notes.md", HTML)).toBe("text/markdown");
    expect(deriveUploadMime("song.mp3", HTML)).toBe("audio/mpeg");
    expect(deriveUploadMime("clip.mov", HTML)).toBe("video/quicktime");
  });

  it("keeps the vendor MIME for .excalidraw (drawing mutability keys off it)", () => {
    expect(deriveUploadMime("sketch.excalidraw", HTML)).toBe(EXCALIDRAW_MIME);
    expect(isMutableFile(deriveUploadMime("sketch.excalidraw", HTML))).toBe(true);
  });

  it("keeps the audio/video formats the players support inline-playable", () => {
    // These previously rode in on the client-declared type; the allowlist must
    // carry them or the audio player / doc embeds regress to download cards.
    expect(deriveUploadMime("track.aac", HTML)).toBe("audio/aac");
    expect(deriveUploadMime("track.opus", HTML)).toBe("audio/ogg");
    expect(deriveUploadMime("track.weba", HTML)).toBe("audio/webm");
    expect(deriveUploadMime("clip.ogv", HTML)).toBe("video/ogg");
    for (const name of ["track.aac", "track.opus", "track.weba", "clip.ogv"]) {
      expect(isInlineSafeMime(deriveUploadMime(name, HTML))).toBe(true);
    }
    // JPEG-in-disguise extensions still sniff as JPEG.
    expect(deriveUploadMime("photo.jfif", JPEG)).toBe("image/jpeg");
  });

  it("maps .svg to image/svg+xml (still forced to download downstream)", () => {
    expect(deriveUploadMime("x.svg", HTML)).toBe("image/svg+xml");
    expect(isInlineSafeMime(deriveUploadMime("x.svg", HTML))).toBe(false);
  });

  it("falls back to octet-stream for unknown or missing extensions", () => {
    expect(deriveUploadMime("run.exe", PNG)).toBe("application/octet-stream");
    expect(deriveUploadMime("noext", PNG)).toBe("application/octet-stream");
    expect(deriveUploadMime("archive.tar.xyz", PNG)).toBe("application/octet-stream");
  });

  it("sniffs raster image magic bytes - a scriptable payload named *.png is not image/png", () => {
    expect(deriveUploadMime("evil.png", HTML)).toBe("application/octet-stream");
    expect(deriveUploadMime("evil.jpg", HTML)).toBe("application/octet-stream");
    expect(deriveUploadMime("evil.gif", HTML)).toBe("application/octet-stream");
    expect(deriveUploadMime("evil.webp", HTML)).toBe("application/octet-stream");
    // …and mismatched signatures across image types are refused too
    expect(deriveUploadMime("actually-jpeg.png", JPEG)).toBe("application/octet-stream");
  });
});

describe("isInlineSafeMime", () => {
  it("accepts allowlisted inline types (incl. video), case/param-insensitive", () => {
    expect(isInlineSafeMime("video/mp4")).toBe(true);
    expect(isInlineSafeMime("video/quicktime")).toBe(true);
    expect(isInlineSafeMime("VIDEO/WEBM")).toBe(true);
    expect(isInlineSafeMime("video/mp4; codecs=avc1")).toBe(true);
    expect(isInlineSafeMime("image/png")).toBe(true);
  });

  it("rejects non-allowlisted / dangerous / empty types", () => {
    expect(isInlineSafeMime("video/x-matroska")).toBe(false); // mkv not on the list
    expect(isInlineSafeMime("text/html")).toBe(false);
    expect(isInlineSafeMime("image/svg+xml")).toBe(false);
    expect(isInlineSafeMime("application/octet-stream")).toBe(false);
    expect(isInlineSafeMime(null)).toBe(false);
    expect(isInlineSafeMime("")).toBe(false);
  });
});

describe("isMutableFile (drawings-only content overwrite)", () => {
  it("is true only for the Excalidraw vendor MIME, case/param-insensitive", () => {
    expect(isMutableFile(EXCALIDRAW_MIME)).toBe(true);
    expect(isMutableFile("application/vnd.excalidraw+json")).toBe(true);
    expect(isMutableFile("APPLICATION/VND.EXCALIDRAW+JSON")).toBe(true);
    expect(isMutableFile("application/vnd.excalidraw+json; charset=utf-8")).toBe(true);
  });

  it("is false for uploaded media / plain JSON / empty (keeps them immutable)", () => {
    expect(isMutableFile("application/json")).toBe(false);
    expect(isMutableFile("image/png")).toBe(false);
    expect(isMutableFile("text/plain")).toBe(false);
    expect(isMutableFile(null)).toBe(false);
    expect(isMutableFile("")).toBe(false);
  });
});

describe("parseByteRange", () => {
  it("returns null for a missing/unhandled range so the caller serves the full body", () => {
    expect(parseByteRange("bytes=0-1,5-6", 1000)).toBeNull(); // multi-range unsupported
    expect(parseByteRange("items=0-1", 1000)).toBeNull();
    expect(parseByteRange("bytes=-", 1000)).toBeNull();
  });

  it("parses a closed range", () => {
    expect(parseByteRange("bytes=0-499", 1000)).toEqual({ offset: 0, length: 500 });
    expect(parseByteRange("bytes=500-999", 1000)).toEqual({ offset: 500, length: 500 });
  });

  it("parses an open-ended range to the end of the object", () => {
    expect(parseByteRange("bytes=500-", 1000)).toEqual({ offset: 500, length: 500 });
  });

  it("clamps an end past the object size", () => {
    expect(parseByteRange("bytes=0-99999", 1000)).toEqual({ offset: 0, length: 1000 });
  });

  it("parses a suffix range (last N bytes)", () => {
    expect(parseByteRange("bytes=-200", 1000)).toEqual({ offset: 800, length: 200 });
    expect(parseByteRange("bytes=-5000", 1000)).toEqual({ offset: 0, length: 1000 }); // suffix bigger than file
  });

  it("flags out-of-bounds / empty ranges as unsatisfiable", () => {
    expect(parseByteRange("bytes=1000-1001", 1000)).toBe("unsatisfiable"); // start at/after EOF
    expect(parseByteRange("bytes=-0", 1000)).toBe("unsatisfiable"); // zero-length suffix
    expect(parseByteRange("bytes=0-0", 0)).toBe("unsatisfiable"); // empty object
  });
});

describe("serveR2Object (streaming + range)", () => {
  // R2 bucket stub: get(key, opts?) returns an object whose body echoes the
  // requested range, or the full size when no range is passed.
  function bucketOf(size: number) {
    return {
      get: vi.fn(async (_key: string, opts?: { range?: { offset: number; length: number } }) => ({
        body: new ReadableStream(),
        range: opts?.range,
        size,
      })),
    } as unknown as R2Bucket;
  }
  const baseOpts = (request: Request) => ({
    mimeType: "video/mp4",
    filename: "clip.mp4",
    size: 1000,
    etag: '"file123"',
    cacheControl: "private, max-age=300",
    request,
  });

  it("serves a full 200 with Accept-Ranges and Content-Length when no Range header", async () => {
    const res = await serveR2Object(bucketOf(1000), "files/x", baseOpts(new Request("https://x/")));
    expect(res.status).toBe(200);
    expect(res.headers.get("Accept-Ranges")).toBe("bytes");
    expect(res.headers.get("Content-Length")).toBe("1000");
    expect(res.headers.get("Content-Type")).toBe("video/mp4");
  });

  it("serves 206 Partial Content with Content-Range for a ranged request", async () => {
    const req = new Request("https://x/", { headers: { Range: "bytes=0-499" } });
    const res = await serveR2Object(bucketOf(1000), "files/x", baseOpts(req));
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe("bytes 0-499/1000");
    expect(res.headers.get("Content-Length")).toBe("500");
  });

  it("returns 416 for an unsatisfiable range", async () => {
    const req = new Request("https://x/", { headers: { Range: "bytes=2000-3000" } });
    const res = await serveR2Object(bucketOf(1000), "files/x", baseOpts(req));
    expect(res.status).toBe(416);
    expect(res.headers.get("Content-Range")).toBe("bytes */1000");
  });

  it("honors If-None-Match with 304 for a full (non-ranged) request", async () => {
    const req = new Request("https://x/", { headers: { "If-None-Match": '"file123"' } });
    const res = await serveR2Object(bucketOf(1000), "files/x", baseOpts(req));
    expect(res.status).toBe(304);
  });

  it("never 304s a ranged seek even if If-None-Match matches", async () => {
    const req = new Request("https://x/", { headers: { "If-None-Match": '"file123"', Range: "bytes=0-9" } });
    const res = await serveR2Object(bucketOf(1000), "files/x", baseOpts(req));
    expect(res.status).toBe(206);
  });
});

describe("fileContentEtag", () => {
  it("versions by updated_at ms and quotes the value", () => {
    expect(fileContentEtag("f1", "2026-01-01T00:00:00.000Z")).toBe(`"f1-${new Date("2026-01-01T00:00:00.000Z").getTime()}"`);
  });

  it("uses version 0 for the legacy NULL updated_at", () => {
    expect(fileContentEtag("f1", null)).toBe('"f1-0"');
  });
});

describe("sanitizeUploadFileName / FILE_NAME_INVALID_CHARS", () => {
  const NL = String.fromCharCode(10);
  const NUL = String.fromCharCode(0);
  const BS = String.fromCharCode(92);

  it("strips control chars and replaces path separators", () => {
    expect(sanitizeUploadFileName("a" + NL + "b.bin")).toBe("ab.bin");
    expect(sanitizeUploadFileName("dir/sub" + BS + "file.bin")).toBe("dir_sub_file.bin");
  });

  it("trims, truncates to 255 and falls back to 'untitled'", () => {
    expect(sanitizeUploadFileName("  padded.bin  ")).toBe("padded.bin");
    expect(sanitizeUploadFileName("x".repeat(300)).length).toBe(255);
    expect(sanitizeUploadFileName("")).toBe("untitled");
    expect(sanitizeUploadFileName(NUL + NL)).toBe("untitled");
  });

  it("shares the character rules with the rename gate", () => {
    expect(FILE_NAME_INVALID_CHARS.test("fine name.png")).toBe(false);
    expect(FILE_NAME_INVALID_CHARS.test("bad" + NL + "name")).toBe(true);
    expect(FILE_NAME_INVALID_CHARS.test("bad/name")).toBe(true);
    expect(FILE_NAME_INVALID_CHARS.test("bad" + BS + "name")).toBe(true);
  });
});
