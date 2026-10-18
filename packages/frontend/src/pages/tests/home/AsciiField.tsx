import { useEffect, useRef, type RefObject } from "react";

// A character grid where the page's own headline is "typeset" out of a real
// markdown document: every `[data-ascii-line]` element under `textRoot` is
// rasterised (same font, same position) into a coverage mask, and cells
// inside the letterforms show the doc's source text scrolling through them.
// Outside the letters a sparse field of markdown punctuation drifts on a
// noise field. The pointer "decodes" glyphs around it and clicks send a
// ripple through the grid. The real heading stays in the DOM (transparent
// text) so it remains selectable and accessible.

const FPS = 30;
const FIELD = " .·:-~=+*#";
const SCRAMBLE = "#*+=-[]>`_~|/\\{}<";
const RIPPLE_SPEED = 520; // px/s
const RIPPLE_LIFE = 1.6; // s

type Props = {
  className?: string;
  textRoot: RefObject<HTMLElement | null>;
  /** Markdown that fills the letterforms. */
  source: string;
  /** Dim -> bright colours, one batch per colour. */
  palette: string[];
};

function hash(x: number, y: number) {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function noise(x: number, y: number) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const tx = x - xi, ty = y - yi;
  const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
  const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

export function AsciiField({ className, textRoot, source, palette }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const paletteKey = palette.join("|");

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const pal = paletteKey.split("|");
    const text = source.replace(/\s+/g, " ");
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    let w = 0, h = 0, cols = 0, rows = 0, cw = 7, lineH = 13, fontPx = 12;
    let mask = new Float32Array(0);
    let glyph = new Uint16Array(0);
    let bucket = new Uint8Array(0);
    let raf = 0, last = 0, visible = true;
    const pointer = { x: -1e4, y: -1e4 };
    const ripples: { x: number; y: number; t: number }[] = [];
    const t0 = performance.now();
    const now = () => (performance.now() - t0) / 1000;
    const glyphs = FIELD + SCRAMBLE + text;
    const FIELD_AT = 0, SCRAMBLE_AT = FIELD.length, TEXT_AT = FIELD.length + SCRAMBLE.length;

    const buildMask = () => {
      const m = document.createElement("canvas");
      m.width = cols;
      m.height = rows;
      const mc = m.getContext("2d", { willReadFrequently: true })!;
      mc.scale(1 / cw, 1 / lineH);
      const origin = canvas.getBoundingClientRect();
      textRoot.current?.querySelectorAll<HTMLElement>("[data-ascii-line]").forEach((line) => {
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
      const d = mc.getImageData(0, 0, cols, rows).data;
      mask = new Float32Array(cols * rows);
      for (let i = 0; i < mask.length; i++) mask[i] = d[i * 4 + 3] / 255;
    };

    const resize = () => {
      const r = canvas.getBoundingClientRect();
      w = r.width; h = r.height;
      fontPx = w < 700 ? 8 : 10;
      lineH = w < 700 ? 9 : 11;
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.font = `${fontPx}px 'DM Mono', ui-monospace, monospace`;
      cw = ctx.measureText("M").width || fontPx * 0.6;
      cols = Math.ceil(w / cw);
      rows = Math.ceil(h / lineH);
      glyph = new Uint16Array(cols * rows);
      bucket = new Uint8Array(cols * rows);
      buildMask();
      draw(reduced ? 4 : now());
    };

    const draw = (t: number) => {
      const top = pal.length - 1;
      const scroll = Math.floor(t * 9);
      const live = ripples.filter((rp) => t - rp.t < RIPPLE_LIFE);
      ripples.length = 0;
      ripples.push(...live);

      for (let row = 0; row < rows; row++) {
        const y = (row + 0.5) * lineH;
        for (let col = 0; col < cols; col++) {
          const i = row * cols + col;
          const x = (col + 0.5) * cw;
          const m = mask[i];
          const n = noise(col * 0.05 + t * 0.08, row * 0.09 - t * 0.05);

          let excite = 0;
          const pd = Math.hypot(x - pointer.x, y - pointer.y);
          if (pd < 120) excite = 1 - pd / 120;
          for (const rp of live) {
            const age = t - rp.t;
            const ring = Math.abs(Math.hypot(x - rp.x, y - rp.y) - age * RIPPLE_SPEED);
            if (ring < 22) excite = Math.max(excite, (1 - ring / 22) * (1 - age / RIPPLE_LIFE));
          }

          if (m > 0.3) {
            // Inside the headline: the doc's own text, scrolling through.
            const ch = TEXT_AT + ((i + scroll) % text.length);
            if (text[ch - TEXT_AT] === " ") {
              // Word gaps become dim fill so the letterform stays solid.
              glyph[i] = SCRAMBLE_AT;
              bucket[i] = Math.min(top, 2 + Math.round(excite * 2));
            } else {
              glyph[i] = ch;
              const v = 0.6 + 0.3 * m + 0.2 * n + 0.4 * excite;
              bucket[i] = Math.min(top, Math.max(3, Math.round(v * top)));
            }
            if (excite > 0.5 && hash(i, scroll) < 0.4) glyph[i] = SCRAMBLE_AT + Math.floor(hash(i, scroll + 7) * SCRAMBLE.length);
          } else if (excite > 0.05 && hash(i, scroll) < excite) {
            glyph[i] = SCRAMBLE_AT + Math.floor(hash(i, scroll + 3) * SCRAMBLE.length);
            bucket[i] = Math.min(top, 1 + Math.round(excite * (top - 1)));
          } else {
            const v = Math.pow(n, 2.6);
            const g = Math.floor(v * FIELD.length);
            glyph[i] = FIELD_AT + Math.min(FIELD.length - 1, g);
            bucket[i] = v > 0.55 ? 1 : 0;
          }
        }
      }

      ctx.clearRect(0, 0, w, h);
      ctx.font = `${fontPx}px 'DM Mono', ui-monospace, monospace`;
      ctx.textBaseline = "middle";
      for (let k = 0; k <= top; k++) {
        ctx.fillStyle = pal[k];
        for (let i = 0; i < glyph.length; i++) {
          if (bucket[i] !== k || glyph[i] === FIELD_AT) continue;
          const col = i % cols;
          const row = (i - col) / cols;
          ctx.fillText(glyphs[glyph[i]], col * cw, (row + 0.5) * lineH);
        }
      }
    };

    const loop = (ts: number) => {
      raf = 0;
      if (!visible || document.hidden) return;
      if (ts - last >= 1000 / FPS) {
        last = ts;
        draw(now());
      }
      raf = requestAnimationFrame(loop);
    };
    const kick = () => { if (!reduced && !raf) raf = requestAnimationFrame(loop); };

    const onMove = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      pointer.x = e.clientX - r.left;
      pointer.y = e.clientY - r.top;
    };
    const onLeave = () => { pointer.x = pointer.y = -1e4; };
    const onDown = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      if (e.clientY < r.top || e.clientY > r.bottom) return;
      ripples.push({ x: e.clientX - r.left, y: e.clientY - r.top, t: now() });
    };
    const host = canvas.parentElement!;
    if (!reduced) {
      host.addEventListener("pointermove", onMove);
      host.addEventListener("pointerleave", onLeave);
      host.addEventListener("pointerdown", onDown);
    }

    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    const io = new IntersectionObserver(([e]) => {
      visible = e.isIntersecting;
      if (visible) kick();
    });
    io.observe(canvas);
    const onVis = () => { if (!document.hidden) kick(); };
    document.addEventListener("visibilitychange", onVis);
    // The mask and glyph advance both depend on webfonts.
    document.fonts?.ready.then(resize).catch(() => {});
    kick();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      host.removeEventListener("pointermove", onMove);
      host.removeEventListener("pointerleave", onLeave);
      host.removeEventListener("pointerdown", onDown);
    };
  }, [source, paletteKey, textRoot]);

  return <canvas ref={ref} className={className} aria-hidden="true" />;
}
