import { WidgetType, type EditorView } from "@codemirror/view";
import { createRoot, type Root } from "react-dom/client";
import { createElement, useSyncExternalStore, type ReactElement, type ReactNode } from "react";
import {
  RendererReactContext,
  rendererCtxFacet,
  getRendererCtxStore,
  type RendererCtxStore,
} from "../context/RendererContext";

// React roots keyed by the DOM element they were mounted on - NOT stored on
// the widget instance. CodeMirror freely re-tags a reused tile's DOM onto a
// different (eq()-equal or updateDOM-adopted) widget instance, and then calls
// destroy()/updateDOM() on whichever instance currently owns the tile. An
// instance field would be null on that new instance, so unmount / effect
// cleanup would never run (leaked blob URLs, rAF loops, ResizeObservers, ...).
// Keying by element makes destroy(dom)/updateDOM(dom) find the root no matter
// which instance CM calls them on.
const roots = new WeakMap<HTMLElement, Root>();

// Subscribes the widget subtree to the per-view ctx store so mounted widgets
// pick up ctx changes (docs list loading, sparkle prefs, ...) even when their
// DOM is reused and never re-rendered by CodeMirror.
function LiveCtxProvider({ store, children }: { store: RendererCtxStore; children?: ReactNode }) {
  const ctx = useSyncExternalStore(store.subscribe, store.get, store.get);
  return createElement(RendererReactContext.Provider, { value: ctx }, children);
}

export abstract class ReactWidget extends WidgetType {
  protected tag: "span" | "div" = "div";

  protected abstract render(): ReactElement;

  /**
   * Extra class name(s) for the widget's root element, applied in toDOM.
   * Subclasses that only need a root class override this instead of toDOM.
   */
  protected rootClass(): string | null {
    return null;
  }

  /**
   * Block widgets (code fence, image, callout, frontmatter, hr) override this to true.
   * When true, mousedown/click events fall through to CodeMirror so the cursor moves
   * into the widget's range, which causes the cursor-touches-block reveal to kick in.
   * Interactive widgets (dice, wikilinks) keep this false - their React handlers
   * own the click behavior.
   */
  protected revealOnClick(): boolean {
    return false;
  }

  private renderInto(root: Root, view: EditorView): void {
    root.render(
      createElement(LiveCtxProvider, { store: getRendererCtxStore(view) }, this.render()),
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement(this.tag);
    const cls = this.rootClass();
    if (cls) el.className = cls;
    const root = createRoot(el);
    roots.set(el, root);
    this.renderInto(root, view);
    // Explicit cursor placement on click. Relying on CM6's default click
    // handling is unreliable for `<img>` inside contenteditable (browsers
    // treat the click as image-selection, not cursor placement) and for
    // `block: true` widgets where posAtCoords can resolve to a position just
    // outside the replaced range. We force the cursor inside the widget range
    // so the visitor's cursor-touches check fires and reveals the markdown.
    if (this.revealOnClick()) {
      // pointerdown (not mousedown) so taps on mobile/touch also reveal -
      // pointer events fire for mouse, touch, and pen and arrive before any
      // synthesized mouse events.
      el.addEventListener("pointerdown", (event) => {
        const pe = event as PointerEvent;
        if (pe.button !== 0) return;
        // Interactive children (buttons, links) own their pointer events -
        // preventDefault here would eat the coming click.
        const target = pe.target as HTMLElement | null;
        if (target && target.closest("button, a")) return;
        // Reading mode has nothing to reveal; bail so native text selection
        // inside the rendered block keeps working. Read live at event time -
        // the widget DOM can outlive a mode change.
        if (view.state.facet(rendererCtxFacet).revealOnCursor === false) return;
        const pos = view.posAtDOM(el);
        event.preventDefault();
        view.dispatch({ selection: { anchor: pos } });
        view.focus();
      });
    }
    return el;
  }

  updateDOM(dom: HTMLElement, view: EditorView, prev?: WidgetType): boolean {
    const root = roots.get(dom);
    if (!root) return false;
    // Only adopt DOM this class family created with a compatible shape. The
    // tag can differ between instances of one class (inline vs block image),
    // and the pointerdown listener bound in toDOM captured the ORIGINAL
    // instance's revealOnClick - decline the update when either differs so CM
    // redraws instead.
    if (dom.nodeName.toLowerCase() !== this.tag) return false;
    if (prev instanceof ReactWidget && prev.revealOnClick() !== this.revealOnClick()) return false;
    this.renderInto(root, view);
    return true;
  }

  destroy(dom: HTMLElement): void {
    const root = roots.get(dom);
    if (!root) return;
    roots.delete(dom);
    queueMicrotask(() => { try { root.unmount(); } catch { /* */ } });
  }

  ignoreEvent(event: Event): boolean {
    if (this.revealOnClick() && (event.type === "mousedown" || event.type === "click")) {
      // Interactive children own their events - if CM processed this
      // mousedown it would move the cursor, reveal the raw markdown, and
      // destroy the child before its click lands.
      const target = event.target as HTMLElement | null;
      if (target && target.closest("button, a")) return true;
      return false;
    }
    return true;
  }
}
