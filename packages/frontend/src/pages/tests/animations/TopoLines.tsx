// /test/animations variant: Topographic Lines
// Topographic contour lines undulating like a living map. Marching-squares
// contours over a time-varying 3D value-noise field sampled on a coarse
// grid. Intense pass: brighter contours, faster undulation + lateral drift,
// two iso-levels highlighted in Annex Ink hues with a layered-stroke glow,
// and an "elevation scan" — a sweeping threshold whose glowing pink contour
// travels across the terrain.
//
// Contract: default-export a component that renders a background layer
// (position: fixed, inset: 0, z-index: 0, pointer-events: none,
// aria-hidden). The harness may confine the layer to one landing section
// via a clipped, transformed wrapper (which becomes the fixed-position
// containing block), so measure the canvas element itself, not the window.
// Respect prefers-reduced-motion (render static or nothing) and clean up
// rAF/listeners on unmount.
import { useEffect, useRef } from "react";

// --- Tuning knobs -----------------------------------------------------------
const CELL = 44; // noise-grid cell size, px (bigger = cheaper + smoother)
const BASE_LEVELS = [0.26, 0.32, 0.44, 0.5, 0.56, 0.68, 0.74]; // off-white contours
const BASE_ALPHA = 0.16; // base contour opacity
const NOISE_SCALE = 1 / 230; // px -> noise units (smaller = broader features)
const OCTAVE2_WEIGHT = 0.35; // detail octave contribution
const TIME_SPEED = 0.09; // noise-z units per second (undulation speed)
const FIELD_DRIFT = 11; // px/s lateral drift of the whole field
const RENDER_EVERY = 2; // recompute contours every N animation frames
// Highlighted iso-levels, drawn hue-colored with a layered-stroke glow.
const GOLD = "255, 210, 77"; // hsl(45 100% 65%)
const BLUE = "71, 180, 235"; // hsl(200 80% 60%)
const PINK = "237, 94, 190"; // hsl(320 80% 65%)
const HIGHLIGHTS: { level: number; rgb: string }[] = [
  { level: 0.38, rgb: GOLD },
  { level: 0.62, rgb: BLUE },
];
const HIGHLIGHT_ALPHA = 0.32;
const HIGHLIGHT_WIDTH = 1.6;
const HIGHLIGHT_GLOW_ALPHA = 0.09;
const HIGHLIGHT_GLOW_WIDTH = 5;
// Elevation scan: a threshold that sweeps up and down through the terrain,
// so a bright contour visibly travels across the map.
const SCAN_RGB = PINK;
const SCAN_CENTER = 0.5;
const SCAN_RANGE = 0.26; // sweeps SCAN_CENTER +/- SCAN_RANGE
const SCAN_SPEED = 0.45; // rad/s of the sweep oscillation (~14s round trip)
const SCAN_ALPHA = 0.5;
const SCAN_WIDTH = 1.8;
const SCAN_GLOW_ALPHA = 0.13;
const SCAN_GLOW_WIDTH = 7;
const INK_RGB = "232, 228, 222"; // #e8e4de
const MAX_DPR = 2;
// ----------------------------------------------------------------------------

