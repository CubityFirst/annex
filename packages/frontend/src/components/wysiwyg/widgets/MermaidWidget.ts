import { createElement, type ReactElement } from "react";
import { WidgetType } from "@codemirror/view";
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

  protected rootClass(): string {
    return "cm-codefence-widget-root";
  }

  protected render(): ReactElement {
    return createElement(MermaidDiagram, { code: this.code });
  }

  protected revealOnClick(): boolean {
    return true;
  }

  // Diagram size is unknowable pre-render; a mid-size guess still beats CM's
  // default single-line assumption for reading-mode scroll stability.
  get estimatedHeight(): number {
    return 220;
  }

  eq(other: WidgetType): boolean {
    return other instanceof MermaidWidget && other.code === this.code;
  }
}
