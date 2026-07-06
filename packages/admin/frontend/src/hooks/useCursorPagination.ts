import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}

export interface CursorPager<T> {
  items: T[];
  loading: boolean;
  error: string | null;
  pageNumber: number;
  canNewer: boolean;
  canOlder: boolean;
  goNewer: () => void;
  goOlder: () => void;
  // Restart from page 1 with the caller's current filters. Always refetches,
  // even if already on page 1 with the same filters (re-submitting a search
  // must not be a silent no-op).
  reset: () => void;
  // Refetch the CURRENT page in place - e.g. after a mutation that changed
  // the visible rows (delete, disable) without touching the filters.
  refresh: () => void;
}

// The cursor-stack pagination state machine shared by the Users, Projects,
// and Audit pages (previously hand-rolled three times). `cursors` holds the
// cursor used to fetch each page beyond the first; page number =
// cursors.length + 1. Older = push nextCursor, Newer = pop.
//
// The fetcher is read from a ref on every fetch, so it may close over the
// caller's current filter state; call reset() after changing filters. Every
// fetch aborts any in-flight one (last-requested wins, not last-resolved).
export function useCursorPagination<T>(
  fetcher: (cursor: string | undefined, signal: AbortSignal) => Promise<CursorPage<T>>,
): CursorPager<T> {
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const [cursors, setCursors] = useState<string[]>([]);
  // Monotonic fetch trigger: bumped by reset()/refresh() so identical state
  // still refetches. The initial value fires the mount fetch.
  const [tick, setTick] = useState(0);
  const [items, setItems] = useState<T[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);
    const cursor = cursors.length > 0 ? cursors[cursors.length - 1] : undefined;
    fetcherRef.current(cursor, controller.signal)
      .then(page => {
        if (controller.signal.aborted) return;
        if (page.items.length === 0 && cursors.length > 0) {
          // Dead page: e.g. the last row of page N was just deleted. Step
          // back a page instead of stranding the operator on an empty page
          // (the pop re-triggers this effect via the cursors dependency).
          setCursors(c => c.slice(0, -1));
          return;
        }
        setItems(page.items);
        setNextCursor(page.nextCursor);
      })
      .catch(e => {
        if (controller.signal.aborted || (e instanceof DOMException && e.name === "AbortError")) return;
        const msg = e instanceof Error ? e.message : "Failed to load";
        setError(msg);
        toast.error(msg);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [tick, cursors]);

  const pageNumber = cursors.length + 1;

  return {
    items,
    loading,
    error,
    pageNumber,
    canNewer: pageNumber > 1 && !loading,
    canOlder: !!nextCursor && !loading,
    goNewer: () => {
      // Block while a page is in flight: a second click would otherwise read
      // a stale nextCursor from this render and push a duplicate cursor.
      if (loading || pageNumber <= 1) return;
      setCursors(c => c.slice(0, -1));
    },
    goOlder: () => {
      if (loading || !nextCursor) return;
      setCursors(c => [...c, nextCursor]);
    },
    reset: () => {
      setCursors([]);
      setTick(t => t + 1);
    },
    refresh: () => {
      setTick(t => t + 1);
    },
  };
}
