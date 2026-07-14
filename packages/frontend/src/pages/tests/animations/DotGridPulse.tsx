// /test/animations variant: Dot Grid Pulse
// A graph-paper dot grid swept by two crossing luminous waves that flare
// the dots with additive Ink-gradient glow (gold -> pink -> blue across the
// band), plus an occasional radial "ping" wave expanding from a random point.
//
// Contract: default-export a component that renders a full-viewport
// background layer (position: fixed, inset: 0, z-index: 0,
// pointer-events: none, aria-hidden). Respect prefers-reduced-motion
// (render static or nothing) and clean up rAF/listeners on unmount.
import { useEffect, useRef } from "react";

// ---- Tuning knobs -----------------------------------------------------------
const DOT_SPACING = 26; // px between grid dots
const DOT_RADIUS = 1.2; // px, resting dot radius
const BASE_ALPHA = 0.14; // resting dot opacity — geometry always visible
const BASE_RGB = "232, 228, 222"; // #e8e4de

// Two crossing waves (angle radians from horizontal, speed px/s, width px,
// alpha = flare contribution at the crest).
const WAVES = [
  { angle: Math.PI / 7, speed: 95, width: 230, alpha: 0.55 },
  { angle: -Math.PI / 3.2, speed: 62, width: 300, alpha: 0.38 },
];
const WAVE_REST = 1.12; // >1 adds a little quiet time between passes

// Radial ping — an expanding ring from a random point.
const PING_MIN_GAP = 4000; // ms between pings (randomized in this range)
const PING_MAX_GAP = 8000;
const PING_SPEED = 280; // px/s ring expansion
const PING_WIDTH = 110; // px ring softness
const PING_ALPHA = 0.6; // flare contribution at the ring crest

// Glow sprites (pre-rendered, drawn additively — no per-dot shadowBlur).
const GLOW_SIZE_BASE = 8; // px glow radius as flare begins
const GLOW_SIZE_GAIN = 22; // extra px glow radius at full flare
const GLOW_ALPHA = 0.9; // sprite opacity at full flare
const GLOW_STOPS = 14; // sprites pre-rendered along the Ink gradient
const CORE_ALPHA_GAIN = 0.6; // extra core-dot opacity at full flare (peaks ~0.74)
const MAX_DPR = 2;
// -----------------------------------------------------------------------------

type Ink = [number, number, number];
const GOLD: Ink = [255, 210, 77]; // hsl(45 100% 65%)
const PINK: Ink = [237, 94, 190]; // hsl(320 80% 65%)
const BLUE: Ink = [71, 180, 235]; // hsl(200 80% 60%)

const lerpc = (a: number, b: number, k: number) => Math.round(a + (b - a) * k);

const mixInk = (t: number): Ink => {
  if (t < 0.5) {
    const k = t * 2;
    return [
      lerpc(GOLD[0], PINK[0], k),
      lerpc(GOLD[1], PINK[1], k),
      lerpc(GOLD[2], PINK[2], k),
    ];
  }
  const k = t * 2 - 1;
  return [
    lerpc(PINK[0], BLUE[0], k),
    lerpc(PINK[1], BLUE[1], k),
    lerpc(PINK[2], BLUE[2], k),
  ];
};

const makeGlowSprite = (rgb: Ink, size: number): HTMLCanvasElement => {
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const g = c.getContext("2d");
  if (g) {
    const half = size / 2;
    const grad = g.createRadialGradient(half, half, 0, half, half, half);
    grad.addColorStop(0, "rgba(255,255,255,0.95)");
    grad.addColorStop(0.16, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.85)`);
    grad.addColorStop(0.45, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.3)`);
    grad.addColorStop(1, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
  }
  return c;
};

