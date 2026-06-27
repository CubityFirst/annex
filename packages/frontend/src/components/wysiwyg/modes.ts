import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { decorationField } from "./decorations";
import { calloutFoldField } from "./decorations/calloutFold";
import { rendererCtxFacet, type RendererCtx } from "./context/RendererContext";

// Clicking at the visible end of inline markdown formatting (e.g. `**bold**`)
// lands the cursor between the visible inner text and the hidden trailing
// marker - so typing two trailing spaces lands them *inside* the formatting
// (`**bold  **`) instead of after it. After every click, if the cursor sits at
// the start of a contiguous chain of hidden inline markers, snap it past them.
function snapPastTrailingHiddenMarkers(view: EditorView) {
  const sel = view.state.selection.main;
  if (!sel.empty) return;
  const pos = sel.head;
  const line = view.state.doc.lineAt(pos);
  if (pos >= line.to) return;

  const decos = view.state.field(decorationField, false);
  if (!decos) return;

  let covered = pos;
  decos.between(pos, line.to, (from, to, deco) => {
    if (!(deco.spec as { atomicHide?: boolean }).atomicHide) return;
    if (from > covered) return;
    if (to > covered) covered = to;
  });

  if (covered > pos) {
    view.dispatch({ selection: { anchor: covered } });
  }
}

const fixClickAtTrailingHidden = EditorView.domEventHandlers({
  mouseup(_event, view) {
    queueMicrotask(() => snapPastTrailingHiddenMarkers(view));
  },
});

// In reading mode the editor flows inside the page (cm-scroller is height:auto,
// overflow:visible) and the surrounding ScrollArea owns scrolling. That setup
// breaks CodeMirror's viewport: without a real scroll container CM only renders
// a small slice of the doc, the cm-scroller collapses to that slice's height,
// the page's scrollbar disappears, and external scroll-to-line attempts can't
// reach virtualised content. This plugin uses CM's height map to enforce a
// minimum height on the scroller that matches the doc's true height, so CM's
// viewport spans the whole document and every line stays in the DOM. We iterate
// because each minHeight bump can cause CM to render more lines, which can
// extend the height further - we stop when the height stops growing.
const enforceFullHeightInReadingMode = ViewPlugin.fromClass(class {
  view: EditorView;
  applied = 0;
  pending = false;
  constructor(view: EditorView) {
    this.view = view;
    this.schedule();
  }
  update(_u: ViewUpdate) {
    this.schedule();
  }
  schedule() {
    if (this.pending) return;
    this.pending = true;
    this.view.requestMeasure({
      read: () => {
        const last = this.view.state.doc.length;
        return last === 0 ? 0 : this.view.lineBlockAt(last).bottom;
      },
      write: (total) => {
        this.pending = false;
        // Track CM's current best estimate of the doc's height so the scroller
        // never reports less than the height map says. Allowing shrink too
        // prevents stale empty space at the bottom once heading/line heights
        // have been measured and the estimate tightens.
        if (Math.abs(total - this.applied) > 0.5) {
          this.applied = total;
          this.view.scrollDOM.style.minHeight = `${Math.ceil(total)}px`;
          this.schedule();
        }
      },
    });
  }
});

export type WysiwygMode = "reading" | "editing" | "raw";

export const modeCompartment = new Compartment();
export const ctxCompartment = new Compartment();

export function ctxExtension(ctx: RendererCtx): Extension {
  return rendererCtxFacet.of(ctx);
}

export function modeExtension(mode: WysiwygMode): Extension {
  switch (mode) {
    case "reading":
      return [
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        calloutFoldField,
        decorationField,
        enforceFullHeightInReadingMode,
      ];
    case "editing":
      return [calloutFoldField, decorationField, fixClickAtTrailingHidden];
    case "raw":
      return [];
  }
}

export function buildCtxForMode(ctx: RendererCtx, mode: WysiwygMode): RendererCtx {
  return { ...ctx, revealOnCursor: mode === "editing" };
}
