// /test/animations variant: Cursor Spotlight
// A bright Ink-gradient comet that follows the mouse: a warm gold head glow
// with pink and blue trailing glows lagging behind it, revealing a dot grid
// near the light — revealed dots grow and warm up toward the centre. Lively
// wandering drift when the pointer is absent or idle (e.g. touch devices).
//
// Contract: default-export a component that renders a background layer
// (position: fixed, inset: 0, z-index: 0, pointer-events: none,
// aria-hidden). The harness may confine the layer to one landing section
// via a clipped, transformed wrapper (which becomes the fixed-position
// containing block), so measure the canvas element itself, not the window.
// Respect prefers-reduced-motion (render static or nothing) and clean up
// rAF/listeners on unmount.
import { useEffect, useRef } from "react";

// ---- Tuning knobs -----------------------------------------------------------
const DOT_SPACING = 26; // px between grid dots
const DOT_RADIUS = 1.1; // px, resting dot radius
const BASE_ALPHA = 0.055; // dot opacity far from the light
const REVEAL_ALPHA = 0.42; // extra dot opacity at the spotlight centre
const REVEAL_SCALE = 1.4; // extra radius multiple at the centre (~2.4x total)
const SPOTLIGHT_RADIUS = 360; // px, how far the grid reveal reaches

// The comet: head + trailing glows. Lower `ease` = lags further behind.
// Drawn additively, so overlaps bloom where the comet doubles back.
const GLOWS = [
  { radius: 480, alpha: 0.14, ease: 5.5, rgb: [255, 210, 77] }, // gold head
  { radius: 320, alpha: 0.11, ease: 2.4, rgb: [237, 94, 190] }, // pink middle
  { radius: 230, alpha: 0.09, ease: 1.2, rgb: [71, 180, 235] }, // blue tail
];
const CORE_RADIUS = 110; // px, hot white-gold core at the head
const CORE_ALPHA = 0.2;

const IDLE_AFTER_MS = 3000; // no pointer movement for this long -> drift
const DRIFT_X_HZ = 0.045; // idle wander frequencies (cycles/s)
const DRIFT_Y_HZ = 0.033;
const DRIFT_WOBBLE_HZ = 0.11; // secondary wobble layered on the wander
const DOT_RGB: [number, number, number] = [232, 228, 222]; // #e8e4de
const HOT_RGB: [number, number, number] = [255, 236, 180]; // warm centre tint
const TINT_STEPS = 9; // dot colour LUT resolution (grey -> warm gold)
const MAX_DPR = 2;
// -----------------------------------------------------------------------------

