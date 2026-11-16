import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

/**
 * Fraction of the scroll viewport (from its top) that acts as the "reading
 * line": the active section is the last one whose top has scrolled above it.
 * Kept near the top so the section you are actually reading (the one whose
 * heading sits at the top of the viewport) wins over the next one peeking in
 * below a short section.
 */
export const ACTIVE_LINE_RATIO = 0.2;

/** Cap on the reading line, in px, so tall viewports don't push it too low. */
export const ACTIVE_LINE_MAX = 160;

/** Within this many px of the scroll end counts as "clamped at the bottom". */
const BOTTOM_EPSILON = 4;

export interface SpyGeometry {
  /** Each section's top, in px, relative to the top of the scroll viewport. */
  tops: Map<string, number>;
  /** Visible height of the scroll viewport. */
  viewportHeight: number;
  /** scrollHeight - clientHeight; <= 0 when the container doesn't scroll. */
  maxScroll: number;
  /** Current scrollTop. */
  scrollTop: number;
}

/** The y (px from the scroll viewport's top) a section must cross to activate. */
export function readingLine(viewportHeight: number): number {
  return Math.min(viewportHeight * ACTIVE_LINE_RATIO, ACTIVE_LINE_MAX);
}

/**
 * Pure active-section picker over measured geometry. Returns the last section
 * (in the supplied order) whose top has crossed the reading line, or the first
 * present section when none has.
 *
 * SettingsShell ends its content column with a measured spacer (see
 * trailingSpacerHeight) just tall enough for the last section - even a short
 * one like Sessions or Danger zone - to scroll up to the line, and no further;
 * no "sweep" is needed. The only bottom-of-page special case left is narrow:
 * when the container is clamped at the bottom AND the last section's top is
 * already in the upper half of the viewport (a safety net if the spacer is
 * momentarily stale), the last section wins. A last section merely peeking in at the bottom never steals
 * the highlight from the section being read.
 */
export function pickActiveSection(orderedIds: string[], geometry: SpyGeometry): string | null {
  const present = orderedIds.filter(id => geometry.tops.has(id));
  if (present.length === 0) return null;

  const { viewportHeight, maxScroll, scrollTop } = geometry;
  const line = readingLine(viewportHeight);

  let current = present[0];
  for (const id of present) {
    if ((geometry.tops.get(id) ?? Infinity) <= line) current = id;
    else break;
  }

  const last = present[present.length - 1];
  const scrolls = maxScroll > BOTTOM_EPSILON;
  const atBottom = scrolls && maxScroll - scrollTop <= BOTTOM_EPSILON;
  if (atBottom && current !== last && (geometry.tops.get(last) ?? Infinity) <= viewportHeight / 2) {
    return last;
  }
  return current;
}

/**
 * Finds the real scroll container for a settings section. Settings pages
 * render inside DocsLayout's `<div className="flex-1 overflow-y-auto …">`
 * (DocsLayout.tsx) - the page roots themselves have no overflow, so window/
 * document never scrolls. We observe and scroll that ancestor.
 */
function scrollContainerOf(el: HTMLElement): HTMLElement | null {
  return el.closest<HTMLElement>(".overflow-y-auto");
}

/** Keys that scroll the page; pressing one releases a click-pinned section. */
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " ", "Spacebar"]);

export interface ScrollSpy {
  /** The id of the section currently considered active. */
  active: string | null;
  /** Smooth-scroll the section into view and mark it active immediately. */
  scrollTo: (id: string) => void;
}

/**
 * Scroll-spy over a fixed, ordered set of section ids.
 *
 * - Listens to scroll (rAF-throttled) on the shared DocsLayout scroller and
 *   measures section tops, so it is robust to variable section heights and
 *   conditionally-rendered / role-gated sections.
 * - The reading line sits near the top (see readingLine) so the heading you
 *   scrolled to becomes active rather than the one below a short section.
 * - `scrollTo` (outline click, jump select, hash deep link) pins the target as
 *   active until the user scrolls themselves (wheel, touch, scroll keys or a
 *   scrollbar drag). The programmatic smooth scroll passing through
 *   intermediate sections never moves the highlight, and a target that can't
 *   reach the line still stays selected.
 *
 * The listener is re-initialised whenever the visible id set changes (keyed on
 * the joined ids), which is what makes gated sections appear/disappear cleanly.
 */
