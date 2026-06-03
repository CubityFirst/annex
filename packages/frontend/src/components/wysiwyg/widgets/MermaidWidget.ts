import { createElement, type ReactElement } from "react";
import { WidgetType, type EditorView } from "@codemirror/view";
import { ReactWidget } from "./ReactWidget";
import { MermaidDiagram } from "@/components/MermaidDiagram";

// ```mermaid blocks render an async, interactive SVG via a heavy lazily-loaded
// library, so unlike plain highlighted code (see CodeFenceWidget) they keep a
// React root.
export class MermaidWidget extends ReactWidget {
  protected tag: "div" = "div";

  constructor(private readonly code: string) {
    super();
  }

  toDOM(view: EditorView): HTMLElement {
    const el = super.toDOM(view);
    el.classList.add("cm-codefence-widget-root");
    return el;
  }

  protected render(): ReactElement {
    return createElement(MermaidDiagram, { code: this.code });
  }

  protected revealOnClick(): boolean {
    return true;
  }

  eq(other: WidgetType): boolean {
    return other instanceof MermaidWidget && other.code === this.code;
  }
}
