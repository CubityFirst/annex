import { createElement, type ReactElement } from "react";
import { WidgetType } from "@codemirror/view";
import { ReactWidget } from "./ReactWidget";
import { AudioEmbed } from "@/components/AudioEmbed";
import { useRendererCtx } from "../context/RendererContext";
import { parseInlineStyle } from "@/lib/imageAttrs";
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
  const styleObj = style ? parseInlineStyle(style) : undefined;
  return createElement(AudioEmbed, {
    src,
    alt,
    size,
    projectId: ctx.projectId,
    isPublic: ctx.isPublic,
    style: styleObj,
  });
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

  // Full player: h-20 visualizer + native controls + p-4 padding. The small
  // inline pill is roughly line-height and doesn't need an estimate.
  get estimatedHeight(): number {
    return this.props.size === "full" ? 152 : -1;
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