export function useScrollSpy(orderedIds: string[]): ScrollSpy {
  const [active, setActive] = useState<string | null>(orderedIds[0] ?? null);
  /** Section pinned by the last scrollTo; cleared by user-initiated scrolling. */
  const pinnedRef = useRef<string | null>(null);
  const key = orderedIds.join("|");

  useEffect(() => {
    const ids = key ? key.split("|") : [];
    // Seed to the first present section so the outline has a marked item on
    // mount (before the first measurement), while preserving a still-valid
    // prior selection across re-inits.
    setActive(prev => (prev && ids.includes(prev) ? prev : (ids[0] ?? null)));
    if (pinnedRef.current && !ids.includes(pinnedRef.current)) pinnedRef.current = null;

    const first = ids.map(id => document.getElementById(id)).find((el): el is HTMLElement => el !== null);
    if (!first) return;
    const root = scrollContainerOf(first);
    const target: HTMLElement | Window = root ?? window;

    const measure = () => {
      if (pinnedRef.current) return;
      const tops = new Map<string, number>();
      const rootTop = root ? root.getBoundingClientRect().top : 0;
      for (const id of ids) {
        const el = document.getElementById(id);
        if (el) tops.set(id, el.getBoundingClientRect().top - rootTop);
      }
      const scroller = root ?? document.scrollingElement ?? document.documentElement;
      const viewportHeight = root ? root.clientHeight : window.innerHeight;
      const next = pickActiveSection(ids, {
        tops,
        viewportHeight,
        maxScroll: scroller.scrollHeight - viewportHeight,
        scrollTop: scroller.scrollTop,
      });
      if (next) setActive(next);
    };

    let frame = 0;
    const schedule = () => {
      if (pinnedRef.current || frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };

    // Any sign the user is driving the scroll releases a click-pinned section.
    const release = () => {
      if (!pinnedRef.current) return;
      pinnedRef.current = null;
      schedule();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (!SCROLL_KEYS.has(e.key)) return;
      const el = e.target as HTMLElement | null;
      // Arrow/space keys inside a field or listbox don't scroll the page.
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.closest("[role=listbox],[role=menu],[role=radiogroup]"))) return;
      release();
    };
    // A press on the scroller itself (not its content) is a scrollbar drag.
    const onPointerDown = (e: PointerEvent) => {
      if (e.target === root) release();
    };

    measure();
    target.addEventListener("scroll", schedule, { passive: true });
    target.addEventListener("wheel", release, { passive: true });
    target.addEventListener("touchmove", release, { passive: true });
    if (root) root.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      target.removeEventListener("scroll", schedule);
      target.removeEventListener("wheel", release);
      target.removeEventListener("touchmove", release);
      if (root) root.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", schedule);
    };
  }, [key]);

  const scrollTo = useCallback((id: string) => {
    const el = document.getElementById(id);
    if (!el) return;
    // Mark active up front (so the outline marker moves instantly) and pin it
    // until the user scrolls on their own.
    pinnedRef.current = id;
    setActive(id);
    const container = scrollContainerOf(el);
    if (container) {
      const offset = el.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop - 24;
      const maxScroll = container.scrollHeight - container.clientHeight;
      container.scrollTo({ top: Math.max(0, Math.min(offset, maxScroll)), behavior: "smooth" });
    } else {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, []);

  return { active, scrollTo };
}

/**
 * Height for the spacer that ends a settings content column: exactly enough
 * extra scroll for the last section's top to reach the reading line at max
 * scroll (so scroll-spy can select it), and never more - so the page can't be
 * scrolled until the last section is nearly off screen. 0 when the content
 * already has that much tail below the last section, or fits without
 * scrolling. All px, in scroll-content coordinates; `naturalScrollHeight` is
 * the scroll height without the spacer.
 */
export function trailingSpacerHeight({
  viewportHeight,
  naturalScrollHeight,
  lastTop,
}: {
  viewportHeight: number;
  naturalScrollHeight: number;
  lastTop: number;
}): number {
  if (naturalScrollHeight <= viewportHeight) return 0;
  const naturalTail = naturalScrollHeight - lastTop;
  // +1px so sub-pixel layout can't leave the top a hair below the line.
  return Math.max(0, Math.ceil(viewportHeight - readingLine(viewportHeight) - naturalTail + 1));
}

/**
 * Measures the trailing spacer (see trailingSpacerHeight) for section
 * `lastId`. `spacerRef` is the spacer element; its parent (the content column)
 * and the scroll container are observed so the height tracks async-loaded
 * content and viewport resizes. A layout effect, so a hash deep-link's scroll
 * already sees the final height.
 */
export function useTrailingSpacer(lastId: string | null, spacerRef: RefObject<HTMLElement | null>): number {
  const [height, setHeight] = useState(0);

  useLayoutEffect(() => {
    const spacer = spacerRef.current;
    if (!lastId || !spacer) {
      setHeight(0);
      return;
    }
    const root = scrollContainerOf(spacer);

    const measure = () => {
      const last = document.getElementById(lastId);
      if (!last) return;
      const scroller = root ?? document.scrollingElement ?? document.documentElement;
      const viewportHeight = root ? root.clientHeight : window.innerHeight;
      const rootTop = root ? root.getBoundingClientRect().top : 0;
      setHeight(
        trailingSpacerHeight({
          viewportHeight,
          naturalScrollHeight: scroller.scrollHeight - spacer.offsetHeight,
          lastTop: last.getBoundingClientRect().top - rootTop + scroller.scrollTop,
        }),
      );
    };

    measure();
    // The result excludes the spacer's own height, so the re-measure its
    // resize triggers settles immediately.
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    ro?.observe(spacer.parentElement ?? spacer);
    if (root) ro?.observe(root);
    window.addEventListener("resize", measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [lastId, spacerRef]);

  return height;
}
