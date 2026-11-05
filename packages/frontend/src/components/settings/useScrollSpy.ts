import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Fraction of the scroll viewport (from its top) that acts as the "reading
 * line": the active section is the last one whose top has scrolled above it.
 */
export const ACTIVE_LINE_RATIO = 0.35;

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

/**
 * Pure active-section picker over measured geometry. Returns the last section
 * (in the supplied order) whose top has crossed the reading line, or the first
 * present section when none has.
 *
 * Short trailing sections (Sessions, Danger zone) can never reach a fixed
 * line near the top of the viewport because the container runs out of
 * scroll first. To keep them reachable the line sweeps down to the bottom of
 * the viewport across the final stretch of scroll, so each trailing section
 * activates in order, and once the container is clamped at the bottom the
 * last section is always active. A container that doesn't scroll at all keeps
 * the fixed line, so it resolves to its first section.
 */
export function pickActiveSection(orderedIds: string[], geometry: SpyGeometry): string | null {
  const present = orderedIds.filter(id => geometry.tops.has(id));
  if (present.length === 0) return null;

  const { viewportHeight, maxScroll, scrollTop } = geometry;
  const scrolls = maxScroll > BOTTOM_EPSILON;
  const remaining = Math.max(0, maxScroll - scrollTop);
  if (scrolls && remaining <= BOTTOM_EPSILON) return present[present.length - 1];

  const baseLine = viewportHeight * ACTIVE_LINE_RATIO;
  const sweepZone = viewportHeight - baseLine;
  const line = scrolls && remaining < sweepZone ? baseLine + (sweepZone - remaining) : baseLine;

  let current = present[0];
  for (const id of present) {
    if ((geometry.tops.get(id) ?? Infinity) <= line) current = id;
    else break;
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
 * - The reading line sits in the upper third so the heading you scrolled to
 *   becomes active rather than the one leaving the top, and sweeps down near
 *   the end so short final sections still highlight (see pickActiveSection).
 * - `scrollTo` sets the target active up front and suppresses scroll updates
 *   for a short window so the smooth-scroll animation passing through
 *   intermediate sections doesn't make the outline flicker.
 *
 * The listener is re-initialised whenever the visible id set changes (keyed on
 * the joined ids), which is what makes gated sections appear/disappear cleanly.
 */
export function useScrollSpy(orderedIds: string[]): ScrollSpy {
  const [active, setActive] = useState<string | null>(orderedIds[0] ?? null);
  const ignoreUntilRef = useRef(0);
  const ignoreCapRef = useRef(0);
  const key = orderedIds.join("|");

  useEffect(() => {
    const ids = key ? key.split("|") : [];
    // Seed to the first present section so the first group renders expanded on
    // mount (avoids an all-collapsed flash before the first measurement),
    // while preserving a still-valid prior selection across re-inits.
    setActive(prev => (prev && ids.includes(prev) ? prev : (ids[0] ?? null)));

    const first = ids.map(id => document.getElementById(id)).find((el): el is HTMLElement => el !== null);
    if (!first) return;
    const root = scrollContainerOf(first);
    const target: HTMLElement | Window = root ?? window;

    const measure = () => {
      if (performance.now() < ignoreUntilRef.current) return;
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
    const onScroll = () => {
      // While a programmatic smooth scroll is still moving, keep extending the
      // quiet window (up to a hard cap) so a long animation that outlasts the
      // initial window can't re-pick a neighbour of the clicked section.
      const now = performance.now();
      if (now < ignoreUntilRef.current) {
        ignoreUntilRef.current = Math.min(ignoreCapRef.current, Math.max(ignoreUntilRef.current, now + 150));
        return;
      }
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };

    measure();
    target.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      target.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [key]);

  const scrollTo = useCallback((id: string) => {
    const el = document.getElementById(id);
    if (!el) return;
    // Optimistically mark active so the owning group expands instantly, and
    // suppress scroll-driven updates while the smooth scroll settles.
    setActive(id);
    const now = performance.now();
    ignoreUntilRef.current = now + 500;
    ignoreCapRef.current = now + 2000;
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
