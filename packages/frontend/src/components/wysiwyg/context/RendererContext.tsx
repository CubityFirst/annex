import { createContext, useContext } from "react";
import { Facet } from "@codemirror/state";
import { ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view";

export interface DocInfo {
  id: string;
  title: string;
  display_title?: string | null;
  folder_id?: string | null;
}

export interface FolderInfo {
  id: string;
  name: string;
  parent_id: string | null;
}

export interface RendererCtx {
  projectId?: string;
  isPublic: boolean;
  currentDocId?: string;
  hideFrontmatter?: boolean;
  /** When false, decorations are always applied (Reading mode). Default true (Editing mode). */
  revealOnCursor?: boolean;
  /** True when the *viewing* user is an Annex Ink supporter AND has the crit-sparkles preference enabled. Gates the sparkle burst on dice critical successes. */
  showInkCritSparkles?: boolean;
  docs?: DocInfo[];
  folders?: FolderInfo[];
  buildUrl?: (docId: string, anchor?: string) => string;
}

export const defaultRendererCtx: RendererCtx = {
  isPublic: false,
  revealOnCursor: true,
};

export const RendererReactContext = createContext<RendererCtx>(defaultRendererCtx);

export function useRendererCtx(): RendererCtx {
  return useContext(RendererReactContext);
}

// ---------------------------------------------------------------------------
// Live ctx delivery to mounted widget React roots.
//
// Widgets are rendered into detached React roots at toDOM() time. When the ctx
// facet value later changes (e.g. the docs list finishes loading), CodeMirror
// rebuilds the decorations - but rebuilt widgets that are eq()-equal to the
// mounted ones keep their existing DOM, so nothing re-renders the React roots
// and they'd keep a stale snapshot of the ctx forever ("Document not found"
// wikilinks). To fix that, each EditorView gets a small mutable store with a
// STABLE identity whose contents track the facet value; widget roots subscribe
// to it (via useSyncExternalStore in ReactWidget) instead of baking in a
// render-time snapshot.
//
// The store is kept in sync by a ViewPlugin that the facet itself enables, so
// any editor that provides rendererCtxFacet gets live updates with no extra
// wiring in the editor setup.
// ---------------------------------------------------------------------------

export interface RendererCtxStore {
  get: () => RendererCtx;
  subscribe: (cb: () => void) => () => void;
}

interface MutableCtxStore extends RendererCtxStore {
  set: (next: RendererCtx) => void;
}

function createCtxStore(initial: RendererCtx): MutableCtxStore {
  let value = initial;
  const subs = new Set<() => void>();
  return {
    get: () => value,
    subscribe: (cb) => {
      subs.add(cb);
      return () => {
        subs.delete(cb);
      };
    },
    set: (next) => {
      if (next === value) return;
      value = next;
      // Copy before iterating - a subscriber may unsubscribe during notify.
      for (const cb of [...subs]) cb();
    },
  };
}

const storeByView = new WeakMap<EditorView, MutableCtxStore>();

/**
 * The per-view ctx store. Stable object identity for the lifetime of the view;
 * `get()` always returns the current rendererCtxFacet value.
 */
export function getRendererCtxStore(view: EditorView): RendererCtxStore {
  let store = storeByView.get(view);
  if (!store) {
    store = createCtxStore(view.state.facet(rendererCtxFacet));
    storeByView.set(view, store);
  }
  return store;
}

// Enabled automatically wherever rendererCtxFacet is provided (see `enables`
// below). Pushes facet-value changes into the per-view store so mounted widget
// roots re-render with the new ctx even when their DOM is reused.
const ctxSyncPlugin = ViewPlugin.fromClass(
  class {
    constructor(view: EditorView) {
      // Ensure the store exists and reflects the current value (covers the
      // case where a widget created the store before this plugin ran).
      const existing = storeByView.get(view);
      if (existing) existing.set(view.state.facet(rendererCtxFacet));
      else getRendererCtxStore(view);
    }
    update(u: ViewUpdate) {
      const next = u.state.facet(rendererCtxFacet);
      if (next !== u.startState.facet(rendererCtxFacet)) {
        storeByView.get(u.view)?.set(next);
      }
    }
  },
);

export const rendererCtxFacet = Facet.define<RendererCtx, RendererCtx>({
  combine: values => values[0] ?? defaultRendererCtx,
  enables: ctxSyncPlugin,
});
