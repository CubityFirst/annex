import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useCursorPagination, type CursorPage } from "./useCursorPagination";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

type Item = { id: string };

function pages(map: Record<string, CursorPage<Item>>) {
  // Keyed by cursor ("" = first page).
  return vi.fn(async (cursor: string | undefined) => {
    const page = map[cursor ?? ""];
    if (!page) throw new Error(`no page for cursor ${cursor}`);
    return page;
  });
}

beforeEach(() => vi.clearAllMocks());

describe("useCursorPagination", () => {
  it("auto-loads page 1 on mount", async () => {
    const fetcher = pages({ "": { items: [{ id: "a" }], nextCursor: null } });
    const { result } = renderHook(() => useCursorPagination<Item>(fetcher));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.items).toEqual([{ id: "a" }]);
    expect(result.current.pageNumber).toBe(1);
    expect(result.current.canOlder).toBe(false);
  });

  it("goOlder pushes the cursor; goNewer pops it", async () => {
    const fetcher = pages({
      "": { items: [{ id: "a" }], nextCursor: "c1" },
      c1: { items: [{ id: "b" }], nextCursor: null },
    });
    const { result } = renderHook(() => useCursorPagination<Item>(fetcher));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.goOlder());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.pageNumber).toBe(2);
    expect(result.current.items).toEqual([{ id: "b" }]);

    act(() => result.current.goNewer());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.pageNumber).toBe(1);
    expect(result.current.items).toEqual([{ id: "a" }]);
  });

  it("reset() ALWAYS refetches - re-submitting the same search is a refresh, not a no-op (AF-C2)", async () => {
    const fetcher = pages({ "": { items: [{ id: "a" }], nextCursor: null } });
    const { result } = renderHook(() => useCursorPagination<Item>(fetcher));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetcher).toHaveBeenCalledTimes(1);

    act(() => result.current.reset());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("refresh() refetches the CURRENT page in place", async () => {
    const fetcher = pages({
      "": { items: [{ id: "a" }], nextCursor: "c1" },
      c1: { items: [{ id: "b" }], nextCursor: null },
    });
    const { result } = renderHook(() => useCursorPagination<Item>(fetcher));
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.goOlder());
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.pageNumber).toBe(2);
    expect(fetcher).toHaveBeenLastCalledWith("c1", expect.anything());
  });

  it("steps back automatically when a refresh finds the current page empty (AF-C10 dead page)", async () => {
    let deleted = false;
    const fetcher = vi.fn(async (cursor: string | undefined): Promise<CursorPage<Item>> => {
      if (cursor === undefined) return { items: [{ id: "a" }], nextCursor: "c1" };
      // Page 2 had one row, then it was deleted.
      return deleted ? { items: [], nextCursor: null } : { items: [{ id: "b" }], nextCursor: null };
    });
    const { result } = renderHook(() => useCursorPagination<Item>(fetcher));
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.goOlder());
    await waitFor(() => expect(result.current.pageNumber).toBe(2));

    deleted = true;
    act(() => result.current.refresh());
    // The empty page 2 pops back to page 1 instead of stranding the operator.
    await waitFor(() => expect(result.current.pageNumber).toBe(1));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.items).toEqual([{ id: "a" }]);
  });

  it("reads the LATEST fetcher on reset (filters committed in the same render)", async () => {
    const calls: string[] = [];
    const { result, rerender } = renderHook(
      ({ filter }: { filter: string }) =>
        useCursorPagination<Item>(async () => {
          calls.push(filter);
          return { items: [], nextCursor: null };
        }),
      { initialProps: { filter: "first" } },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    rerender({ filter: "second" });
    act(() => result.current.reset());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(calls[calls.length - 1]).toBe("second");
  });

  it("records errors (and keeps prior items) instead of clearing the list", async () => {
    let fail = false;
    const fetcher = vi.fn(async (): Promise<CursorPage<Item>> => {
      if (fail) throw new Error("boom");
      return { items: [{ id: "a" }], nextCursor: null };
    });
    const { result } = renderHook(() => useCursorPagination<Item>(fetcher));
    await waitFor(() => expect(result.current.loading).toBe(false));

    fail = true;
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe("boom");
    expect(result.current.items).toEqual([{ id: "a" }]);
  });
});
