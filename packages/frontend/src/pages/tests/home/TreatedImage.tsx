import { useEffect, useRef } from "react";

// A product screenshot re-rendered in the page's style - Bayer-dithered
// duotone, ASCII glyphs, or tinted + grained - with the untouched capture
// cross-fading in on hover/focus so the real UI is one gesture away.

export type Treatment = "dither" | "ascii" | "grain";

type Props = {
  src: string;
  alt: string;
  treatment: Treatment;
  /** Dark -> light ramp the processed image is mapped onto. */
  palette: string[];
};

export const BAYER8 = (() => {
  const m = new Float32Array(64);
  const b2 = (x: number, y: number) => [0, 2, 3, 1][(y & 1) * 2 + (x & 1)];
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 8; x++) {
      // Standard recursive Bayer construction.
      const v = 16 * b2(x, y) + 4 * b2(x >> 1, y >> 1) + b2(x >> 2, y >> 2);
      m[y * 8 + x] = (v + 0.5) / 64;
    }
  return m;
})();

const ASCII_RAMP = " .:-=+*x%#&@";

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Luminance samples of `img` at cols x rows, auto-levelled to 0..1. */
function sample(img: HTMLImageElement, cols: number, rows: number) {
  const c = document.createElement("canvas");
  c.width = cols;
  c.height = rows;
  const x = c.getContext("2d", { willReadFrequently: true })!;
  x.drawImage(img, 0, 0, cols, rows);
  const d = x.getImageData(0, 0, cols, rows).data;
  const lum = new Float32Array(cols * rows);
  for (let i = 0; i < lum.length; i++) {
    lum[i] = (0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2]) / 255;
  }
  // Screenshots are mostly dark UI; stretch 2nd..98th percentile to full range.
  const sorted = Float32Array.from(lum).sort();
  const lo = sorted[Math.floor(sorted.length * 0.02)];
  const hi = sorted[Math.floor(sorted.length * 0.98)];
  const span = Math.max(0.05, hi - lo);
  for (let i = 0; i < lum.length; i++) lum[i] = Math.min(1, Math.max(0, (lum[i] - lo) / span));
  return lum;
}

/** Ordered-dither `img` at `cols` wide onto `palette` (dark -> light), as RGBA. */
export function ditherImage(img: HTMLImageElement, cols: number, palette: string[]) {
  const rows = Math.round((cols * img.naturalHeight) / img.naturalWidth);
  const lum = sample(img, cols, rows);
  const data = new Uint8ClampedArray(cols * rows * 4);
  const rgb = palette.map(hexToRgb);
  const levels = rgb.length - 1;
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x;
      const v = Math.min(levels, Math.floor(lum[i] * levels + BAYER8[(y & 7) * 8 + (x & 7)]));
      const [r, g, b] = rgb[v];
      data[i * 4] = r;
      data[i * 4 + 1] = g;
      data[i * 4 + 2] = b;
      data[i * 4 + 3] = 255;
    }
  return { cols, rows, data };
}

function renderDither(canvas: HTMLCanvasElement, img: HTMLImageElement, palette: string[]) {
  const { cols, rows, data } = ditherImage(img, 480, palette);
  canvas.width = cols;
  canvas.height = rows;
  canvas.getContext("2d")!.putImageData(new ImageData(data, cols, rows), 0, 0);
}

function renderAscii(canvas: HTMLCanvasElement, img: HTMLImageElement, palette: string[]) {
  const cols = 150;
  const cellW = 8, cellH = 14;
  const rows = Math.round((cols * cellW * img.naturalHeight) / img.naturalWidth / cellH);
  const lum = sample(img, cols, rows);
  const scale = 2;
  canvas.width = cols * cellW * scale;
  canvas.height = rows * cellH * scale;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(scale, scale);
  ctx.fillStyle = palette[0];
  ctx.fillRect(0, 0, cols * cellW, rows * cellH);
  ctx.font = "13px 'DM Mono', ui-monospace, monospace";
  ctx.textBaseline = "middle";
  const tones = palette.length - 1;
  for (let k = 1; k <= tones; k++) {
    ctx.fillStyle = palette[k];
    for (let i = 0; i < lum.length; i++) {
      const v = lum[i];
      const tone = Math.max(1, Math.ceil(v * tones));
      if (tone !== k) continue;
      const ch = ASCII_RAMP[Math.round(v * (ASCII_RAMP.length - 1))];
      if (ch === " ") continue;
      const x = i % cols;
      const y = (i - x) / cols;
      ctx.fillText(ch, x * cellW, (y + 0.5) * cellH);
    }
  }
}

export function TreatedImage({ src, alt, treatment, palette }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const paletteKey = palette.join();

  useEffect(() => {
    if (treatment === "grain") return;
    let cancelled = false;
    const img = new Image();
    img.decoding = "async";
    img.src = src;
    const run = () => {
      if (cancelled || !canvas.current) return;
      const pal = paletteKey.split(",");
      if (treatment === "dither") renderDither(canvas.current, img, pal);
      else renderAscii(canvas.current, img, pal);
    };
    Promise.all([img.decode(), document.fonts?.ready]).then(run).catch(() => {});
    return () => { cancelled = true; };
  }, [src, treatment, paletteKey]);

  return (
    <figure className={`th-treated th-treated-${treatment}`} tabIndex={0}>
      <img className="th-treated-real" src={src} alt={alt} width={1920} height={1200} loading="lazy" decoding="async" />
      {treatment === "grain"
        ? <span className="th-treated-noise" aria-hidden="true" />
        : <canvas ref={canvas} className="th-treated-fx" aria-hidden="true" />}
      <figcaption className="th-treated-hint" aria-hidden="true">hover to reveal</figcaption>
    </figure>
  );
}
