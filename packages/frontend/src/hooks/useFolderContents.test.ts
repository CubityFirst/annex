import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useFolderContents } from "./useFolderContents";
import { apiFetchJson } from "@/lib/apiFetch";

vi.mock("@/lib/apiFetch", () => ({
  apiFetchJson: vi.fn(),
  apiFetch: vi.fn(),
}));

const emptyContents = { folders: [], docs: [], files: [], folderCounts: {}, ancestors: [] };

function contentsWithDoc(id: string, title: string) {
  return {
    ...emptyContents,
    docs: [{ id, title, folder_id: null, updated_at: "2026-01-01T00:00:00Z" }],
  };
}

beforeEach(() => {
  vi.mocked(apiFetchJson).mockReset();
});

describe("useFolderContents", () => {
  it("loads and exposes the folder contents", async () => {
    vi.mocked(apiFetchJson).mockResolvedValue({ ok: true, status: 200, data: contentsWithDoc("d1", "Doc A") });
    const { result } = renderHook(() => useFolderContents("p1", null, "Site"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.docs.map(d => d.title)).toEqual(["Doc A"]);
    expect(result.current.error).toBeNull();
  });

  // FM-H3 regression: a slow response for folder A must not clobber folder B's
  // contents after the user has already navigated on.
  it("ignores a stale response that resolves after a newer load", async () => {
    let resolveSlow!: (v: unknown) => void;
    vi.mocked(apiFetchJson).mockImplementation((url: string) => {
      if (String(url).includes("folderId=A")) {
        return new Promise(res => { resolveSlow = res; });
      }
      return Promise.resolve({ ok: true, status: 200, data: contentsWithDoc("d-b", "Folder B doc") });
    });

    const { result, rerender } = renderHook(
      ({ folderId }: { folderId: string | null }) => useFolderContents("p1", folderId, "Site"),
      { initialProps: { folderId: "A" as string | null } },
    );
    // Navigate to folder B while A's request is still in flight.
    rerender({ folderId: "B" });
    await waitFor(() => expect(result.current.docs.map(d => d.id)).toEqual(["d-b"]));

    // Folder A's slow response finally lands - it must be dropped.
    await act(async () => {
      resolveSlow({ ok: true, status: 200, data: contentsWithDoc("d-a", "Folder A doc") });
    });
    expect(result.current.docs.map(d => d.id)).toEqual(["d-b"]);
  });

  // FM-M5: a failed load is an error state with the server's reason, not an
  // indistinguishable "This folder is empty".
  it("surfaces a failed load as an error instead of empty contents", async () => {
    vi.mocked(apiFetchJson).mockResolvedValue({ ok: false, status: 500, error: "boom" });
    const { result } = renderHook(() => useFolderContents("p1", null, "Site"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe("boom");
  });

  it("defaults a missing files count to 0 (pre-split API responses)", async () => {
    vi.mocked(apiFetchJson).mockResolvedValue({
      ok: true,
      status: 200,
      data: { ...emptyContents, folderCounts: { f1: { docs: 2, folders: 1 } } },
    });
    const { result } = renderHook(() => useFolderContents("p1", null, "Site"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.folderCounts.get("f1")).toEqual({ docs: 2, files: 0, folders: 1 });
  });
});