function fade(t: number): number {
  return t * t * (3 - 2 * t);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function hash3(x: number, y: number, z: number): number {
  let hsh = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(z, 0x9e3779b1);
  hsh = Math.imul(hsh ^ (hsh >>> 15), 0x85ebca6b);
  hsh = Math.imul(hsh ^ (hsh >>> 13), 0xc2b2ae35);
  hsh ^= hsh >>> 16;
  return (hsh >>> 0) / 4294967296;
}

function valueNoise3(x: number, y: number, z: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const u = fade(x - xi);
  const v = fade(y - yi);
  const s = fade(z - zi);
  const n000 = hash3(xi, yi, zi);
  const n100 = hash3(xi + 1, yi, zi);
  const n010 = hash3(xi, yi + 1, zi);
  const n110 = hash3(xi + 1, yi + 1, zi);
  const n001 = hash3(xi, yi, zi + 1);
  const n101 = hash3(xi + 1, yi, zi + 1);
  const n011 = hash3(xi, yi + 1, zi + 1);
  const n111 = hash3(xi + 1, yi + 1, zi + 1);
  return lerp(
    lerp(lerp(n000, n100, u), lerp(n010, n110, u), v),
    lerp(lerp(n001, n101, u), lerp(n011, n111, u), v),
    s,
  );
}

function sampleField(px: number, py: number, z: number): number {
  const n1 = valueNoise3(px * NOISE_SCALE, py * NOISE_SCALE, z);
  const n2 = valueNoise3(
    px * NOISE_SCALE * 2.15 + 13.7,
    py * NOISE_SCALE * 2.15 + 7.3,
    z * 1.7 + 5.1,
  );
  return (n1 + OCTAVE2_WEIGHT * n2) / (1 + OCTAVE2_WEIGHT);
}

export default function TopoLinesBackground() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    let rafId = 0;
    let running = false;
    let lastTime = 0;
    let time = 0; // accumulated seconds; freezes while hidden
    let frameCount = 0;
    let w = 0;
    let h = 0;
    let cols = 0;
    let rows = 0;
    let values = new Float32Array(0);

    const computeField = (t: number) => {
      const z = t * TIME_SPEED;
      const dx = t * FIELD_DRIFT;
      let idx = 0;
      for (let j = 0; j <= rows; j++) {
        const py = j * CELL;
        for (let i = 0; i <= cols; i++) {
          values[idx++] = sampleField(i * CELL + dx, py, z);
        }
      }
    };

    // Marching squares: emit contour segments for one iso-level into a path.
    const marchLevel = (L: number, path: Path2D) => {
      const stride = cols + 1;
      for (let j = 0; j < rows; j++) {
        const y0 = j * CELL;
        const y1 = y0 + CELL;
        for (let i = 0; i < cols; i++) {
          const x0 = i * CELL;
          const x1 = x0 + CELL;
          const a = values[j * stride + i] ?? 0; // top-left
          const b = values[j * stride + i + 1] ?? 0; // top-right
          const c = values[(j + 1) * stride + i + 1] ?? 0; // bottom-right
          const d = values[(j + 1) * stride + i] ?? 0; // bottom-left
          const code = (a > L ? 8 : 0) | (b > L ? 4 : 0) | (c > L ? 2 : 0) | (d > L ? 1 : 0);
          if (code === 0 || code === 15) continue;
          // Crossing points on each cell edge (only valid when straddled).
          const top = () => [x0 + (CELL * (L - a)) / (b - a), y0] as const;
          const right = () => [x1, y0 + (CELL * (L - b)) / (c - b)] as const;
          const bottom = () => [x0 + (CELL * (L - d)) / (c - d), y1] as const;
          const left = () => [x0, y0 + (CELL * (L - a)) / (d - a)] as const;
          const seg = (p: readonly [number, number], q: readonly [number, number]) => {
            path.moveTo(p[0], p[1]);
            path.lineTo(q[0], q[1]);
          };
          switch (code) {
            case 1:
              seg(left(), bottom());
              break;
            case 2:
              seg(bottom(), right());
              break;
            case 3:
              seg(left(), right());
              break;
            case 4:
              seg(top(), right());
              break;
            case 5: // ambiguous saddle — pick one pairing, fine at this scale
              seg(left(), top());
              seg(bottom(), right());
              break;
            case 6:
              seg(top(), bottom());
              break;
            case 7:
              seg(left(), top());
              break;
            case 8:
              seg(left(), top());
              break;
            case 9:
              seg(top(), bottom());
              break;
            case 10: // ambiguous saddle
              seg(top(), right());
              seg(left(), bottom());
              break;
            case 11:
              seg(top(), right());
              break;
            case 12:
              seg(left(), right());
              break;
            case 13:
              seg(bottom(), right());
              break;
            case 14:
              seg(left(), bottom());
              break;
            default:
              break;
          }
        }
      }
    };

    const render = () => {
      ctx.clearRect(0, 0, w, h);
      // Base contours: one path, one stroke.
      const base = new Path2D();
      for (const L of BASE_LEVELS) marchLevel(L, base);
      ctx.lineWidth = 1;
      ctx.strokeStyle = `rgba(${INK_RGB}, ${BASE_ALPHA})`;
      ctx.stroke(base);
      // Highlighted levels: wide faint pass under a narrow bright pass = glow.
      for (const hl of HIGHLIGHTS) {
        const p = new Path2D();
        marchLevel(hl.level, p);
        ctx.lineWidth = HIGHLIGHT_GLOW_WIDTH;
        ctx.strokeStyle = `rgba(${hl.rgb}, ${HIGHLIGHT_GLOW_ALPHA})`;
        ctx.stroke(p);
        ctx.lineWidth = HIGHLIGHT_WIDTH;
        ctx.strokeStyle = `rgba(${hl.rgb}, ${HIGHLIGHT_ALPHA})`;
        ctx.stroke(p);
      }
      // Elevation scan: sweeping threshold -> a contour that travels.
      const scanLevel = SCAN_CENTER + SCAN_RANGE * Math.sin(time * SCAN_SPEED);
      const scan = new Path2D();
      marchLevel(scanLevel, scan);
      ctx.lineWidth = SCAN_GLOW_WIDTH;
      ctx.strokeStyle = `rgba(${SCAN_RGB}, ${SCAN_GLOW_ALPHA})`;
      ctx.stroke(scan);
      ctx.lineWidth = SCAN_WIDTH;
      ctx.strokeStyle = `rgba(${SCAN_RGB}, ${SCAN_ALPHA})`;
      ctx.stroke(scan);
    };

    const renderNow = () => {
      computeField(time);
      render();
    };

    const frame = (now: number) => {
      rafId = requestAnimationFrame(frame);
      const dt = Math.min((now - lastTime) / 1000, 0.1);
      lastTime = now;
      time += dt;
      frameCount++;
      if (frameCount % RENDER_EVERY !== 0) return; // canvas keeps last frame
      renderNow();
    };

    const start = () => {
      if (running || mql.matches || document.hidden) return;
      running = true;
      lastTime = performance.now();
      rafId = requestAnimationFrame(frame);
    };

    const stop = () => {
      if (!running) return;
      running = false;
      cancelAnimationFrame(rafId);
    };

    const resize = () => {
      w = canvas.clientWidth || window.innerWidth;
      h = canvas.clientHeight || window.innerHeight;
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cols = Math.ceil(w / CELL);
      rows = Math.ceil(h / CELL);
      values = new Float32Array((cols + 1) * (rows + 1));
      renderNow(); // repaint now (doubles as static frame)
    };

    const onVisibility = () => {
      if (document.hidden) stop();
      else start();
    };

    const onMotionChange = () => {
      if (mql.matches) {
        stop();
        renderNow(); // freeze on a single static frame
      } else {
        start();
      }
    };

    resize();
    start();
    window.addEventListener("resize", resize);
    document.addEventListener("visibilitychange", onVisibility);
    mql.addEventListener("change", onMotionChange);

    return () => {
      stop();
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", onVisibility);
      mql.removeEventListener("change", onMotionChange);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 0,
        pointerEvents: "none",
        width: "100%",
        height: "100%",
      }}
    />
  );
}
