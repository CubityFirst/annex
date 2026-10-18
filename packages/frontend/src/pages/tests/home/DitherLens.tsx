import { useEffect, useRef } from "react";
import { BAYER8, ditherImage } from "./TreatedImage";

// The product screenshot, fully Bayer-dithered, with a "lens" that resolves
// the real UI underneath. The lens edge is itself dithered (the cut-off is
// thresholded against the Bayer matrix, not alpha-blended), so the boundary
// dissolves pixel by pixel. Follows the pointer; idles on a slow Lissajous
// drift when nobody is hovering.

const COLS = 420;
const LENS = 0.17; // radius as a fraction of frame width
const EDGE = 0.55; // dissolve band width, as a fraction of the radius

type Props = { src: string; alt: string; palette: string[] };

export function DitherLens({ src, alt, palette }: Props) {
  const frame = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const paletteKey = palette.join();

  useEffect(() => {
    const el = frame.current;
    const cv = canvas.current;
    if (!el || !cv) return;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    let rgb: Uint8ClampedArray | null = null;
    let out: ImageData | null = null;
    let cols = 0, rows = 0;
    let raf = 0, visible = true, hovering = false;
    const lens = { x: 0.62, y: 0.42 };
    const target = { ...lens };
    const t0 = performance.now();
    const ctx = cv.getContext("2d")!;

    const img = new Image();
    img.src = src;
    img.decode().then(() => {
      const d = ditherImage(img, COLS, paletteKey.split(","));
      ({ cols, rows } = d);
      // Image pixels followed by one extra RGBA slot for the ring colour.
      rgb = new Uint8ClampedArray(d.data.length + 4);
      rgb.set(d.data);
      const accent = parseInt(paletteKey.split(",").at(-1)!.slice(1), 16);
      rgb.set([(accent >> 16) & 255, (accent >> 8) & 255, accent & 255, 255], d.data.length);
      cv.width = cols;
      cv.height = rows;
      out = ctx.createImageData(cols, rows);
      paint();
      kick();
    }).catch(() => {});

    const paint = () => {
      if (!rgb || !out) return;
      const r = LENS * cols;
      const inner = r * (1 - EDGE);
      const lx = lens.x * cols, ly = lens.y * rows;
      const o = out.data;
      const px = rgb;
      const ringAt = rgb.length - 4; // last slot holds the accent colour
      for (let y = 0; y < rows; y++) {
        const dy = y - ly;
        for (let x = 0; x < cols; x++) {
          const i = (y * cols + x) * 4;
          const dist = Math.sqrt((x - lx) * (x - lx) + dy * dy);
          // 0 at the lens core -> 1 outside; dithered threshold, no blending.
          const k = dist <= inner ? 0 : dist >= r ? 1 : (dist - inner) / (r - inner);
          const show = k > BAYER8[(y & 7) * 8 + (x & 7)];
          // A one-cell accent ring at the outer edge so the lens reads on dark UI.
          const ring = Math.abs(dist - r) < 0.6 && (x + y) % 2 === 0;
          const src = ring ? ringAt : i;
          o[i] = px[src]; o[i + 1] = px[src + 1]; o[i + 2] = px[src + 2];
          o[i + 3] = show || ring ? 255 : 0;
        }
      }
      ctx.putImageData(out, 0, 0);
    };

    const tick = () => {
      raf = 0;
      if (!visible || document.hidden) return;
      if (!hovering) {
        const t = (performance.now() - t0) / 1000;
        target.x = 0.5 + 0.32 * Math.sin(t * 0.23);
        target.y = 0.5 + 0.28 * Math.sin(t * 0.37 + 1);
      }
      const dx = target.x - lens.x, dy = target.y - lens.y;
      lens.x += dx * 0.12;
      lens.y += dy * 0.12;
      paint();
      if ((hovering || reduced) && Math.abs(dx) + Math.abs(dy) < 0.0005) return;
      raf = requestAnimationFrame(tick);
    };
    const kick = () => { if (!raf && rgb) raf = requestAnimationFrame(tick); };

    const onMove = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      hovering = true;
      target.x = (e.clientX - r.left) / r.width;
      target.y = (e.clientY - r.top) / r.height;
      kick();
    };
    const onLeave = () => { hovering = false; if (!reduced) kick(); };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerleave", onLeave);
    const io = new IntersectionObserver(([e]) => {
      visible = e.isIntersecting;
      if (visible && !reduced) kick();
    });
    io.observe(el);
    const onVis = () => { if (!document.hidden && !reduced) kick(); };
    document.addEventListener("visibilitychange", onVis);

    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerleave", onLeave);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [src, paletteKey]);

  return (
    <div ref={frame} className="th-lens">
      <img src={src} alt={alt} width={1920} height={1200} decoding="async" fetchPriority="high" />
      <canvas ref={canvas} aria-hidden="true" />
    </div>
  );
}