export default function DotGridPulseBackground() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    const epoch = performance.now();

    // Pre-render one glow sprite per stop along the Ink gradient.
    const sprites: HTMLCanvasElement[] = [];
    for (let i = 0; i < GLOW_STOPS; i++) {
      sprites.push(makeGlowSprite(mixInk(i / (GLOW_STOPS - 1)), 64));
    }

    const waves = WAVES.map((w) => ({
      ...w,
      cos: Math.cos(w.angle),
      sin: Math.sin(w.angle),
    }));

    let raf = 0;
    let running = false;
    let width = 0;
    let height = 0;
    let ping: { x: number; y: number; born: number } | null = null;
    let nextPingAt =
      epoch + 1200 + Math.random() * (PING_MAX_GAP - PING_MIN_GAP);

    // Scratch list of flaring dots for the additive pass: x, y, flare, hue.
    const flares: number[] = [];

    const maxPingR = () => Math.hypot(width, height) * 0.7;

    const draw = (elapsedMs: number, staticFrame: boolean) => {
      ctx.clearRect(0, 0, width, height);
      flares.length = 0;

      // Per-wave crest position along its travel axis.
      const crests = waves.map((w) => {
        const xs = width * w.cos;
        const ys = height * w.sin;
        const pMin = Math.min(0, xs, ys, xs + ys);
        const pMax = Math.max(0, xs, ys, xs + ys);
        const period = (pMax - pMin + 4 * w.width) * WAVE_REST;
        const pos = staticFrame
          ? pMin + (pMax - pMin) * (w.angle > 0 ? 0.42 : 0.68)
          : pMin - 2 * w.width + (((elapsedMs / 1000) * w.speed) % period);
        return { ...w, pos, cutoff: w.width * 2.5 };
      });

      // Active ping ring.
      let ringR = 0;
      let ringFade = 0;
      let ringHue = 0;
      const p = staticFrame ? null : ping;
      if (p) {
        ringR = ((epoch + elapsedMs - p.born) / 1000) * PING_SPEED;
        const lifeFade = Math.max(0, 1 - ringR / maxPingR());
        ringFade = Math.min(1, ringR / 120) * lifeFade;
        ringHue = 1 - lifeFade; // gold when young -> blue as it expands
      }

      const offsetX = ((width % DOT_SPACING) / 2 + DOT_SPACING) % DOT_SPACING;
      const offsetY = ((height % DOT_SPACING) / 2 + DOT_SPACING) % DOT_SPACING;

      // Pass 1: base dots (+ flare-brightened cores), collect flares.
      ctx.fillStyle = `rgb(${BASE_RGB})`;
      for (let y = offsetY; y <= height; y += DOT_SPACING) {
        for (let x = offsetX; x <= width; x += DOT_SPACING) {
          let flare = 0;
          let hueAcc = 0;
          let hueW = 0;

          for (const w of crests) {
            const d = x * w.cos + y * w.sin - w.pos;
            if (d > -w.cutoff && d < w.cutoff) {
              const a = w.alpha * Math.exp(-(d * d) / (w.width * w.width));
              flare += a;
              hueAcc +=
                a * Math.min(1, Math.max(0, 0.5 + d / (2.2 * w.width)));
              hueW += a;
            }
          }
          if (p && ringFade > 0.01) {
            const dx = x - p.x;
            const dy = y - p.y;
            const dd = Math.sqrt(dx * dx + dy * dy) - ringR;
            if (dd > -PING_WIDTH * 2.5 && dd < PING_WIDTH * 2.5) {
              const a =
                PING_ALPHA *
                ringFade *
                Math.exp(-(dd * dd) / (PING_WIDTH * PING_WIDTH));
              flare += a;
              hueAcc += a * ringHue;
              hueW += a;
            }
          }

          if (flare > 1) flare = 1;
          const r = DOT_RADIUS + flare * 1.6;
          ctx.globalAlpha = Math.min(0.85, BASE_ALPHA + flare * CORE_ALPHA_GAIN);
          ctx.fillRect(x - r, y - r, r * 2, r * 2);

          if (flare > 0.04) {
            flares.push(x, y, flare, hueW > 0 ? hueAcc / hueW : 0.5);
          }
        }
      }

      // Pass 2: additive glow sprites over the flaring dots.
      ctx.globalCompositeOperation = "lighter";
      for (let i = 0; i < flares.length; i += 4) {
        const x = flares[i];
        const y = flares[i + 1];
        const f = flares[i + 2];
        const hue = flares[i + 3];
        const gr = GLOW_SIZE_BASE + GLOW_SIZE_GAIN * f;
        const sprite =
          sprites[Math.min(GLOW_STOPS - 1, Math.round(hue * (GLOW_STOPS - 1)))];
        ctx.globalAlpha = GLOW_ALPHA * f;
        ctx.drawImage(sprite, x - gr, y - gr, gr * 2, gr * 2);
      }
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
    };

    const tick = (now: number) => {
      if (!ping && now >= nextPingAt) {
        ping = {
          x: width * (0.15 + 0.7 * Math.random()),
          y: height * (0.15 + 0.7 * Math.random()),
          born: now,
        };
      }
      if (ping && ((now - ping.born) / 1000) * PING_SPEED > maxPingR()) {
        ping = null;
        nextPingAt =
          now + PING_MIN_GAP + Math.random() * (PING_MAX_GAP - PING_MIN_GAP);
      }
      draw(now - epoch, false);
      raf = requestAnimationFrame(tick);
    };

    const start = () => {
      if (running || mql.matches || document.hidden) return;
      running = true;
      raf = requestAnimationFrame(tick);
    };

    const stop = () => {
      if (running) cancelAnimationFrame(raf);
      running = false;
    };

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (!running) draw(0, true);
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
        draw(0, true); // static frame with frozen crests
      } else {
        start();
      }
    };

    resize();
    window.addEventListener("resize", resize);
    document.addEventListener("visibilitychange", onVisibility);
    mql.addEventListener("change", onMotionChange);
    if (mql.matches) {
      draw(0, true);
    } else {
      start();
    }

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
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        display: "block",
      }}
    />
  );
}
