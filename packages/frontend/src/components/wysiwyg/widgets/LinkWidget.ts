import { createElement, type ReactElement } from "react";
import { WidgetType } from "@codemirror/view";
import { ReactWidget } from "./ReactWidget";

interface Props {
  text: string;
  href: string;
}

function LinkInner({ text, href }: Props) {
  return createElement(
    "a",
    {
      href,
      target: "_blank",
      rel: "noopener noreferrer",
      className: "cm-link",
      onClick: (e: React.MouseEvent) => {
        // Don't let the click bubble into the editor and move the cursor -
        // we want the browser navigation to win.
        e.stopPropagation();
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
