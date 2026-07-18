// /test/animations variant: Flow Field
// Perlin-ish flow-field streamlines — now comet-like: bright glowing
// heads with fading tails, colors drifting through the Annex Ink
// gradient (gold -> pink -> blue), a visibly swirling field, and
// occasional fast bright streaks. Canvas-based.
//
// Contract: default-export a component that renders a background layer
// (position: fixed, inset: 0, z-index: 0, pointer-events: none,
// aria-hidden). The harness may confine the layer to one landing section
// via a clipped, transformed wrapper (which becomes the fixed-position
// containing block), so measure the canvas element itself, not the window.
// Respect prefers-reduced-motion (render static or nothing) and clean up
// rAF/listeners on unmount.
import { useEffect, useRef, useState } from "react";

// ---- tuning knobs -----------------------------------------------------
// Annex Ink gradient stops: gold hsl(45 100% 65%), pink hsl(320 80% 65%),
// blue hsl(200 80% 60%).
const GRADIENT: [number, number, number][] = [
  [255, 210, 77], // gold
  [237, 94, 190], // pink
  [71, 180, 235], // blue
];
const LIGHTEN = 0.18; // 0..1 mix toward white, keeps hues airy on #0e0e0e
const SPRITE_STEPS = 12; // pre-rendered glow sprites across the gradient
const DENSITY = 1 / 16000; // streamlines per px^2 of viewport
const MIN_COUNT = 36;
const MAX_COUNT = 130;
const NOISE_SCALE = 0.0022; // spatial frequency of the field
const TIME_SCALE = 0.12; // how fast the field itself swirls
const ANGLE_RANGE = Math.PI * 4; // noise 0..1 maps to this many radians
const SPEED = 55; // px/s head advance
const TRAIL_MAX = 36; // points kept per streamline
const TAIL_ALPHA = 0.3; // alpha of the segment right behind the head
const HEAD_ALPHA = 0.6; // glow sprite alpha at the head
const HEAD_GLOW = 9; // px head halo radius
const LINE_WIDTH = 1.1;
const MIN_TTL = 4; // s, streamline lifetime
const MAX_TTL = 9;
const FADE_IN = 0.12; // fraction of ttl spent fading in
const FADE_OUT = 0.25; // fraction of ttl spent fading out
const HUE_DRIFT = 0.025; // gradient position drift per second
// streak flourish: occasional fast bright comets
const STREAK_CHANCE = 0.09; // probability a respawn becomes a streak
const STREAK_SPEED = 3.6; // speed multiplier
const STREAK_ALPHA = 1.9; // tail alpha multiplier (clamped at 0.85)
const STREAK_TTL_MIN = 0.9; // s
const STREAK_TTL_MAX = 1.7;
const STREAK_GLOW = 15; // px streak head halo radius
const STATIC_STEPS = 120; // pre-traced steps per line for reduced motion
// -----------------------------------------------------------------------

interface Stream {
  points: { x: number; y: number }[];
  age: number;
  ttl: number;
  colorT: number; // 0..1 position along the gradient
  streak: boolean;
}

// Deterministic 3D value noise (no deps): integer hash + trilinear blend.
function hash3(x: number, y: number, z: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 1440662683);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

function noise3(x: number, y: number, z: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const tx = smooth(x - xi);
  const ty = smooth(y - yi);
  const tz = smooth(z - zi);
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const c00 = lerp(hash3(xi, yi, zi), hash3(xi + 1, yi, zi), tx);
  const c10 = lerp(hash3(xi, yi + 1, zi), hash3(xi + 1, yi + 1, zi), tx);
  const c01 = lerp(hash3(xi, yi, zi + 1), hash3(xi + 1, yi, zi + 1), tx);
  const c11 = lerp(hash3(xi, yi + 1, zi + 1), hash3(xi + 1, yi + 1, zi + 1), tx);
  return lerp(lerp(c00, c10, ty), lerp(c01, c11, ty), tz);
}

function fieldAngle(x: number, y: number, t: number): number {
  const nx = x * NOISE_SCALE;
  const ny = y * NOISE_SCALE;
  const nz = t * TIME_SCALE;
  const n =
    noise3(nx, ny, nz) * 0.65 + noise3(nx * 2.03 + 31.4, ny * 2.03 + 47.7, nz * 2.03) * 0.35;
  return n * ANGLE_RANGE;
}

