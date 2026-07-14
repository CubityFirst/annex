import { useCallback, useEffect, useRef } from "react";
import { EditorView } from "@codemirror/view";
import { findHeadingLine } from "@/lib/headingSlug";

/**
 * Scroll-to-heading helper for the CodeMirror reading view, shared by the
 * public doc page and the authenticated DocPage (URL-hash effects and outline
 * buttons alike). Drives the scroll against the heading's *line position*
 * (parsed from the markdown source). That's crucial because:
 *   - CodeMirror virtualises its DOM - far-off-screen heading lines may not
 *     exist as elements, so `getElementById` would fail.
 *   - The Lezer markdown parser sometimes fails to tag a `## Heading` as an
 *     ATXHeading after long paragraphs, so even when the line is rendered
 *     it may lack the `id` attribute our decoration would normally set.
 *   - The scroll parent differs per page (a Radix ScrollArea viewport on the
 *     public page, a plain `overflow-y-auto` div in DocsLayout), so we walk
 *     up from the editor to find it and write scrollTop on it directly.
 *
 * After the initial scroll we watch the content with a ResizeObserver for
 * ~2.5s and re-scroll on layout shifts (images loading, etc.), backing off
 * as soon as the user scrolls on their own.
 *
 * Returns a `scrollToHash(hash)` callback; any in-flight attempt is cancelled
 * when a new one starts or on unmount.
 */
export function useScrollToHeading(docContent: string | undefined) {
  const scrollAttemptRef = useRef<{ cancel: () => void } | null>(null);

  const scrollToHash = useCallback((hash: string) => {
    scrollAttemptRef.current?.cancel();
    if (!hash || !docContent) return;

    const lineNum = findHeadingLine(docContent, hash);
    if (lineNum < 0) return;

    let cancelled = false;
    let observer: ResizeObserver | null = null;
    let stopTimer: ReturnType<typeof setTimeout> | null = null;

    function getView(): EditorView | null {
      const cmEditor = document.querySelector(".cm-wysiwyg--reading .cm-editor") as HTMLElement | null;
      return cmEditor ? EditorView.findFromDOM(cmEditor) : null;
    }

    // Nearest scrollable ancestor of the editor: the Radix ScrollArea
    // viewport on the public page, or any overflow-y auto/scroll container
    // (DocsLayout's main scroller) in the app view.
    function findScrollParent(view: EditorView): HTMLElement | null {
      for (let el = view.scrollDOM.parentElement; el; el = el.parentElement) {
        if (el.hasAttribute("data-radix-scroll-area-viewport")) return el;
        const overflowY = getComputedStyle(el).overflowY;
        if (overflowY === "auto" || overflowY === "scroll") return el;
      }
      return null;
    }

    // Compute the target scrollTop from CM's height map (`lineBlockAt`),
    // which works whether or not the line is currently rendered as DOM, then
    // write it directly on the scroll parent. We deliberately avoid CM's own
    // `scrollIntoView` effect - it competes with this manual write on the
    // next measure cycle and leaves the scroll position slightly off.
    function doScroll(): boolean {
      const view = getView();
      if (!view) return false;
      if (lineNum > view.state.doc.lines) return false;
      const pos = view.state.doc.line(lineNum).from;
      const viewport = findScrollParent(view);
      if (!viewport) {
        view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: "start" }) });
        return true;
      }
      const lineBlock = view.lineBlockAt(pos);
      const contentRect = view.contentDOM.getBoundingClientRect();
      const vpRect = viewport.getBoundingClientRect();
      const contentTopInScroll = contentRect.top - vpRect.top + viewport.scrollTop;
      const target = contentTopInScroll + lineBlock.top;
      const max = viewport.scrollHeight - viewport.clientHeight;
      viewport.scrollTop = Math.max(0, Math.min(max, target));
      return true;
    }

    let userScrollCleanup: (() => void) | null = null;
    function cancelAttempt() {
      cancelled = true;
      observer?.disconnect();
      observer = null;
      if (stopTimer) clearTimeout(stopTimer);
      userScrollCleanup?.();
      userScrollCleanup = null;
    }

    function startWatching() {
      const view = getView();
      if (!view) return;
      const viewport = findScrollParent(view);
      const watchTarget = viewport?.firstElementChild ?? viewport ?? view.scrollDOM;
      observer = new ResizeObserver(() => { doScroll(); });
      observer.observe(watchTarget);
      stopTimer = setTimeout(cancelAttempt, 2500);

      // Treat any user-initiated scroll input as a cancel - once the user
      // has reached for the wheel / touchpad / a key, our re-anchor should
      // back off so we don't yank them away from where they wanted to be.
      if (viewport) {
        const cancelOnUser = () => cancelAttempt();
        const onKey = (e: KeyboardEvent) => {
          if (
            e.key === "ArrowUp" || e.key === "ArrowDown" ||
            e.key === "PageUp" || e.key === "PageDown" ||
            e.key === "Home" || e.key === "End" || e.key === " "
          ) cancelAttempt();
        };
        viewport.addEventListener("wheel", cancelOnUser, { passive: true });
        viewport.addEventListener("touchstart", cancelOnUser, { passive: true });
        viewport.addEventListener("touchmove", cancelOnUser, { passive: true });
        window.addEventListener("keydown", onKey);
        userScrollCleanup = () => {
          viewport.removeEventListener("wheel", cancelOnUser);
          viewport.removeEventListener("touchstart", cancelOnUser);
          viewport.removeEventListener("touchmove", cancelOnUser);
          window.removeEventListener("keydown", onKey);
        };
      }
    }

    let attempts = 0;
    function tick() {
      if (cancelled) return;
      if (doScroll()) {
        startWatching();
        return;
      }
      if (++attempts < 120) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);

    scrollAttemptRef.current = { cancel: cancelAttempt };
  }, [docContent]);

  useEffect(() => () => scrollAttemptRef.current?.cancel(), []);

  return scrollToHash;
}
