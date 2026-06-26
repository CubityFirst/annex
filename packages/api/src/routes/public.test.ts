import { describe, it, expect, vi } from "vitest";
import { enrichFilesWithStreamUrls, handlePublic } from "./public";
import type { Env } from "../index";

const PRESIGN_ENV = {
  R2_ACCESS_KEY_ID: "AKIAEXAMPLE",
  R2_SECRET_ACCESS_KEY: "secretexamplekey",
  R2_ACCOUNT_ID: "abc123account",
  R2_BUCKET_NAME: "cubedocs-assets",
} as unknown as Env;

const UNCONFIGURED_ENV = {} as unknown as Env;

function file(overrides: Partial<{ id: string; name: string; mime_type: string; size: number; folder_id: string | null }>) {
  return { id: "f1", name: "clip.mp4", mime_type: "video/mp4", size: 100, folder_id: null, ...overrides };
}

describe("enrichFilesWithStreamUrls", () => {
  it("presigns inline-safe videos when R2 is configured", async () => {
    const [row] = await enrichFilesWithStreamUrls(PRESIGN_ENV, [file({})]);
    expect(row.content_stream_url).toBeTruthy();
    const u = new URL(row.content_stream_url!);
    expect(u.host).toBe("abc123account.r2.cloudflarestorage.com");
    expect(u.pathname).toBe("/cubedocs-assets/files/f1");
    expect(u.searchParams.get("response-content-type")).toBe("video/mp4");
    expect(u.searchParams.get("response-content-disposition")).toBe('inline; filename="clip.mp4"');
    expect(u.searchParams.get("X-Amz-Signature")).toBeTruthy();
  });

  it("returns null stream url for videos when presigning is unconfigured", async () => {
    const [row] = await enrichFilesWithStreamUrls(UNCONFIGURED_ENV, [file({})]);
    expect(row.content_stream_url).toBeNull();
  });

  it("never presigns non-video files", async () => {
    const rows = await enrichFilesWithStreamUrls(PRESIGN_ENV, [
      file({ id: "img", name: "pic.png", mime_type: "image/png" }),
      file({ id: "pdf", name: "doc.pdf", mime_type: "application/pdf" }),
      file({ id: "aud", name: "song.mp3", mime_type: "audio/mpeg" }),
    ]);
    for (const r of rows) expect(r.content_stream_url).toBeUndefined();
  });

  it("never presigns non-inline-safe videos (e.g. video/x-matroska)", async () => {
    const [row] = await enrichFilesWithStreamUrls(PRESIGN_ENV, [
      file({ id: "mkv", name: "movie.mkv", mime_type: "video/x-matroska" }),
    ]);
    expect(row.content_stream_url).toBeUndefined();
  });

  it("sanitizes the filename in the content-disposition override", async () => {
    const [row] = await enrichFilesWithStreamUrls(PRESIGN_ENV, [
      file({ id: "f2", name: 'ev"il\n.mp4', mime_type: "video/webm" }),
    ]);
    const u = new URL(row.content_stream_url!);
    expect(u.searchParams.get("response-content-disposition")).toBe('inline; filename="ev_il_.mp4"');
  });

  it("presigns concurrently and preserves order/other fields", async () => {
    const rows = await enrichFilesWithStreamUrls(PRESIGN_ENV, [
      file({ id: "a", mime_type: "video/mp4" }),
      file({ id: "b", name: "doc.pdf", mime_type: "application/pdf" }),
      file({ id: "c", mime_type: "video/ogg" }),
    ]);
    expect(rows.map(r => r.id)).toEqual(["a", "b", "c"]);
    expect(rows[0].content_stream_url).toBeTruthy();
    expect(rows[1].content_stream_url).toBeUndefined();
    expect(rows[2].content_stream_url).toBeTruthy();
  });
});

// env whose DB.prepare().bind().first() resolves to `row`, plus R2 creds so the
// presign path is live (mirrors PRESIGN_ENV).
function envReturning(row: unknown): Env {
  const first = vi.fn().mockResolvedValue(row);
  const bind = vi.fn().mockReturnValue({ first });
  const prepare = vi.fn().mockReturnValue({ bind });
  return { ...(PRESIGN_ENV as object), DB: { prepare } } as unknown as Env;
}

describe("GET /public/files/:id/stream-url (re-sign endpoint)", () => {
  const url = new URL("http://localhost/public/files/f1/stream-url?projectId=p1");

  it("mints a fresh presigned URL for a published inline-safe video", async () => {
    const env = envReturning({ id: "f1", name: "clip.mp4", mime_type: "video/mp4", size: 100, folder_id: null, published_at: "2026-01-01" });
    const res = await handlePublic(new Request(url), env, url);
    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean; data: { url: string | null } }>();
    expect(body.ok).toBe(true);
    expect(new URL(body.data.url!).host).toBe("abc123account.r2.cloudflarestorage.com");
  });

  it("404s when the file's project is not published", async () => {
    const env = envReturning({ id: "f1", name: "clip.mp4", mime_type: "video/mp4", size: 100, folder_id: null, published_at: null });
    const res = await handlePublic(new Request(url), env, url);
    expect(res.status).toBe(404);
  });

  it("returns url:null for a published non-video file (player keeps the Worker route)", async () => {
    const env = envReturning({ id: "f1", name: "pic.png", mime_type: "image/png", size: 100, folder_id: null, published_at: "2026-01-01" });
    const res = await handlePublic(new Request(url), env, url);
    expect(res.status).toBe(200);
    const body = await res.json<{ data: { url: string | null } }>();
    expect(body.data.url).toBeNull();
  });
});
