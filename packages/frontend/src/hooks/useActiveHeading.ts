import { useEffect, useState } from "react";
import { EditorView } from "@codemirror/view";
import { findHeadingLine } from "@/lib/headingSlug";

/**
 * Tracks which heading the reader is currently in, for the outline's
 * "you are here" marker. Like useScrollToHeading it measures heading *lines*
 * through CodeMirror's height map (headings far off-screen aren't in the DOM),
 * listening to scroll on whatever container scrolls the reading view.
 */
export function useActiveHeading(docContent: string | undefined, ids: string[]): string | null {
  const [active, setActive] = useState<string | null>(null);
  const idsKey = ids.join("|");

  useEffect(() => {
    if (!docContent || ids.length === 0) {
      setActive(null);
      return;
    }
    const lines = ids.map(id => ({ id, line: findHeadingLine(docContent, id) })).filter(h => h.line > 0);
    let frame = 0;

    const measure = () => {
      frame = 0;
      const cm = document.querySelector(".cm-wysiwyg--reading .cm-editor") as HTMLElement | null;
      const view = cm ? EditorView.findFromDOM(cm) : null;
      if (!view) return;
      const contentTop = view.contentDOM.getBoundingClientRect().top;
      // A heading counts as "current" once it scrolls within ~25% of the
      // viewport from the top, so the marker moves as a section starts.
      const threshold = Math.max(96, window.innerHeight * 0.25);
      let current: string | null = lines[0]?.id ?? null;
      for (const h of lines) {
        if (h.line > view.state.doc.lines) continue;
        const top = contentTop + view.lineBlockAt(view.state.doc.line(h.line).from).top;
        if (top <= threshold) current = h.id;
        else break;
      }
      setActive(current);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };

    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    window.addEventListener("resize", onScroll);
    const t = setTimeout(measure, 150);
    return () => {
      document.removeEventListener("scroll", onScroll, { capture: true });
      window.removeEventListener("resize", onScroll);
      clearTimeout(t);
      if (frame) cancelAnimationFrame(frame);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docContent, idsKey]);

  return active;
}
