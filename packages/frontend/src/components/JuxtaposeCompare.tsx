import { useCallback, useRef, useState } from "react";
import { ChevronsLeftRight, ChevronsUpDown } from "lucide-react";
import { AuthenticatedImage } from "@/components/AuthenticatedImage";
import { useRendererCtx } from "@/components/wysiwyg/context/RendererContext";
import type { JuxtaposeConfig } from "@/lib/juxtapose";

interface Props extends JuxtaposeConfig {
  /**
   * When true (Reading / published view) the divider is draggable. When false
   * (Editing view) the slider is a static preview so a click can fall through to
   * CodeMirror and reveal the raw block for editing.
   */
  interactive: boolean;
}

function clamp(n: number): number {
  return Math.min(100, Math.max(0, n));
}

// Pick black/white for legibility on a custom hex fill. Theme-accent fills use
// the paired --primary-foreground token instead, so this only runs for `accent`.
function contrastText(hex: string): string {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.split("").map(c => c + c).join("");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return luminance > 0.6 ? "#000000" : "#ffffff";
}

// Click-to-seek glides the divider; dragging tracks the pointer with no easing.
const SEEK_TRANSITION = "clip-path 280ms ease, left 280ms ease, top 280ms ease";

export function JuxtaposeCompare({
  before,
  after,
  beforeLabel,
  afterLabel,
  orientation,
  startAt,
  handle,
  accent,
  interactive,
}: Props) {
  const ctx = useRendererCtx();
  const wrapRef = useRef<HTMLDivElement>(null);
  // Tracks an active press and whether it has turned into a drag yet.
  const pressRef = useRef<{ moved: boolean } | null>(null);
  const [pos, setPos] = useState(() => clamp(startAt));
  // True only for a click-seek, so the move animates; dragging/keyboard are instant.
  const [animate, setAnimate] = useState(false);
  const vertical = orientation === "vertical";
  // Three colour modes: absent → original white look; "theme" → site accent
  // (--primary, paired foreground); a hex → custom (computed contrasting icon).
  const colorMode = !accent ? "white" : accent === "theme" ? "theme" : "custom";
  const handleFill =
    colorMode === "white" ? "#ffffff" : colorMode === "theme" ? "var(--primary)" : accent!;
  const knobFg =
    colorMode === "white" ? "#000000" : colorMode === "theme" ? "var(--primary-foreground)" : contrastText(accent!);
  // The divider stays a soft white in the original look; otherwise it matches the fill.
  const dividerColor = colorMode === "white" ? "rgba(255,255,255,0.92)" : handleFill;

  const updateFromPointer = useCallback(
    (clientX: number, clientY: number) => {
      const el = wrapRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const p = vertical
        ? ((clientY - r.top) / r.height) * 100
        : ((clientX - r.left) / r.width) * 100;
      setPos(clamp(p));
    },
    [vertical],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!interactive) return;
      pressRef.current = { moved: false };
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch {
        /* setPointerCapture can throw if the pointer is already gone */
      }
      // Animate the initial jump - a plain click glides to the target. If the
      // user then drags, the first move switches off the transition.
      setAnimate(true);
      updateFromPointer(e.clientX, e.clientY);
    },
    [interactive, updateFromPointer],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const press = pressRef.current;
      if (!press) return;
      if (!press.moved) {
        press.moved = true;
        setAnimate(false);
      }
      updateFromPointer(e.clientX, e.clientY);
    },
    [updateFromPointer],
  );

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    pressRef.current = null;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  }, []);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const step = e.shiftKey ? 10 : 2;
      const dec = vertical ? "ArrowUp" : "ArrowLeft";
      const inc = vertical ? "ArrowDown" : "ArrowRight";
      if (e.key === dec) {
        setAnimate(false);
        setPos(p => clamp(p - step));
        e.preventDefault();
      } else if (e.key === inc) {
        setAnimate(false);
        setPos(p => clamp(p + step));
        e.preventDefault();
      } else if (e.key === "Home") {
        setAnimate(false);
        setPos(0);
        e.preventDefault();
      } else if (e.key === "End") {
        setAnimate(false);
        setPos(100);
        e.preventDefault();
      }
    },
    [vertical],
  );

  // The `after` image overlays the `before` base; clip away the side already
  // shown by `before` so the divider reveals `after` on the far side.
  const afterClip = vertical ? `inset(${pos}% 0 0 0)` : `inset(0 0 0 ${pos}%)`;
  const transition = animate ? SEEK_TRANSITION : undefined;

  return (
    <div
      ref={wrapRef}
      className="cm-juxtapose relative my-2 w-full select-none overflow-hidden rounded-md border border-border"
      style={{
        touchAction: interactive ? "none" : undefined,
        cursor: interactive ? (vertical ? "ns-resize" : "ew-resize") : undefined,
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {/* base = before image, establishes the box height */}
      <AuthenticatedImage
        src={before}
        alt={beforeLabel || "Before"}
        projectId={ctx.projectId}
        isPublic={ctx.isPublic}
        className="pointer-events-none block h-auto w-full select-none"
        draggable={false}
      />
      {/* overlay = after image, clipped to the far side of the divider */}
      <AuthenticatedImage
        src={after}
        alt={afterLabel || "After"}
        projectId={ctx.projectId}
        isPublic={ctx.isPublic}
        className="pointer-events-none select-none"
        draggable={false}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          objectFit: "cover",
          clipPath: afterClip,
          transition,
        }}
      />

      {beforeLabel && (
        <span className="pointer-events-none absolute left-2 top-2 rounded bg-black/60 px-1.5 py-0.5 text-xs font-medium text-white">
          {beforeLabel}
        </span>
      )}
      {afterLabel && (
        <span
          className={`pointer-events-none absolute right-2 rounded bg-black/60 px-1.5 py-0.5 text-xs font-medium text-white ${vertical ? "bottom-2" : "top-2"}`}
        >
          {afterLabel}
        </span>
      )}

      {/* divider line - accent-tinted */}
      <div
        className="pointer-events-none absolute shadow-[0_0_4px_rgba(0,0,0,0.5)]"
        style={
          vertical
            ? { left: 0, right: 0, top: `${pos}%`, height: 2, transform: "translateY(-1px)", background: dividerColor, transition }
            : { top: 0, bottom: 0, left: `${pos}%`, width: 2, transform: "translateX(-1px)", background: dividerColor, transition }
        }
      />

      {/* knob - focusable slider handle when interactive */}
      {handle === "bar" ? (
        <div
          role="slider"
          tabIndex={interactive ? 0 : -1}
          aria-label="Comparison slider"
          aria-orientation={vertical ? "vertical" : "horizontal"}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(pos)}
          onKeyDown={interactive ? onKeyDown : undefined}
          className="absolute z-10 -translate-x-1/2 -translate-y-1/2 rounded-full shadow ring-1 ring-black/15 outline-none focus-visible:ring-2 focus-visible:ring-primary"
          style={{
            ...(vertical
              ? { left: "50%", top: `${pos}%`, width: 28, height: 6 }
              : { left: `${pos}%`, top: "50%", width: 6, height: 28 }),
            background: handleFill,
            pointerEvents: interactive ? "auto" : "none",
            transition,
          }}
        />
      ) : (
        <div
          role="slider"
          tabIndex={interactive ? 0 : -1}
          aria-label="Comparison slider"
          aria-orientation={vertical ? "vertical" : "horizontal"}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(pos)}
          onKeyDown={interactive ? onKeyDown : undefined}
          className="absolute z-10 flex h-7 w-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full shadow ring-1 ring-black/10 outline-none focus-visible:ring-2 focus-visible:ring-primary"
          style={{
            ...(vertical ? { left: "50%", top: `${pos}%` } : { left: `${pos}%`, top: "50%" }),
            background: handleFill,
            color: knobFg,
            pointerEvents: interactive ? "auto" : "none",
            transition,
          }}
        >
          {vertical ? (
            <ChevronsUpDown className="h-4 w-4" aria-hidden="true" />
          ) : (
            <ChevronsLeftRight className="h-4 w-4" aria-hidden="true" />
          )}
        </div>
      )}
    </div>
  );
}
