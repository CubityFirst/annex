// Shared helpers for the /test/home ASCII variants.

/** Warm off-white on near-black, dim -> bright; matches the live landing palette. */
export const MONO = ["#26241f", "#4a4740", "#7a766e", "#a8a39b", "#d6d1c9", "#f4f0ea"];

export const GLYPH_FONT = "'DM Mono', ui-monospace, monospace";

/** Monospace cell metrics for a grid that fills `w` x `h` css px. */
export function gridMetrics(ctx: CanvasRenderingContext2D, w: number, h: number, small = w < 700) {
  const fontPx = small ? 8 : 10;
  const lineH = small ? 9 : 11;
  ctx.font = `${fontPx}px ${GLYPH_FONT}`;
  const cw = ctx.measureText("M").width || fontPx * 0.6;
  return { fontPx, lineH, cw, cols: Math.ceil(w / cw), rows: Math.ceil(h / lineH) };
}

/**
 * Rasterise every `[data-ascii-line]` under `root` into a cols x rows
 * coverage mask (0..1), using each line's own computed font at its on-screen
 * position relative to `origin`. Lets a canvas grid "trace" real DOM text.
 */
export function buildTextMask(
  root: HTMLElement | null,
  origin: DOMRect,
  cols: number,
  rows: number,
  cw: number,
  lineH: number,
) {
  const m = document.createElement("canvas");
  m.width = Math.max(1, cols);
  m.height = Math.max(1, rows);
  const mc = m.getContext("2d", { willReadFrequently: true })!;
  mc.scale(1 / cw, 1 / lineH);
  root?.querySelectorAll<HTMLElement>("[data-ascii-line]").forEach((line) => {
    const r = line.getBoundingClientRect();
    const cs = getComputedStyle(line);
    mc.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    if ("letterSpacing" in mc) (mc as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = cs.letterSpacing === "normal" ? "0px" : cs.letterSpacing;
    const label = (cs.textTransform === "uppercase" ? line.textContent?.toUpperCase() : line.textContent) ?? "";
    const met = mc.measureText(label);
    const asc = met.fontBoundingBoxAscent, desc = met.fontBoundingBoxDescent;
    const baseline = r.top - origin.top + (r.height - (asc + desc)) / 2 + asc;
    mc.fillStyle = "#fff";
    mc.fillText(label, r.left - origin.left, baseline);
  });
  const d = mc.getImageData(0, 0, m.width, m.height).data;
  const mask = new Float32Array(cols * rows);
  for (let i = 0; i < mask.length; i++) mask[i] = d[i * 4 + 3] / 255;
  return mask;
}

export function hash(x: number, y: number) {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export function noise(x: number, y: number) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const tx = x - xi, ty = y - yi;
  const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
  const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

export const prefersReducedMotion = () =>
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/**
 * Drive `frame` at ~fps while `el` is on screen and the tab is visible.
 * Returns a stop function. `frame` receives seconds since start.
 */
export function runLoop(el: Element, fps: number, frame: (t: number) => void) {
  let raf = 0, last = 0, visible = true;
  const t0 = performance.now();
  const loop = (ts: number) => {
    raf = 0;
    if (!visible || document.hidden) return;
    if (ts - last >= 1000 / fps) {
      last = ts;
      frame((ts - t0) / 1000);
    }
    raf = requestAnimationFrame(loop);
  };
  const kick = () => { if (!raf) raf = requestAnimationFrame(loop); };
  const io = new IntersectionObserver(([e]) => {
    visible = e.isIntersecting;
    if (visible) kick();
  });
  io.observe(el);
  const onVis = () => { if (!document.hidden) kick(); };
  document.addEventListener("visibilitychange", onVis);
  kick();
  return () => {
    cancelAnimationFrame(raf);
    io.disconnect();
    document.removeEventListener("visibilitychange", onVis);
  };
}
