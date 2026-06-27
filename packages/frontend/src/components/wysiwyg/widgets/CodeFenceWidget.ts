import { WidgetType, type EditorView } from "@codemirror/view";
import { getHighlighter, highlighterReady } from "@/lib/shiki";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// Plain-DOM fenced-code widget.
//
// A highlighted code block is static HTML plus a copy button - it needs no
// React. Earlier this mounted a React root per block (ReactWidget → <CodeBlock>);
// for a code-heavy doc that's one React reconciler root per visible block. This
// renders straight to the DOM instead, so loading a page with many code blocks
// costs only Shiki tokenisation + an innerHTML assignment per block.
//
// Mermaid blocks still need React (async render, heavy lazy lib) and go through
// MermaidWidget instead - see decorations/block/codeFence.ts.

const THEME = "github-dark-dimmed";

// Lucide Copy/Check, inlined so the button needs no React. Classes match
// lucide-react's output (`<Copy className="h-3.5 w-3.5" />`) exactly.
const COPY_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-copy h-3.5 w-3.5" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
const CHECK_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-check h-3.5 w-3.5" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

// Built from the same shadcn variants the React Button used, so the class
// string stays identical to (and in sync with) `<Button size="icon" variant="ghost" …>`.
const COPY_BTN_CLASS = cn(
  buttonVariants({ variant: "ghost", size: "icon" }),
  "pdf-print-hide absolute top-2 right-2 h-7 w-7 text-zinc-400 hover:text-zinc-100 hover:bg-white/10",
);

function highlightHtml(code: string, lang: string): string | null {
  const h = getHighlighter();
  if (!h) return null;
  try {
    return h.codeToHtml(code, { lang, theme: THEME });
  } catch {
    // Unknown language - fall back to plain text.
    return h.codeToHtml(code, { lang: "text", theme: THEME });
  }
}

export class CodeFenceWidget extends WidgetType {
  private destroyed = false;

  constructor(
    private readonly lang: string,
    private readonly code: string,
  ) {
    super();
  }

  eq(other: WidgetType): boolean {
    return other instanceof CodeFenceWidget && other.lang === this.lang && other.code === this.code;
  }

  toDOM(view: EditorView): HTMLElement {
    // Tagged so CSS can neutralise the inner my-4 (the margin lives outside the
    // bounding rect, which would make CM6's heightmap underestimate the widget's
    // height and mis-route clicks below it).
    const root = document.createElement("div");
    root.className = "cm-codefence-widget-root";

    const outer = document.createElement("div");
    root.appendChild(outer);
    this.paint(outer);

    // If Shiki wasn't ready on first paint, swap in the highlighted output once
    // it is - in place, no remount. (After the JS-engine init this window is
    // tiny.)
    if (getHighlighter() === null) {
      highlighterReady.then(() => {
        if (this.destroyed || !outer.isConnected) return;
        this.paint(outer);
      });
    }

    // Reveal-on-click: move the cursor inside the block's range so the
    // editing-mode visitor swaps in the raw markdown. Read-only/no-op in reading
    // mode. Mirrors ReactWidget's revealOnClick handler exactly.
    root.addEventListener("pointerdown", (event) => {
      const pe = event as PointerEvent;
      if (pe.button !== 0 && pe.button !== undefined) return;
      const pos = view.posAtDOM(root);
      event.preventDefault();
      view.dispatch({ selection: { anchor: pos } });
      view.focus();
    });

    return root;
  }

  // (Re)builds the inner content for the current highlighter state. Mirrors the
  // DOM the React ShikiCodeBlock produced so styles.css rules still apply.
  private paint(outer: HTMLElement): void {
    const html = highlightHtml(this.code, this.lang);
    outer.replaceChildren();

    if (html !== null) {
      outer.className = "not-prose relative my-4 rounded-md text-sm [&>pre]:overflow-x-auto [&>pre]:p-4";
      const host = document.createElement("div");
      // Shiki escapes all user code content - safe to assign as HTML.
      host.innerHTML = html;
      outer.appendChild(host);
    } else {
      // Plain fallback shown only before Shiki is ready on the very first load.
      outer.className = "not-prose relative my-4";
      const pre = document.createElement("pre");
      pre.className = "overflow-x-auto rounded-md bg-[#22272e] p-4 text-sm text-[#adbac7]";
      const codeEl = document.createElement("code");
      codeEl.textContent = this.code;
      pre.appendChild(codeEl);
      outer.appendChild(pre);
    }

    outer.appendChild(this.buildCopyButton());
  }

  private buildCopyButton(): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = COPY_BTN_CLASS;
    btn.setAttribute("aria-label", "Copy code");
    btn.innerHTML = COPY_ICON;
    btn.addEventListener("click", () => {
      navigator.clipboard.writeText(this.code).then(() => {
        btn.innerHTML = CHECK_ICON;
        setTimeout(() => {
          if (!this.destroyed) btn.innerHTML = COPY_ICON;
        }, 2000);
      }).catch(() => { /* clipboard unavailable */ });
    });
    return btn;
  }

  ignoreEvent(event: Event): boolean {
    // Let CM process mousedown/click so cursor placement (reveal) fires; ignore
    // everything else. Matches ReactWidget for a revealOnClick block widget.
    return !(event.type === "mousedown" || event.type === "click");
  }

  destroy(): void {
    this.destroyed = true;
  }
}
