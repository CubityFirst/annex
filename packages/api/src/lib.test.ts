import { describe, it, expect, vi } from "vitest";
import { fileServeHeaders, folderInProject, wouldCreateFolderCycle, parseByteRange, serveR2Object } from "./lib";

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