// Sample the gold -> pink -> blue gradient, lightened toward white.
function gradientRgb(t: number): [number, number, number] {
  const u = Math.min(1, Math.max(0, t)) * (GRADIENT.length - 1);
  const i = Math.min(GRADIENT.length - 2, Math.floor(u));
  const f = u - i;
  const a = GRADIENT[i];
  const b = GRADIENT[i + 1];
  const mix = (x: number, y: number) => {
    const v = x + (y - x) * f;
    return Math.round(v + (255 - v) * LIGHTEN);
  };
  return [mix(a[0], b[0]), mix(a[1], b[1]), mix(a[2], b[2])];
}

function makeGlowSprite(rgb: [number, number, number], size = 64): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const g = c.getContext("2d");
  if (g) {
    const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.85)`);
    grad.addColorStop(0.3, `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.32)`);
    grad.addColorStop(1, `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
  }
  return c;
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

export default function FlowFieldBackground() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const spriteColors = Array.from({ length: SPRITE_STEPS }, (_, i) =>
      gradientRgb(i / (SPRITE_STEPS - 1)),
    );
    const sprites = spriteColors.map((rgb) => makeGlowSprite(rgb));
    const spriteIndex = (t: number) =>
      Math.min(
        SPRITE_STEPS - 1,
        Math.max(0, Math.round(Math.min(1, Math.max(0, t)) * (SPRITE_STEPS - 1))),
      );

    let raf = 0;
    let running = false;
    let last = 0;
    let w = 0;
    let h = 0;
    let streams: Stream[] = [];

    const spawn = (s: Stream, now: number) => {
      const x = Math.random() * w;
      s.points = [{ x, y: Math.random() * h }];
      s.age = 0;
      s.streak = Math.random() < STREAK_CHANCE;
      s.ttl = s.streak
        ? STREAK_TTL_MIN + Math.random() * (STREAK_TTL_MAX - STREAK_TTL_MIN)
        : MIN_TTL + Math.random() * (MAX_TTL - MIN_TTL);
      // Color drifts across the viewport and slowly cycles over time.
      s.colorT = (x / Math.max(1, w) * 0.6 + now * HUE_DRIFT + Math.random() * 0.25) % 1;
    };

    const streamCount = () =>
      Math.max(MIN_COUNT, Math.min(MAX_COUNT, Math.round(w * h * DENSITY)));

    const seed = () => {
      streams = Array.from({ length: streamCount() }, () => {
        const s: Stream = { points: [], age: 0, ttl: 1, colorT: 0, streak: false };
        spawn(s, 0);
        // Stagger ages so lines don't all fade in unison on load.
        s.age = Math.random() * s.ttl * 0.7;
        return s;
      });
    };

    const lifeAlpha = (s: Stream): number => {
      const p = s.age / s.ttl;
      const fadeIn = Math.min(1, p / FADE_IN);
      const fadeOut = Math.min(1, (1 - p) / FADE_OUT);
      return Math.max(0, Math.min(fadeIn, fadeOut));
    };

    const drawStream = (s: Stream, life: number) => {
      const points = s.points;
      const n = points.length;
      if (n < 2 || life <= 0) return;
      const rgb = gradientRgb(s.colorT);
      const peak = Math.min(0.85, TAIL_ALPHA * (s.streak ? STREAK_ALPHA : 1)) * life;
      ctx.lineWidth = s.streak ? LINE_WIDTH * 1.35 : LINE_WIDTH;
      for (let i = 1; i < n; i++) {
        const a = peak * (i / (n - 1));
        if (a < 0.004) continue;
        ctx.strokeStyle = `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${a.toFixed(4)})`;
        ctx.beginPath();
        ctx.moveTo(points[i - 1].x, points[i - 1].y);
        ctx.lineTo(points[i].x, points[i].y);
        ctx.stroke();
      }
      // comet head: glow sprite + hot core
      const head = points[n - 1];
      const glow = s.streak ? STREAK_GLOW : HEAD_GLOW;
      ctx.globalAlpha = life * (s.streak ? 0.9 : HEAD_ALPHA);
      ctx.drawImage(sprites[spriteIndex(s.colorT)], head.x - glow, head.y - glow, glow * 2, glow * 2);
      ctx.globalAlpha = 1;
      ctx.fillStyle = `rgba(255, 255, 255, ${(life * (s.streak ? 0.85 : 0.55)).toFixed(4)})`;
      ctx.beginPath();
      ctx.arc(head.x, head.y, s.streak ? 1.8 : 1.4, 0, Math.PI * 2);
      ctx.fill();
    };

    const step = (dt: number, t: number) => {
      const margin = 24;
      for (const s of streams) {
        s.age += dt;
        const head = s.points[s.points.length - 1];
        const angle = fieldAngle(head.x, head.y, t);
        const speed = SPEED * (s.streak ? STREAK_SPEED : 1);
        const nx = head.x + Math.cos(angle) * speed * dt;
        const ny = head.y + Math.sin(angle) * speed * dt;
        s.points.push({ x: nx, y: ny });
        const maxTrail = s.streak ? Math.round(TRAIL_MAX * 0.6) : TRAIL_MAX;
        if (s.points.length > maxTrail) s.points.shift();
        if (
          s.age > s.ttl ||
          nx < -margin ||
          nx > w + margin ||
          ny < -margin ||
          ny > h + margin
        ) {
          spawn(s, t);
        }
      }
    };

    const draw = () => {
      ctx.globalCompositeOperation = "source-over";
      ctx.clearRect(0, 0, w, h);
      ctx.globalCompositeOperation = "lighter";
      ctx.lineCap = "round";
      for (const s of streams) drawStream(s, lifeAlpha(s));
      ctx.globalCompositeOperation = "source-over";
    };

    // Reduced motion: trace complete streamlines through a frozen field
    // and render them once with gradient colors and head dots.
    const drawStatic = () => {
      ctx.globalCompositeOperation = "source-over";
      ctx.clearRect(0, 0, w, h);
      ctx.globalCompositeOperation = "lighter";
      ctx.lineCap = "round";
      ctx.lineWidth = LINE_WIDTH;
      const stepLen = 2.2;
      const count = streamCount();
      for (let i = 0; i < count; i++) {
        let x = Math.random() * w;
        let y = Math.random() * h;
        const colorT = (x / Math.max(1, w) * 0.6 + Math.random() * 0.25) % 1;
        const rgb = gradientRgb(colorT);
        const points: { x: number; y: number }[] = [{ x, y }];
        for (let k = 0; k < STATIC_STEPS; k++) {
          const angle = fieldAngle(x, y, 0);
          x += Math.cos(angle) * stepLen;
          y += Math.sin(angle) * stepLen;
          if (x < 0 || x > w || y < 0 || y > h) break;
          points.push({ x, y });
        }
        const n = points.length;
        if (n < 2) continue;
        for (let k = 1; k < n; k++) {
          const a = TAIL_ALPHA * 0.9 * (k / (n - 1));
          if (a < 0.004) continue;
          ctx.strokeStyle = `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${a.toFixed(4)})`;
          ctx.beginPath();
          ctx.moveTo(points[k - 1].x, points[k - 1].y);
          ctx.lineTo(points[k].x, points[k].y);
          ctx.stroke();
        }
        const head = points[n - 1];
        ctx.globalAlpha = HEAD_ALPHA * 0.8;
        ctx.drawImage(
          sprites[spriteIndex(colorT)],
          head.x - HEAD_GLOW,
          head.y - HEAD_GLOW,
          HEAD_GLOW * 2,
          HEAD_GLOW * 2,
        );
        ctx.globalAlpha = 1;
      }
      ctx.globalCompositeOperation = "source-over";
    };

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (last === 0) last = now;
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      step(dt, now / 1000);
      draw();
    };

    const start = () => {
      if (running || reduced) return;
      running = true;
      last = 0;
      raf = requestAnimationFrame(frame);
    };

    const stop = () => {
      running = false;
      cancelAnimationFrame(raf);
    };

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = canvas.clientWidth || window.innerWidth;
      h = canvas.clientHeight || window.innerHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (reduced) {
        drawStatic();
      } else {
        seed();
      }
    };

    const onVisibility = () => {
      if (document.hidden) stop();
      else start();
    };

    resize();
    if (!reduced) {
      start();
      document.addEventListener("visibilitychange", onVisibility);
    }
    window.addEventListener("resize", resize);

    return () => {
      stop();
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [reduced]);

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
