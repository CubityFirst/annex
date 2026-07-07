import { WidgetType, type EditorView } from "@codemirror/view";
import { rendererCtxFacet } from "../context/RendererContext";

export class TaskCheckboxWidget extends WidgetType {
  constructor(private readonly checked: boolean) {
    super();
  }

  toDOM(view: EditorView): HTMLElement {
    const ctx = view.state.facet(rendererCtxFacet);
    const editable = ctx.revealOnCursor !== false;

    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = "cm-task-checkbox";
    input.checked = this.checked;
    input.disabled = !editable;

    // Accessible name from the task's own text. The widget is created before
    // it's attached (posAtDOM needs a connected node), so resolve on a
    // microtask - CM inserts the tile synchronously within this update - and
    // refresh on focus so the label tracks later edits to the task text.
    input.setAttribute("aria-label", "Task");
    const applyLabel = () => {
      if (!input.isConnected) return;
      try {
        const pos = view.posAtDOM(input);
        const line = view.state.doc.lineAt(pos);
        const src = view.state.doc.sliceString(line.from, line.to);
        const m = src.match(/\[[ xX]\]\s*(.*)$/);
        const text = m?.[1]?.trim();
        if (text) input.setAttribute("aria-label", text);
      } catch { /* keep the generic label */ }
    };
    queueMicrotask(applyLabel);
    input.addEventListener("focus", applyLabel);

    if (editable) {
      input.addEventListener("mousedown", (e) => e.stopPropagation());
      input.addEventListener("change", (e) => {
        e.stopPropagation();
        // Resolve the widget's current position and find the actual
        // `[x]` / `[ ]` characters on that line (positions may have shifted).
        const pos = view.posAtDOM(input);
        const line = view.state.doc.lineAt(pos);
        const src = view.state.doc.sliceString(line.from, line.to);
        const match = src.match(/\[[ xX]\]/);
        if (!match || match.index === undefined) return;
        const from = line.from + match.index;
        const next = this.checked ? "[ ]" : "[x]";
        view.dispatch({
          changes: { from, to: from + 3, insert: next },
          userEvent: "input.toggle-task",
        });
      });
    }

    return input;
  }

  eq(other: WidgetType): boolean {
    return other instanceof TaskCheckboxWidget && other.checked === this.checked;
  }

  ignoreEvent(): boolean {
    return true;
  }
}
