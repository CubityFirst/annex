import { createElement, type ReactElement } from "react";
import { WidgetType } from "@codemirror/view";
import { ReactWidget } from "./ReactWidget";
import { AudioEmbed } from "@/components/AudioEmbed";
import { useRendererCtx } from "../context/RendererContext";
import type { AudioSize } from "@/lib/audioUrl";

interface Props {
  src: string;
  alt: string;
  size: AudioSize;
  style?: string;
  inline: boolean;
}

function AudioInner({ src, alt, size, style }: Props) {
  const ctx = useRendererCtx();
  const styleObj = style ? parseStyle(style) : undefined;
  return createElement(AudioEmbed, {
    src,
    alt,
    size,
    projectId: ctx.projectId,
    isPublic: ctx.isPublic,
    style: styleObj,
  });
}

function parseStyle(s: string): React.CSSProperties {
  const out: React.CSSProperties = {};
  for (const decl of s.split(";")) {
    const [k, v] = decl.split(":").map(p => p.trim());
    if (!k || !v) continue;
    if (k === "width") out.width = v;
    else if (k === "height") out.height = v;
    else if (k === "display") out.display = v;
    else if (k === "margin-left") out.marginLeft = v;
    else if (k === "margin-right") out.marginRight = v;
  }
  return out;
}

export class AudioWidget extends ReactWidget {
  constructor(private readonly props: Props) {
    super();
    this.tag = props.inline ? "span" : "div";
  }

  protected render(): ReactElement {
    return createElement(AudioInner, this.props);
  }

  protected revealOnClick(): boolean {
    // Clicks on the preview surface (border, visualizer canvas) reveal the
    // raw markdown like images do. Interactive children - the small play
    // button and the native <audio controls> - call stopPropagation on
    // pointerdown so transport keeps working without revealing.
    return true;
  }

  eq(other: WidgetType): boolean {
    return (
      other instanceof AudioWidget &&
      other.props.src === this.props.src &&
      other.props.alt === this.props.alt &&
      other.props.size === this.props.size &&
      other.props.style === this.props.style &&
      other.props.inline === this.props.inline
    );
  }
}
