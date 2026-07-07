import { createElement, type ReactElement, type MouseEvent as ReactMouseEvent } from "react";
import { WidgetType } from "@codemirror/view";
import { Link2 } from "lucide-react";
import { ReactWidget } from "./ReactWidget";
import { toast } from "@/hooks/use-toast";

function HeadingAnchorInner({ slug }: { slug: string }) {
  return createElement(
    "button",
    {
      type: "button",
      "aria-label": "Copy link to this heading",
      title: "Copy link to this heading",
      className: "cm-h-anchor",
      onClick: (e: ReactMouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        // Keep the query string - dropping it loses state like the dev
        // `?__site=` override, producing a link that opens the wrong site.
        const url = `${window.location.origin}${window.location.pathname}${window.location.search}#${slug}`;
        const ok = (): void => { toast({ title: "Link copied." }); };
        const fail = (): void => { toast({ title: "Couldn't copy link.", variant: "destructive" }); };
        if (navigator.clipboard?.writeText) {
          navigator.clipboard.writeText(url).then(ok, fail);
        } else {
          fail();
        }
        try { window.history.replaceState(null, "", `#${slug}`); } catch { /* */ }
      },
    },
    createElement(Link2, { size: 14, "aria-hidden": true }),
  );
}

export class HeadingAnchorWidget extends ReactWidget {
  protected tag: "span" = "span";

  constructor(private readonly slug: string) {
    super();
  }

  protected render(): ReactElement {
    return createElement(HeadingAnchorInner, { slug: this.slug });
  }

  protected revealOnClick(): boolean {
    return false;
  }

  eq(other: WidgetType): boolean {
    return other instanceof HeadingAnchorWidget && other.slug === this.slug;
  }
}
