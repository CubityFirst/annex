import { createElement, type ReactElement } from "react";
import { WidgetType } from "@codemirror/view";
import { ReactWidget } from "./ReactWidget";
import { parseTable, renderInline } from "./tableModel";

function TableInner({ source }: { source: string }) {
  const { headers, rows, aligns } = parseTable(source);

  if (headers.length === 0) {
    return createElement("div", { className: "cm-wysiwyg-table-empty" }, source);
  }

  return createElement(
    "table",
    { className: "cm-wysiwyg-table" },
    createElement(
      "thead",
      null,
      createElement(
        "tr",
        null,
        ...headers.map((h, i) =>
          createElement(
            "th",
            { key: i, style: aligns[i] ? { textAlign: aligns[i]! } : undefined },
            renderInline(h),
          ),
        ),
      ),
    ),
    createElement(
      "tbody",
      null,
      ...rows.map((row, ri) =>
        createElement(
          "tr",
          { key: ri },
          ...row.map((cell, ci) =>
            createElement(
              "td",
              { key: ci, style: aligns[ci] ? { textAlign: aligns[ci]! } : undefined },
              renderInline(cell),
            ),
          ),
        ),
      ),
    ),
  );
}

export class TableWidget extends ReactWidget {
  protected tag: "div" = "div";

  constructor(private readonly source: string) {
    super();
  }

  protected rootClass(): string {
    return "cm-table-widget-root";
  }

  protected render(): ReactElement {
    return createElement(TableInner, { source: this.source });
  }

  protected revealOnClick(): boolean {
    return true;
  }

  // Rough per-row estimate (cell padding + border) so reading-mode scrolling
  // doesn't jump when tables materialize.
  get estimatedHeight(): number {
    const lines = this.source.split("\n").filter(l => l.trim().length > 0).length;
    // header + body rows (delimiter line renders as nothing)
    return Math.max(1, lines - 1) * 37 + 8;
  }

  eq(other: WidgetType): boolean {
    return other instanceof TableWidget && other.source === this.source;
  }
}
