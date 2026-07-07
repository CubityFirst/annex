import { createElement, type ReactElement } from "react";
import { WidgetType } from "@codemirror/view";
import { ReactWidget } from "./ReactWidget";
import { AuthenticatedImage } from "@/components/AuthenticatedImage";
import { useRendererCtx } from "../context/RendererContext";
import { parseInlineStyle } from "@/lib/imageAttrs";

interface Props {
  src: string;
  alt: string;
  style?: string;
  inline: boolean;
}

function ImageInner({ src, alt, style, inline }: Props) {
  const ctx = useRendererCtx();
  const styleObj = style ? parseInlineStyle(style) : undefined;
  const cls = inline ? "cm-wysiwyg-image cm-wysiwyg-image--inline" : "cm-wysiwyg-image cm-wysiwyg-image--block";
  return createElement(AuthenticatedImage, {
    src,
    alt,
    projectId: ctx.projectId,
    isPublic: ctx.isPublic,
    style: styleObj,
    className: cls,
  });
}

export class ImageWidget extends ReactWidget {
  constructor(private readonly props: Props) {
    super();
    this.tag = props.inline ? "span" : "div";
  }

  protected render(): ReactElement {
    return createElement(ImageInner, this.props);
  }

  protected revealOnClick(): boolean {
    return true;
  }

  // Honor an explicit height attr; otherwise a round block-image guess keeps
  // reading-mode scrolling from jumping as images load. Inline images are
  // roughly line-height and don't need an estimate.
  get estimatedHeight(): number {
    if (this.props.style) {
      const h = parseInlineStyle(this.props.style).height;
      if (typeof h === "string" && /^\d+(?:\.\d+)?px$/.test(h)) return parseFloat(h);
    }
    return this.props.inline ? -1 : 250;
  }

  eq(other: WidgetType): boolean {
    return (
      other instanceof ImageWidget &&
      other.props.src === this.props.src &&
      other.props.alt === this.props.alt &&
      other.props.style === this.props.style &&
      other.props.inline === this.props.inline
    );
  }
}
