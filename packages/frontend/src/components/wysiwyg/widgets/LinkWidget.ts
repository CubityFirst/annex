import { createElement, type ReactElement } from "react";
import { WidgetType } from "@codemirror/view";
import { ReactWidget } from "./ReactWidget";
import { navigateSpa } from "./WikilinkWidget";

interface Props {
  text: string;
  href: string;
}

// Only absolute (scheme'd or protocol-relative) URLs leave the app in a new
// tab; relative/internal links (`/doc`, `./sibling`) navigate in place like
// any in-app link, and `#heading` keeps the browser's native scroll-to-anchor.
export function isExternalHref(href: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href);
}

function LinkInner({ text, href }: Props) {
  const external = isExternalHref(href);
  return createElement(
    "a",
    {
      href,
      ...(external ? { target: "_blank", rel: "noopener noreferrer" } : {}),
      className: "cm-link",
      onClick: (e: React.MouseEvent) => {
        // Don't let the click bubble into the editor and move the cursor.
        e.stopPropagation();
        // External links open a new tab; hash links use the browser's native
        // anchor scroll; modifier/middle clicks keep their browser meaning.
        if (external || href.startsWith("#")) return;
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        // Internal path - navigate the SPA in place (same convention as
        // wikilinks) instead of a full page load.
        e.preventDefault();
        navigateSpa(href);
      },
    },
    text,
  );
}

export class LinkWidget extends ReactWidget {
  protected tag: "span" = "span";

  constructor(private readonly props: Props) {
    super();
  }

  protected render(): ReactElement {
    return createElement(LinkInner, this.props);
  }

  // Interactive - let the <a> handle the click for navigation.
  protected revealOnClick(): boolean {
    return false;
  }

  eq(other: WidgetType): boolean {
    return (
      other instanceof LinkWidget &&
      other.props.text === this.props.text &&
      other.props.href === this.props.href
    );
  }
}
