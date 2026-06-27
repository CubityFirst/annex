import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Pure active-section picker: given the ordered list of section ids and a map
 * of each id's current intersection ratio, return the topmost (first in DOM
 * order) section that is intersecting, or null if none are. Extracted so the
 * derivation is unit-testable without a live IntersectionObserver.
 */
export function pickActiveSection(orderedIds: string[], ratios: Map<string, number>): string | null {
  for (const id of orderedIds) {
    if ((ratios.get(id) ?? 0) > 0) return id;
  }
  return null;
}

/**
 * Finds the real scroll container for a settings section. Both settings pages
 * render inside DocsLayout's `<div className="flex-1 overflow-y-auto …">`
 * (DocsLayout.tsx) - the page roots themselves have no overflow, so window/
 * document never scrolls. We observe and scroll that ancestor.
 */
function scrollContainerOf(el: HTMLElement): HTMLElement | null {
  return el.closest<HTMLElement>(".overflow-y-auto");
}

export interface ScrollSpy {
  /** The id of the section currently considered active (topmost visible). */
  active: string | null;
  /** Smooth-scroll the section into view and mark it active immediately. */
  scrollTo: (id: string) => void;
}

/**
 * Scroll-spy over a fixed, ordered set of section ids.
 *
 * - Uses one IntersectionObserver rooted on the shared DocsLayout scroller, so
 *   it is robust to variable section heights and conditionally-rendered /
 *   role-gated sections with no per-frame measurement.
 * - `rootMargin` biases the active band to the upper third so the heading you
 *   scrolled to becomes active rather than the one leaving the top.
 * - `scrollTo` sets the target active up front and suppresses observer updates
 *   for a short window so the smooth-scroll animation passing through
 *   intermediate sections doesn't make the outline flicker.
 *
 * The observer is re-initialised whenever the visible id set changes (keyed on
 * the joined ids), which is what makes gated sections appear/disappear cleanly.
 */
export function useScrollSpy(orderedIds: string[]): ScrollSpy {
  const [active, setActive] = useState<string | null>(orderedIds[0] ?? null);
  const ignoreUntilRef = useRef(0);
  const ratiosRef = useRef<Map<string, number>>(new Map());
  const key = orderedIds.join("|");

  useEffect(() => {
    const ids = key ? key.split("|") : [];
    // Seed to the first present section so the first group renders expanded on
    // mount (avoids an all-collapsed flash before the first observer callback),
    // while preserving a still-valid prior selection across re-inits.
    setActive(prev => (prev && ids.includes(prev) ? prev : (ids[0] ?? null)));

    if (typeof IntersectionObserver === "undefined") return;
    const els = ids
      .map(id => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);
    if (els.length === 0) return;

    const ratios = ratiosRef.current;
    const root = scrollContainerOf(els[0]);
    const observer = new IntersectionObserver(
      entries => {
        for (const entry of entries) {
          ratios.set(entry.target.id, entry.isIntersecting ? entry.intersectionRatio : 0);
        }
        if (performance.now() < ignoreUntilRef.current) return;
        // When scrolled to the bottom, a short trailing section (e.g. Danger
        // Zone) sits below the upper-third active band and can never be the
        // topmost intersecting section - pin it so its link highlights and its
        // group stays expanded. Only when the container actually overflows, so
        // a non-scrolling page still resolves to its first section.
        if (root) {
          const maxScroll = root.scrollHeight - root.clientHeight;
          if (maxScroll > 4 && root.scrollTop >= maxScroll - 4) {
            setActive(ids[ids.length - 1]);
            return;
          }
        }
        const next = pickActiveSection(ids, ratios);
        if (next) setActive(next);
      },
      { root, rootMargin: "0px 0px -65% 0px", threshold: [0, 0.1, 0.5, 1] },
    );
    els.forEach(el => observer.observe(el));
    return () => observer.disconnect();
  }, [key]);

  const scrollTo = useCallback((id: string) => {
    const el = document.getElementById(id);
    if (!el) return;
    // Optimistically mark active so the owning group expands instantly, and
    // suppress observer-driven updates while the smooth scroll settles.
    setActive(id);
    ignoreUntilRef.current = performance.now() + 600;
    const container = scrollContainerOf(el);
    if (container) {
      const offset = el.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
      const maxScroll = container.scrollHeight - container.clientHeight;
      container.scrollTo({ top: Math.max(0, Math.min(offset, maxScroll)), behavior: "smooth" });
    } else {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, []);

  return { active, scrollTo };
}
