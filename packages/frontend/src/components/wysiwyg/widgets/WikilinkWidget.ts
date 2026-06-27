import { createElement, type ReactElement, type MouseEvent as ReactMouseEvent } from "react";
import { WidgetType } from "@codemirror/view";
import { ReactWidget } from "./ReactWidget";
import { resolveDoc } from "@/components/DocLink";
import { useRendererCtx } from "../context/RendererContext";

interface ParsedWikilink {
  title: string;
  anchor?: string;
  display: string;
}

export function parseWikilink(raw: string): ParsedWikilink | null {
  const m = raw.match(/^([^#|]+?)(?:#([^|]+?))?(?:\|(.+))?$/);
  if (!m) return null;
  const title = m[1]!.trim();
  const anchor = m[2]?.trim();
  const display = (m[3]?.trim()) || (anchor ? `${title}#${anchor}` : title);
  return { title, anchor, display };
}

// SPA-style navigation that doesn't rely on React Router context (which is
// unavailable inside a CM6 widget's separate React root).
function navigateSpa(href: string) {
  window.history.pushState(null, "", href);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function WikilinkInner({ title, anchor, display }: ParsedWikilink) {
  const ctx = useRendererCtx();
  const docs = ctx.docs ?? [];
  const folders = ctx.folders ?? [];
  const buildUrl = ctx.buildUrl;

  const match = resolveDoc(title, docs, folders);

  if (!match || !buildUrl) {
    return createElement(
      "span",
      {
        className: "cm-wikilink-broken",
        title: `Document not found: "${title}"`,
      },
      display,
    );
  }

  const href = buildUrl(match.id, anchor);
  return createElement(
    "a",
    {
      href,
      className: "cm-link",
      onClick: (e: ReactMouseEvent) => {
        // Modifier or non-left-click → let the browser handle (open in new tab/window)
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        navigateSpa(href);
      },
    },
    display,
  );
}

export class WikilinkWidget extends ReactWidget {
  protected tag: "span" = "span";

  constructor(private readonly parsed: ParsedWikilink) {
    super();
  }

  protected render(): ReactElement {
    return createElement(WikilinkInner, this.parsed);
  }

  // Interactive - let the <a>'s onClick handle navigation.
  protected revealOnClick(): boolean {
    return false;
  }

  eq(other: WidgetType): boolean {
    return (
      other instanceof WikilinkWidget &&
      other.parsed.title === this.parsed.title &&
      other.parsed.anchor === this.parsed.anchor &&
      other.parsed.display === this.parsed.display
    );
  }
}
