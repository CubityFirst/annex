import { WidgetType, type EditorView } from "@codemirror/view";
import { rendererCtxFacet } from "../context/RendererContext";

export class HrWidget extends WidgetType {
  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-wysiwyg-hr";
    const hr = document.createElement("hr");
    wrap.appendChild(hr);
    // Explicit cursor placement on click, same as ReactWidget's revealOnClick
    // handler: CM's default click-to-position is unreliable for block widgets
    // (posAtCoords can resolve just outside the replaced range), which left HR
    // as the one block widget you couldn't reliably click to reveal.
    wrap.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      // Reading mode has nothing to reveal.
      if (view.state.facet(rendererCtxFacet).revealOnCursor === false) return;
      const pos = view.posAtDOM(wrap);
      event.preventDefault();
      view.dispatch({ selection: { anchor: pos } });
      view.focus();
    });
    return wrap;
  }

  eq(other: WidgetType): boolean {
    return other instanceof HrWidget;
  }

  // 0.75em top+bottom padding (16px base) + the 1px rule.
  get estimatedHeight(): number {
    return 25;
  }

  ignoreEvent(event: Event): boolean {
    if (event.type === "mousedown" || event.type === "click") return false;
    return true;
  }
}