export default function CursorSpotlightBackground() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    const epoch = performance.now();
    const TAU = Math.PI * 2;

    // Dot colour LUT: base grey -> warm near-white, indexed by reveal falloff.
    const tints: string[] = [];
    for (let i = 0; i < TINT_STEPS; i++) {
      const k = i / (TINT_STEPS - 1);
      const r = Math.round(DOT_RGB[0] + (HOT_RGB[0] - DOT_RGB[0]) * k);
      const g = Math.round(DOT_RGB[1] + (HOT_RGB[1] - DOT_RGB[1]) * k);
      const b = Math.round(DOT_RGB[2] + (HOT_RGB[2] - DOT_RGB[2]) * k);
      tints.push(`rgb(${r},${g},${b})`);
    }

    let raf = 0;
    let running = false;
    let last = 0;
    let width = 0;
    let height = 0;

    const pointer = { x: 0, y: 0, seen: false, lastMove: 0 };
    // One eased position per glow (head first).
    const posList = GLOWS.map(() => ({ x: 0, y: 0 }));
    let posInit = false;

    const paintGlow = (
      x: number,
      y: number,
      radius: number,
      alpha: number,
      rgb: number[],
    ) => {
      const g = ctx.createRadialGradient(x, y, 0, x, y, radius);
      g.addColorStop(0, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`);
      g.addColorStop(0.55, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha * 0.35})`);
      g.addColorStop(1, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0)`);
      ctx.fillStyle = g;
      ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
    };

    const drawScene = () => {
      ctx.clearRect(0, 0, width, height);

      // Comet glows, tail-first so the gold head sits on top, all additive.
      ctx.globalCompositeOperation = "lighter";
      for (let i = GLOWS.length - 1; i >= 0; i--) {
        const glow = GLOWS[i];
        const p = posList[i];
        paintGlow(p.x, p.y, glow.radius, glow.alpha, glow.rgb);
      }
      // Hot core at the head.
      const head = posList[0];
      paintGlow(head.x, head.y, CORE_RADIUS, CORE_ALPHA, [255, 244, 214]);
      ctx.globalCompositeOperation = "source-over";

      // Dot grid, revealed near the head: brighter, bigger, warmer.
      const r2 = SPOTLIGHT_RADIUS * SPOTLIGHT_RADIUS;
      const offsetX = ((width % DOT_SPACING) / 2 + DOT_SPACING) % DOT_SPACING;
      const offsetY = ((height % DOT_SPACING) / 2 + DOT_SPACING) % DOT_SPACING;

      for (let y = offsetY; y <= height; y += DOT_SPACING) {
        const dy = y - head.y;
        for (let x = offsetX; x <= width; x += DOT_SPACING) {
          const dx = x - head.x;
          const d2 = dx * dx + dy * dy;
          let falloff = 0;
          if (d2 < r2) {
            const f = 1 - Math.sqrt(d2) / SPOTLIGHT_RADIUS;
            falloff = f * f;
          }
          const r = DOT_RADIUS * (1 + REVEAL_SCALE * falloff);
          ctx.fillStyle =
            tints[Math.min(TINT_STEPS - 1, Math.round(falloff * (TINT_STEPS - 1)))];
          ctx.globalAlpha = BASE_ALPHA + REVEAL_ALPHA * falloff;
          ctx.fillRect(x - r, y - r, r * 2, r * 2);
        }
      }
      ctx.globalAlpha = 1;
    };

    const drawStatic = () => {
      // Reduced motion: one calm frame, comet parked near the hero copy.
      for (const p of posList) {
        p.x = width * 0.5;
        p.y = height * 0.38;
      }
      drawScene();
    };

    const tick = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;

      const idle = !pointer.seen || now - pointer.lastMove > IDLE_AFTER_MS;
      const t = (now - epoch) / 1000;
      const tx = idle
        ? width *
          (0.5 +
            0.3 * Math.sin(TAU * DRIFT_X_HZ * t) +
            0.06 * Math.sin(TAU * DRIFT_WOBBLE_HZ * t + 0.9))
        : pointer.x;
      const ty = idle
        ? height *
          (0.42 +
            0.25 * Math.sin(TAU * DRIFT_Y_HZ * t + 1.7) +
            0.05 * Math.sin(TAU * DRIFT_WOBBLE_HZ * 0.8 * t))
        : pointer.y;

      // Each glow chases the target at its own rate -> comet stretch.
      for (let i = 0; i < GLOWS.length; i++) {
        const p = posList[i];
        const k = 1 - Math.exp(-dt * GLOWS[i].ease);
        p.x += (tx - p.x) * k;
        p.y += (ty - p.y) * k;
      }

      drawScene();
      raf = requestAnimationFrame(tick);
    };

    const start = () => {
      if (running || mql.matches || document.hidden) return;
      running = true;
      last = performance.now();
      raf = requestAnimationFrame(tick);
    };

    const stop = () => {
      if (running) cancelAnimationFrame(raf);
      running = false;
    };

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      width = canvas.clientWidth || window.innerWidth;
      height = canvas.clientHeight || window.innerHeight;
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (!posInit) {
        for (const p of posList) {
          p.x = width * 0.5;
          p.y = height * 0.42;
        }
        posInit = true;
      }
      if (!running) drawStatic();
    };

    const onPointerMove = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      pointer.x = e.clientX - rect.left;
      pointer.y = e.clientY - rect.top;
      pointer.seen = true;
      pointer.lastMove = performance.now();
    };

    const onVisibility = () => {
      if (document.hidden) {
        stop();
      } else {
        start();
      }
    };

    const onMotionChange = () => {
      if (mql.matches) {
        stop();
        drawStatic(); // parked, no cursor following
      } else {
        start();
      }
    };

    resize();
    window.addEventListener("resize", resize);
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    document.addEventListener("visibilitychange", onVisibility);
    mql.addEventListener("change", onMotionChange);
    if (mql.matches) {
      drawStatic();
    } else {
      start();
    }

    return () => {
      stop();
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", onPointerMove);
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
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        display: "block",
      }}
    />
  );
}
