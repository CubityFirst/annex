import { useState, useEffect, useRef } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { ImageIcon, RotateCw } from "lucide-react";

const CONTAINER_W = 320;
const CONTAINER_H = 260;
const CIRCLE_R = 116;
const OUTPUT_SIZE = 512;

// Each entry is one fully-composited animation frame (already resolved
// against the GIF's disposal semantics) at the source GIF's logical
// screen size. We hold ImageBitmaps so the apply step can drawImage
// them through the same transform pipeline as a static crop. Output
// goes to animated WebP regardless of input format.
type GifFrame = { bmp: ImageBitmap; delayMs: number };

function clampOffset(ox: number, oy: number, scale: number, natW: number, natH: number, rotation: number) {
  const swapped = rotation === 90 || rotation === 270;
  const effW = (swapped ? natH : natW) * scale;
  const effH = (swapped ? natW : natH) * scale;
  const maxX = Math.max(0, effW / 2 - CIRCLE_R);
  const maxY = Math.max(0, effH / 2 - CIRCLE_R);
  return {
    x: Math.min(maxX, Math.max(-maxX, ox)),
    y: Math.min(maxY, Math.max(-maxY, oy)),
  };
}

// Zoom around an arbitrary screen point (mx, my) relative to container centre.
// Keeps the image pixel under that point fixed as scale changes.
function zoomAround(mx: number, my: number, oldScale: number, newScale: number, oldOffset: { x: number; y: number }) {
  const ratio = newScale / oldScale;
  return {
    x: mx * (1 - ratio) + oldOffset.x * ratio,
    y: my * (1 - ratio) + oldOffset.y * ratio,
  };
}

interface AvatarCropDialogProps {
  file: File;
  onApply: (blob: Blob) => Promise<void>;
  onClose: () => void;
  /** Visual shape of the crop overlay. The output is always a square 512×512
   * blob - `shape` only changes the mask cutout + border the user sees while
   * cropping. Default "circle" for user avatars; pass "square" for project
   * icons where the rendered image is shown un-clipped. */
  shape?: "circle" | "square";
}

