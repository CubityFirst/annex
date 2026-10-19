import { useEffect, useRef, type ReactNode } from "react";
import { GLYPH_FONT, MONO, buildTextMask, gridMetrics, noise, prefersReducedMotion, runLoop } from "./ascii";

// A stable-fluids simulation (Stam: semi-Lagrangian advection + Gauss-Seidel
// pressure projection) run directly on the character grid. Density picks a
// glyph from a ramp; thin, fast-moving regions switch to directional glyphs
// (- / | \) so the flow lines read. The pointer stirs it, three slow
// wandering emitters keep it alive, and the real DOM headline is rasterised
// into an obstacle mask so the smoke parts around the words.

const RAMP = " .:-=+*#%@";
const DIRS = ["-", "\\", "|", "/"];
const ITER = 14;
const DECAY = 0.988;

type Props = { title: ReactNode; children: ReactNode };

export function AsciiFluid({ title, children }: Props) {
  const section = useRef<HTMLElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const titleRoot = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const sec = section.current;
    const cv = canvas.current;
    const ctx = cv?.getContext("2d");
    if (!sec || !cv || !ctx) return;
    const reduced = prefersReducedMotion();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    let w = 0, h = 0, W = 0, H = 0, cw = 6, lineH = 11, fontPx = 10;
    let u = new Float32Array(0), v = u, u0 = u, v0 = u, d = u, d0 = u;
    let solid = new Uint8Array(0);
    let solidIdx = new Int32Array(0);
    const IX = (x: number, y: number) => x + (W + 2) * y;
    const pointer = { x: -1, y: -1, px: -1, py: -1, active: false };

    const resize = () => {
      const r = cv.getBoundingClientRect();
      w = r.width; h = r.height;
      cv.width = Math.max(1, Math.round(w * dpr));
      cv.height = Math.max(1, Math.round(h * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const m = gridMetrics(ctx, w, h);
      ({ fontPx, lineH, cw } = m);
      W = m.cols; H = m.rows;
      const size = (W + 2) * (H + 2);
      u = new Float32Array(size); v = new Float32Array(size);
      u0 = new Float32Array(size); v0 = new Float32Array(size);
      d = new Float32Array(size); d0 = new Float32Array(size);
      // Obstacle = the headline, dilated by a cell so glyphs never touch it.
      const mask = buildTextMask(titleRoot.current, r, W, H, cw, lineH);
      solid = new Uint8Array(size);
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
          if (mask[y * W + x] < 0.2) continue;
          for (let oy = -1; oy <= 1; oy++)
            for (let ox = -1; ox <= 1; ox++) solid[IX(x + 1 + ox, y + 1 + oy)] = 1;
        }
      // Copy blocks marked data-ascii-solid are rectangular obstacles.
      sec.querySelectorAll<HTMLElement>("[data-ascii-solid]").forEach((el) => {
        const b = el.getBoundingClientRect();
        const x0 = Math.max(1, Math.floor((b.left - r.left) / cw)), x1 = Math.min(W, Math.ceil((b.right - r.left) / cw) + 1);
        const y0 = Math.max(1, Math.floor((b.top - r.top) / lineH)), y1 = Math.min(H, Math.ceil((b.bottom - r.top) / lineH) + 1);
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) solid[IX(x, y)] = 1;
      });
      const idx: number[] = [];
      solid.forEach((on, i) => { if (on) idx.push(i); });
      solidIdx = Int32Array.from(idx);
      if (reduced) {
        for (let i = 0; i < 160; i++) step(i / 30);
        draw();
      }
    };

    const bound = (b: number, x: Float32Array) => {
      for (let i = 1; i <= H; i++) {
        x[IX(0, i)] = b === 1 ? -x[IX(1, i)] : x[IX(1, i)];
        x[IX(W + 1, i)] = b === 1 ? -x[IX(W, i)] : x[IX(W, i)];
      }
      for (let i = 1; i <= W; i++) {
        x[IX(i, 0)] = b === 2 ? -x[IX(i, 1)] : x[IX(i, 1)];
        x[IX(i, H + 1)] = b === 2 ? -x[IX(i, H)] : x[IX(i, H)];
      }
      for (let k = 0; k < solidIdx.length; k++) x[solidIdx[k]] = 0;
    };

    const advect = (b: number, dst: Float32Array, src: Float32Array, uu: Float32Array, vv: Float32Array, dt: number) => {
      for (let j = 1; j <= H; j++)
        for (let i = 1; i <= W; i++) {
          let x = i - dt * uu[IX(i, j)];
          let y = j - dt * vv[IX(i, j)];
          x = Math.min(W + 0.5, Math.max(0.5, x));
          y = Math.min(H + 0.5, Math.max(0.5, y));
          const i0 = Math.floor(x), j0 = Math.floor(y);
          const s1 = x - i0, t1 = y - j0;
          dst[IX(i, j)] =
            (1 - s1) * ((1 - t1) * src[IX(i0, j0)] + t1 * src[IX(i0, j0 + 1)]) +
            s1 * ((1 - t1) * src[IX(i0 + 1, j0)] + t1 * src[IX(i0 + 1, j0 + 1)]);
        }
      bound(b, dst);
    };

    const project = (uu: Float32Array, vv: Float32Array, p: Float32Array, div: Float32Array) => {
      for (let j = 1; j <= H; j++)
        for (let i = 1; i <= W; i++) {
          div[IX(i, j)] = -0.5 * (uu[IX(i + 1, j)] - uu[IX(i - 1, j)] + vv[IX(i, j + 1)] - vv[IX(i, j - 1)]);
          p[IX(i, j)] = 0;
        }
      bound(0, div); bound(0, p);
      for (let k = 0; k < ITER; k++) {
        for (let j = 1; j <= H; j++)
          for (let i = 1; i <= W; i++)
            p[IX(i, j)] = (div[IX(i, j)] + p[IX(i - 1, j)] + p[IX(i + 1, j)] + p[IX(i, j - 1)] + p[IX(i, j + 1)]) / 4;
        bound(0, p);
      }
      for (let j = 1; j <= H; j++)
        for (let i = 1; i <= W; i++) {
          uu[IX(i, j)] -= 0.5 * (p[IX(i + 1, j)] - p[IX(i - 1, j)]);
          vv[IX(i, j)] -= 0.5 * (p[IX(i, j + 1)] - p[IX(i, j - 1)]);
        }
      bound(1, uu); bound(2, vv);
    };

    const splat = (cx: number, cy: number, fx: number, fy: number, amount: number, rad: number) => {
      const r2 = rad * rad;
      for (let y = Math.max(1, Math.floor(cy - rad)); y <= Math.min(H, Math.ceil(cy + rad)); y++)
        for (let x = Math.max(1, Math.floor(cx - rad)); x <= Math.min(W, Math.ceil(cx + rad)); x++) {
          const dd = (x - cx) * (x - cx) + (y - cy) * (y - cy) * 2.6;
          if (dd > r2) continue;
          const f = 1 - dd / r2;
          const i = IX(x, y);
          u[i] += fx * f; v[i] += fy * f; d[i] += amount * f;
        }
    };

    const step = (t: number) => {
      const dt = 1;
      // Wandering emitters keep the field moving with nobody touching it.
      for (let e = 0; e < 3; e++) {
        const ex = (0.15 + 0.7 * noise(e * 7.1, t * 0.05)) * W;
        const ey = (0.2 + 0.6 * noise(e * 3.3 + 20, t * 0.05)) * H;
        const a = noise(e * 5.7 + 40, t * 0.12) * Math.PI * 4;
        splat(ex, ey, Math.cos(a) * 0.9, Math.sin(a) * 0.45, 0.35, 3.2);
      }
      if (pointer.active) {
        const dx = pointer.x - pointer.px, dy = pointer.y - pointer.py;
        splat(pointer.x, pointer.y, dx * 0.9, dy * 0.9, 0.8 + Math.min(1.5, Math.hypot(dx, dy) * 0.15), 4.5);
        pointer.px = pointer.x; pointer.py = pointer.y;
      }
      u0.set(u); v0.set(v);
      advect(1, u, u0, u0, v0, dt);
      advect(2, v, v0, u0, v0, dt);
      project(u, v, u0, v0);
      for (let i = 0; i < u.length; i++) { u[i] *= 0.993; v[i] *= 0.993; }
      d0.set(d);
      advect(0, d, d0, u, v, dt);
      for (let i = 0; i < d.length; i++) d[i] *= DECAY;
    };

    const draw = () => {
      ctx.clearRect(0, 0, w, h);
      ctx.font = `${fontPx}px ${GLYPH_FONT}`;
      ctx.textBaseline = "middle";
      const buckets: number[][] = MONO.map(() => []);
      const glyph: string[] = new Array(W * H);
      for (let y = 1; y <= H; y++)
        for (let x = 1; x <= W; x++) {
          const i = IX(x, y);
          const dn = Math.min(1, d[i]);
          if (dn < 0.04 || solid[i]) continue;
          const sp = Math.hypot(u[i], v[i]);
          let ch: string;
          if (dn < 0.32 && sp > 0.25) {
            const ang = Math.atan2(-v[i], u[i]);
            ch = DIRS[((Math.round(ang / (Math.PI / 4)) % 4) + 4) % 4];
          } else {
            ch = RAMP[Math.min(RAMP.length - 1, 1 + Math.floor(dn * (RAMP.length - 1)))];
          }
          const k = Math.min(MONO.length - 1, 1 + Math.floor(Math.pow(dn, 0.7) * (MONO.length - 1)));
          const g = (y - 1) * W + (x - 1);
          glyph[g] = ch;
          buckets[k].push(g);
        }
      for (let k = 1; k < MONO.length; k++) {
        ctx.fillStyle = MONO[k];
        for (const g of buckets[k]) ctx.fillText(glyph[g], (g % W) * cw, (Math.floor(g / W) + 0.5) * lineH);
      }
    };

    const onMove = (e: PointerEvent) => {
      const r = cv.getBoundingClientRect();
      const x = (e.clientX - r.left) / cw + 1, y = (e.clientY - r.top) / lineH + 1;
      if (!pointer.active) { pointer.px = x; pointer.py = y; }
      pointer.x = x; pointer.y = y; pointer.active = true;
    };
    const onLeave = () => { pointer.active = false; };

    const ro = new ResizeObserver(resize);
    ro.observe(cv);
    document.fonts?.ready.then(resize).catch(() => {});
    if (reduced) return () => ro.disconnect();

    sec.addEventListener("pointermove", onMove);
    sec.addEventListener("pointerleave", onLeave);
    const stop = runLoop(cv, 40, (t) => { step(t); draw(); });
    return () => {
      stop();
      ro.disconnect();
      sec.removeEventListener("pointermove", onMove);
      sec.removeEventListener("pointerleave", onLeave);
    };
  }, []);

  return (
    <section ref={section} className="th-hero th-fluid">
      <canvas ref={canvas} className="th-hero-bg" aria-hidden="true" />
      <div className="site-wrap th-fluid-inner">
        <div ref={titleRoot}>{title}</div>
        {children}
      </div>
    </section>
  );
}
