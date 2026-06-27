import { createElement, type ReactElement } from "react";
import { WidgetType } from "@codemirror/view";
import { ReactWidget } from "./ReactWidget";
import { FileText } from "lucide-react";

interface Props {
  source: string;
}

interface Entry {
  key: string;
  val: string;
}

// Generic top-level YAML key/value extractor - shows whatever the user wrote
// rather than restricting to the strict app-metadata keys handled by
// lib/frontmatter.ts (which is intentionally narrow for app behavior).
function parseEntries(source: string): Entry[] {
  const entries: Entry[] = [];
  const lines = source.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const m = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1]!;
    let val = (m[2] ?? "").trim();

    if (val === "") {
      // YAML list: collect indented "- item" lines until indentation breaks
      const items: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const itemMatch = lines[j]!.match(/^\s+-\s+(.+)$/);
        if (!itemMatch) break;
        items.push(itemMatch[1]!.trim().replace(/^['"]|['"]$/g, ""));
        j++;
      }
      if (items.length > 0) {
        val = items.join(", ");
        i = j - 1;
      }
    } else {
      // strip flow-style list brackets and quotes
      if (val.startsWith("[") && val.endsWith("]")) {
        val = val.slice(1, -1).split(",")
          .map(t => t.trim().replace(/^['"]|['"]$/g, ""))
          .filter(Boolean)
          .join(", ");
      } else {
        val = val.replace(/^['"]|['"]$/g, "");
      }
    }

    entries.push({ key, val });
  }

  return entries;
}

function FrontmatterInner({ source }: Props) {
  const entries = parseEntries(source);

  return createElement(
    "div",
    { className: "cm-frontmatter-card" },
    createElement(
      "div",
      { className: "cm-frontmatter-card__header" },
      createElement(FileText, { className: "cm-frontmatter-card__icon", "aria-hidden": true } as React.SVGProps<SVGSVGElement>),
      createElement("span", { className: "cm-frontmatter-card__label" }, "Frontmatter"),
    ),
    entries.length === 0
      ? createElement("p", { className: "cm-frontmatter-card__empty" }, "(empty)")
      : createElement(
          "dl",
          { className: "cm-frontmatter-card__list" },
          ...entries.flatMap((e) => [
            createElement("dt", { key: `k-${e.key}`, className: "cm-frontmatter-card__key" }, e.key),
            createElement("dd", { key: `v-${e.key}`, className: "cm-frontmatter-card__val" }, e.val || createElement("span", { className: "cm-frontmatter-card__empty-val" }, "-")),
          ]),
        ),
  );
}

export class FrontmatterWidget extends ReactWidget {
  protected tag: "div" = "div";

  constructor(private readonly source: string) {
    super();
  }

  protected render(): ReactElement {
    return createElement(FrontmatterInner, { source: this.source });
  }

  protected revealOnClick(): boolean {
    return true;
  }

  eq(other: WidgetType): boolean {
    return other instanceof FrontmatterWidget && other.source === this.source;
  }
}