export function AvatarCropDialog({ file, onApply, onClose, shape = "circle" }: AvatarCropDialogProps) {
  const [imageSrc, setImageSrc] = useState("");
  const [naturalSize, setNaturalSize] = useState({ w: 1, h: 1 });
  const [minScale, setMinScale] = useState(1);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [rotation, setRotation] = useState(0);
  const [applying, setApplying] = useState(false);
  const [gifFrames, setGifFrames] = useState<GifFrame[] | null>(null);
  const [gifDecoding, setGifDecoding] = useState(false);
  const [encodeProgress, setEncodeProgress] = useState<{ done: number; total: number } | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  // Map of active pointer ids → their current client positions
  const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  // State captured at the moment a drag or pinch gesture begins
  const dragRef = useRef<{ startX: number; startY: number; startOX: number; startOY: number } | null>(null);
  const pinchRef = useRef<{
    startDist: number;
    startScale: number;
    startOffset: { x: number; y: number };
    startMid: { x: number; y: number };
  } | null>(null);

  useEffect(() => {
    const url = URL.createObjectURL(file);
    setImageSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  // Decode animated GIFs upfront so the Apply step can re-encode every
  // frame through the user's crop transform. Single-frame GIFs fall back
  // to the static JPEG path (no animation to preserve). Bitmap cleanup
  // is handled by the gifFrames cleanup effect below, not here.
  useEffect(() => {
    if (file.type !== "image/gif") {
      setGifFrames(null);
      return;
    }
    let cancelled = false;
    setGifDecoding(true);
    (async () => {
      try {
        const [{ parseGIF, decompressFrames }, buf] = await Promise.all([
          import("gifuct-js"),
          file.arrayBuffer(),
        ]);
        if (cancelled) return;
        const parsed = parseGIF(buf);
        const raw = decompressFrames(parsed, true);
        if (raw.length <= 1) return;

        const lsdW = parsed.lsd.width;
        const lsdH = parsed.lsd.height;
        const compose = document.createElement("canvas");
        compose.width = lsdW;
        compose.height = lsdH;
        const ctx = compose.getContext("2d", { willReadFrequently: true })!;

        const out: GifFrame[] = [];
        let prevDisposal = 0;
        let prevDims: { top: number; left: number; width: number; height: number } | null = null;
        let savedState: ImageData | null = null;

        for (const frame of raw) {
          if (cancelled) return;
          // Apply previous frame's disposal before drawing this one.
          // Type 2 = clear the prior frame's rectangle; type 3 = restore
          // the canvas to whatever it looked like before the prior frame.
          // 0/1 = leave alone (the common case).
          if (prevDisposal === 2 && prevDims) {
            ctx.clearRect(prevDims.left, prevDims.top, prevDims.width, prevDims.height);
          } else if (prevDisposal === 3 && savedState) {
            ctx.putImageData(savedState, 0, 0);
          }
          savedState = frame.disposalType === 3 ? ctx.getImageData(0, 0, lsdW, lsdH) : null;

          // Composite the frame patch via a temp canvas so alpha=0 pixels
          // don't overwrite the cumulative state (putImageData ignores
          // existing pixels - drawImage respects them).
          const patchData = new ImageData(new Uint8ClampedArray(frame.patch), frame.dims.width, frame.dims.height);
          const patchCanvas = document.createElement("canvas");
          patchCanvas.width = frame.dims.width;
          patchCanvas.height = frame.dims.height;
          patchCanvas.getContext("2d")!.putImageData(patchData, 0, 0);
          ctx.drawImage(patchCanvas, frame.dims.left, frame.dims.top);

          const bmp = await createImageBitmap(compose);
          if (cancelled) { bmp.close(); return; }
          out.push({ bmp, delayMs: frame.delay > 0 ? frame.delay : 100 });
          prevDims = frame.dims;
          prevDisposal = frame.disposalType ?? 0;
        }
        if (!cancelled) setGifFrames(out);
        else out.forEach(f => f.bmp.close());
      } catch (err) {
        console.error("GIF decode failed; falling back to static crop", err);
      } finally {
        if (!cancelled) setGifDecoding(false);
      }
    })();
    return () => { cancelled = true; };
  }, [file]);

  // Release decoded bitmaps when the set is replaced or the dialog unmounts.
  useEffect(() => {
    return () => { gifFrames?.forEach(f => f.bmp.close()); };
  }, [gifFrames]);

  function handleImageLoad(e: React.SyntheticEvent<HTMLImageElement>) {
    const { naturalWidth: w, naturalHeight: h } = e.currentTarget;
    setNaturalSize({ w, h });
    const ms = Math.max((CIRCLE_R * 2) / w, (CIRCLE_R * 2) / h);
    setMinScale(ms);
    setScale(ms);
    setOffset({ x: 0, y: 0 });
    setRotation(0);
  }

  function beginPinch(pts: { x: number; y: number }[]) {
    const [a, b] = pts;
    pinchRef.current = {
      startDist: Math.hypot(b.x - a.x, b.y - a.y),
      startScale: scale,
      startOffset: { x: offset.x, y: offset.y },
      startMid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    };
    dragRef.current = null;
  }

  function handlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    const pts = [...pointersRef.current.values()];
    if (pts.length >= 2) {
      beginPinch(pts);
    } else {
      dragRef.current = { startX: e.clientX, startY: e.clientY, startOX: offset.x, startOY: offset.y };
      pinchRef.current = null;
    }
  }

  function handlePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...pointersRef.current.values()];

    if (pts.length >= 2 && pinchRef.current) {
      const { startDist, startScale, startOffset, startMid } = pinchRef.current;
      const [a, b] = pts;
      const newDist = Math.hypot(b.x - a.x, b.y - a.y);
      const newMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };

      const newScale = Math.min(minScale * 4, Math.max(minScale, startScale * (newDist / startDist)));

      // Midpoint in container-relative coords (origin = container centre)
      const rect = containerRef.current!.getBoundingClientRect();
      const mx = startMid.x - rect.left - CONTAINER_W / 2;
      const my = startMid.y - rect.top - CONTAINER_H / 2;

      // Zoom around the initial pinch midpoint, then add any panning
      const zoomed = zoomAround(mx, my, startScale, newScale, startOffset);
      const panX = newMid.x - startMid.x;
      const panY = newMid.y - startMid.y;

      setScale(newScale);
      setOffset(clampOffset(zoomed.x + panX, zoomed.y + panY, newScale, naturalSize.w, naturalSize.h, rotation));
    } else if (pts.length === 1 && dragRef.current) {
      setOffset(clampOffset(
        dragRef.current.startOX + e.clientX - dragRef.current.startX,
        dragRef.current.startOY + e.clientY - dragRef.current.startY,
        scale, naturalSize.w, naturalSize.h, rotation,
      ));
    }
  }

  function handlePointerUp(e: React.PointerEvent<HTMLDivElement>) {
    pointersRef.current.delete(e.pointerId);
    pinchRef.current = null;

    const remaining = [...pointersRef.current.entries()];
    if (remaining.length === 1) {
      const [, pt] = remaining[0];
      dragRef.current = { startX: pt.x, startY: pt.y, startOX: offset.x, startOY: offset.y };
    } else {
      dragRef.current = null;
    }
  }

  // Slider zooms around the circle centre (mx = my = 0)
  function handleSliderChange(pct: number) {
    const newScale = minScale + pct * (minScale * 3);
    const newOffset = zoomAround(0, 0, scale, newScale, offset);
    setScale(newScale);
    setOffset(clampOffset(newOffset.x, newOffset.y, newScale, naturalSize.w, naturalSize.h, rotation));
  }

  function handleRotate() {
    const newRotation = (rotation + 90) % 360;
    setRotation(newRotation);
    setOffset(prev => clampOffset(prev.x, prev.y, scale, naturalSize.w, naturalSize.h, newRotation));
  }

  function handleReset() {
    setScale(minScale);
    setOffset({ x: 0, y: 0 });
    setRotation(0);
  }

  // Keyboard-operable pan so the image can be repositioned without a
  // pointer. Arrow keys nudge the image in the pressed direction (Shift =
  // larger step); offsets are clamped the same way as a drag.
  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const step = e.shiftKey ? 20 : 5;
    let dx = 0;
    let dy = 0;
    switch (e.key) {
      case "ArrowLeft": dx = -step; break;
      case "ArrowRight": dx = step; break;
      case "ArrowUp": dy = -step; break;
      case "ArrowDown": dy = step; break;
      default: return;
    }
    e.preventDefault();
    setOffset(prev => clampOffset(prev.x + dx, prev.y + dy, scale, naturalSize.w, naturalSize.h, rotation));
  }

  // Reproduce the layout the user sees in the preview onto a 512×512
  // canvas: translate to centre → fit the circle to the output → apply
  // pan/rotate/zoom → draw the source image centred. Same transform is
  // used for static images and animated GIF frames so the framing matches
  // 1:1.
  function applyCropTransform(ctx: CanvasRenderingContext2D, srcW: number, srcH: number) {
    ctx.translate(OUTPUT_SIZE / 2, OUTPUT_SIZE / 2);
    ctx.scale(OUTPUT_SIZE / (CIRCLE_R * 2), OUTPUT_SIZE / (CIRCLE_R * 2));
    ctx.translate(offset.x, offset.y);
    ctx.rotate((rotation * Math.PI) / 180);
    ctx.scale(scale, scale);
    ctx.translate(-srcW / 2, -srcH / 2);
  }

  async function encodeAnimatedWebP(frames: GifFrame[]): Promise<Blob> {
    const { muxAnimatedWebP } = await import("@/lib/webpMux");
    const canvas = document.createElement("canvas");
    canvas.width = OUTPUT_SIZE;
    canvas.height = OUTPUT_SIZE;
    const ctx = canvas.getContext("2d")!;
    const encoded: { webp: Uint8Array; delayMs: number }[] = [];
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      // Match the static path's implicit black background - the preview
      // shows the same and the avatar gets clipped to a circle anyway.
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = "black";
      ctx.fillRect(0, 0, OUTPUT_SIZE, OUTPUT_SIZE);
      ctx.save();
      applyCropTransform(ctx, f.bmp.width, f.bmp.height);
      ctx.drawImage(f.bmp, 0, 0);
      ctx.restore();

      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(b => (b ? resolve(b) : reject(new Error("WebP encode failed"))), "image/webp", 0.9),
      );
      encoded.push({ webp: new Uint8Array(await blob.arrayBuffer()), delayMs: f.delayMs });
      setEncodeProgress({ done: i + 1, total: frames.length });
      // Yield so the UI can repaint between frames - the per-frame WebP
      // encode is the slow step; without a yield a 100-frame avatar would
      // freeze the dialog for several seconds with no feedback.
      await new Promise<void>(r => setTimeout(r, 0));
    }
    const muxed = muxAnimatedWebP(encoded, OUTPUT_SIZE, OUTPUT_SIZE);
    // Copy into a fresh ArrayBuffer - TS's lib.dom narrows BlobPart to an
    // ArrayBuffer-backed view, not a generic ArrayBufferLike.
    const buf = new ArrayBuffer(muxed.byteLength);
    new Uint8Array(buf).set(muxed);
    return new Blob([buf], { type: "image/webp" });
  }

  async function handleApply() {
    if (!imageSrc) return;
    setApplying(true);
    try {
      if (gifFrames && gifFrames.length > 0) {
        const blob = await encodeAnimatedWebP(gifFrames);
        await onApply(blob);
        return;
      }

      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = reject;
        img.src = imageSrc;
      });

      const canvas = document.createElement("canvas");
      canvas.width = OUTPUT_SIZE;
      canvas.height = OUTPUT_SIZE;
      const ctx = canvas.getContext("2d")!;
      applyCropTransform(ctx, naturalSize.w, naturalSize.h);
      ctx.drawImage(img, 0, 0);

      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(b => (b ? resolve(b) : reject(new Error("Export failed"))), "image/webp", 0.9),
      );

      await onApply(blob);
    } finally {
      setApplying(false);
      setEncodeProgress(null);
    }
  }

  const cx = CONTAINER_W / 2;
  const cy = CONTAINER_H / 2;
  const maxScale = minScale * 4;
  const sliderPct = (scale - minScale) / (maxScale - minScale);

  return (
    <Dialog open onOpenChange={open => { if (!open && !applying) onClose(); }}>
      <DialogContent className="sm:max-w-[380px] gap-4">
        <DialogHeader>
          <DialogTitle>Edit Image</DialogTitle>
        </DialogHeader>

        {/* Crop area */}
        <div
          ref={containerRef}
          role="application"
          tabIndex={0}
          aria-label="Reposition image. Use the arrow keys to pan; hold Shift for larger steps."
          className="relative overflow-hidden bg-black rounded cursor-move select-none mx-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          style={{ width: CONTAINER_W, height: CONTAINER_H, touchAction: "none" }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onKeyDown={handleKeyDown}
          onWheel={e => {
            e.preventDefault();
            const factor = e.deltaY < 0 ? 1.08 : 1 / 1.08;
            const newScale = Math.min(maxScale, Math.max(minScale, scale * factor));
            const newOffset = zoomAround(0, 0, scale, newScale, offset);
            setScale(newScale);
            setOffset(clampOffset(newOffset.x, newOffset.y, newScale, naturalSize.w, naturalSize.h, rotation));
          }}
        >
          {imageSrc && (
            <img
              src={imageSrc}
              onLoad={handleImageLoad}
              style={{
                position: "absolute",
                width: naturalSize.w * scale,
                height: naturalSize.h * scale,
                maxWidth: "none",
                top: cy - (naturalSize.h * scale) / 2 + offset.y,
                left: cx - (naturalSize.w * scale) / 2 + offset.x,
                transformOrigin: "center",
                transform: `rotate(${rotation}deg)`,
                pointerEvents: "none",
                userSelect: "none",
              }}
              draggable={false}
              alt=""
            />
          )}

          {/* Dim overlay with cutout + white border. Cutout shape follows the
              `shape` prop; the bounding box is the same square either way. */}
          <svg
            className="absolute inset-0 pointer-events-none"
            width={CONTAINER_W}
            height={CONTAINER_H}
          >
            <defs>
              <mask id="avatarCropMask">
                <rect width={CONTAINER_W} height={CONTAINER_H} fill="white" />
                {shape === "square" ? (
                  <rect x={cx - CIRCLE_R} y={cy - CIRCLE_R} width={CIRCLE_R * 2} height={CIRCLE_R * 2} fill="black" />
                ) : (
                  <circle cx={cx} cy={cy} r={CIRCLE_R} fill="black" />
                )}
              </mask>
            </defs>
            <rect
              width={CONTAINER_W}
              height={CONTAINER_H}
              fill="rgba(0,0,0,0.55)"
              mask="url(#avatarCropMask)"
            />
            {shape === "square" ? (
              <rect x={cx - CIRCLE_R} y={cy - CIRCLE_R} width={CIRCLE_R * 2} height={CIRCLE_R * 2} fill="none" stroke="white" strokeWidth="2" />
            ) : (
              <circle cx={cx} cy={cy} r={CIRCLE_R} fill="none" stroke="white" strokeWidth="2" />
            )}
          </svg>
        </div>

        {/* Zoom slider + rotate */}
        <div className="flex items-center gap-3 px-1 pt-2">
          <ImageIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <Slider
            min={0}
            max={100}
            step={1}
            value={[Math.round(sliderPct * 100)]}
            onValueChange={([v]) => handleSliderChange(v / 100)}
            className="flex-1"
          />
          <ImageIcon className="size-5 shrink-0 text-muted-foreground" />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
            onClick={handleRotate}
            title="Rotate 90°"
          >
            <RotateCw className="size-4" />
          </Button>
        </div>

        <DialogFooter className="sm:justify-between">
          <Button type="button" variant="ghost" onClick={handleReset} disabled={applying}>
            Reset
          </Button>
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={onClose} disabled={applying}>
              Cancel
            </Button>
            <Button type="button" onClick={handleApply} disabled={applying || gifDecoding || !imageSrc}>
              {gifDecoding
                ? "Decoding…"
                : encodeProgress
                  ? `Encoding ${encodeProgress.done}/${encodeProgress.total}…`
                  : applying
                    ? "Applying…"
                    : "Apply"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
