import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useUploads } from "./useUploads";
import { apiFetchJson } from "@/lib/apiFetch";

vi.mock("@/lib/apiFetch", () => ({
  apiFetchJson: vi.fn(),
  apiFetch: vi.fn(),
}));

// jsdom's Blob has no .text() - polyfill via FileReader (test-only).
if (typeof Blob.prototype.text !== "function") {
  Blob.prototype.text = function (this: Blob) {
    return new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result ?? ""));
      r.onerror = () => reject(r.error);
      r.readAsText(this);
    });
  };
}

function makeFile(name: string, size = 8, type = "application/octet-stream") {
  const f = new File([new Uint8Array(Math.min(size, 64))], name, { type });
  // Fake the size for the over-limit cases instead of allocating 50MB.
  Object.defineProperty(f, "size", { value: size });
  return f;
}

function setup(folderId: string | null = null) {
  const onDocCreated = vi.fn();
  const appendDoc = vi.fn();
  const appendFile = vi.fn();
  const utils = renderHook(
    ({ fid }: { fid: string | null }) =>
      useUploads({ projectId: "p1", currentFolderId: fid, onDocCreated, appendDoc, appendFile }),
    { initialProps: { fid: folderId } },
  );
  return { ...utils, onDocCreated, appendDoc, appendFile };
}

beforeEach(() => {
  vi.mocked(apiFetchJson).mockReset();
});

describe("useUploads", () => {
  it("rejects oversized files client-side without POSTing", () => {
    const { result } = setup();
    act(() => result.current.enqueueFiles([makeFile("big.bin", 51 * 1024 * 1024)]));
    expect(result.current.uploads[0].status).toBe("error");
    expect(result.current.uploads[0].error).toContain("50MB");
    expect(vi.mocked(apiFetchJson)).not.toHaveBeenCalled();
  });

  it("surfaces the server's error text on a failed upload", async () => {
    vi.mocked(apiFetchJson).mockResolvedValue({ ok: false, status: 400, error: "Storage quota exceeded" });
    const { result } = setup();
    act(() => result.current.enqueueFiles([makeFile("a.bin")]));
    await waitFor(() => expect(result.current.uploads[0].status).toBe("error"));
    expect(result.current.uploads[0].error).toBe("Storage quota exceeded");
  });

  it("imports .md files as documents (case-insensitive, extension stripped)", async () => {
    vi.mocked(apiFetchJson).mockResolvedValue({ ok: true, status: 200, data: { id: "d1", title: "README" } });
    const { result, onDocCreated, appendDoc } = setup();
    act(() => result.current.enqueueFiles([makeFile("README.MD", 8, "text/plain")]));
    await waitFor(() => expect(onDocCreated).toHaveBeenCalled());
    const [url, init] = vi.mocked(apiFetchJson).mock.calls[0];
    expect(url).toBe("/api/docs");
    expect(JSON.parse((init as RequestInit).body as string).title).toBe("README");
    expect(appendDoc).toHaveBeenCalled();
    // Success removes the card.
    await waitFor(() => expect(result.current.uploads).toHaveLength(0));
  });

  // FM-M2 regression: an upload finishing after the user navigated away must
  // not append its row to the folder they're now viewing.
  it("skips the list append when the user left the target folder", async () => {
    let resolveUpload!: (v: unknown) => void;
    vi.mocked(apiFetchJson).mockImplementation(() => new Promise((res) => { resolveUpload = res; }));
    const { result, rerender, appendFile } = setup("A");
    act(() => result.current.enqueueFiles([makeFile("photo.png", 8, "image/png")]));
    // Navigate to folder B while the POST is in flight.
    rerender({ fid: "B" });
    await act(async () => {
      resolveUpload({ ok: true, status: 201, data: { id: "f1", name: "photo.png", folder_id: "A" } });
    });
    await waitFor(() => expect(result.current.uploads).toHaveLength(0));
    expect(appendFile).not.toHaveBeenCalled();
  });

  it("runs at most 3 uploads concurrently, draining the queue as slots free", async () => {
    const resolvers: ((v: unknown) => void)[] = [];
    vi.mocked(apiFetchJson).mockImplementation(() => new Promise((res) => { resolvers.push(res); }));
    const { result } = setup();
    act(() => result.current.enqueueFiles([1, 2, 3, 4, 5].map((i) => makeFile(`f${i}.bin`))));
    // Only the first 3 POSTs fire; 2 wait in the queue.
    expect(vi.mocked(apiFetchJson)).toHaveBeenCalledTimes(3);
    expect(result.current.uploads.filter((u) => u.status === "queued")).toHaveLength(2);
    await act(async () => { resolvers[0]({ ok: true, status: 201, data: { id: "f1", name: "f1.bin" } }); });
    await waitFor(() => expect(vi.mocked(apiFetchJson)).toHaveBeenCalledTimes(4));
  });
});
