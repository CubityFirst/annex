// /test/animations variant: Floating Glyphs
// Markdown/writing glyphs (#, *, >, `, [[ ]], ¶) drifting upward and
// fading, like thoughts rising. DM Mono. Intense pass: bigger glyphs,
// higher alphas, gentle rotation, and occasional "highlight" glyphs that
// glow in an Annex Ink hue (pre-rendered glow sprites, no shadowBlur).
//
// Contract: default-export a component that renders a full-viewport
// background layer (position: fixed, inset: 0, z-index: 0,
// pointer-events: none, aria-hidden). Respect prefers-reduced-motion
// (render static or nothing) and clean up rAF/listeners on unmount.
import { useEffect, useRef } from "react";

// --- Tuning knobs -----------------------------------------------------------
const GLYPHS = ["#", "*", ">", "`", "[[", "]]", "¶", "—"];
const AREA_PER_GLYPH = 22_000; // px² of viewport per glyph (density)
const MIN_COUNT = 18;
const MAX_COUNT = 110;
const PEAK_ALPHA_MIN = 0.15; // normal glyphs' max opacity
const PEAK_ALPHA_MAX = 0.35;
const HIGHLIGHT_CHANCE = 0.18; // fraction of glyphs that get an Ink hue + glow
const HIGHLIGHT_ALPHA_MIN = 0.35; // highlight glyphs' max opacity
const HIGHLIGHT_ALPHA_MAX = 0.6;
const GLOW_SCALE = 3.4; // glow sprite size relative to glyph size
const SPEED_MIN = 14; // upward drift, px/s
const SPEED_MAX = 48;
const SIZE_MIN = 14; // font size, px
const SIZE_MAX = 40;
const LIFE_MIN = 6; // seconds from fade-in to fade-out
const LIFE_MAX = 13;
const DRIFT_AMPLITUDE_MIN = 10; // horizontal sway, px
const DRIFT_AMPLITUDE_MAX = 30;
const ROTATE_CHANCE = 0.5; // fraction of glyphs that slowly rotate
const ROT_SPEED_MAX = 0.45; // rad/s
const INK_RGB = "232, 228, 222"; // #e8e4de
// Annex Ink hues: gold hsl(45 100% 65%), pink hsl(320 80% 65%), blue hsl(200 80% 60%)
const HUES = ["255, 210, 77", "237, 94, 190", "71, 180, 235"];
const MAX_DPR = 2;
// ----------------------------------------------------------------------------

type Particle = {
  glyph: string;
  x: number;
  y: number;
  speed: number;
  size: number;
  life: number;
  age: number;
  driftPhase: number;
  driftFreq: number;
  driftAmp: number;
  rotation: number;
  rotSpeed: number;
  peakAlpha: number;
  rgb: string;
  glow: HTMLCanvasElement | null;
};

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function makeGlowSprite(rgb: string): HTMLCanvasElement {
  const size = 128;
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const g = c.getContext("2d");
  if (g) {
    const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, `rgba(${rgb}, 0.75)`);
    grad.addColorStop(0.4, `rgba(${rgb}, 0.22)`);
    grad.addColorStop(1, `rgba(${rgb}, 0)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
  }
  return c;
}

export default function FloatingGlyphsBackground() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    const glowSprites = HUES.map(makeGlowSprite);
    const particles: Particle[] = [];
    let rafId = 0;
    let running = false;
    let lastTime = 0;
    let w = 0;
    let h = 0;

    const makeParticle = (scatter: boolean): Particle => {
      const size = rand(SIZE_MIN, SIZE_MAX);
      const life = rand(LIFE_MIN, LIFE_MAX);
      const highlight = Math.random() < HIGHLIGHT_CHANCE;
      const hueIdx = Math.floor(Math.random() * HUES.length);
      return {
        glyph: GLYPHS[Math.floor(Math.random() * GLYPHS.length)] ?? "#",
        x: rand(0, w),
        // Fresh spawns start in the lower half so they visibly "rise";
        // initial scatter fills the whole viewport with randomized ages.
        y: scatter ? rand(-size, h + size) : rand(h * 0.35, h + size),
        speed: rand(SPEED_MIN, SPEED_MAX),
        size,
        life,
        age: scatter ? rand(0, life) : 0,
        driftPhase: rand(0, Math.PI * 2),
        driftFreq: rand(0.2, 0.6),
        driftAmp: rand(DRIFT_AMPLITUDE_MIN, DRIFT_AMPLITUDE_MAX),
        rotation: rand(-0.5, 0.5),
        rotSpeed: Math.random() < ROTATE_CHANCE ? rand(-ROT_SPEED_MAX, ROT_SPEED_MAX) : 0,
        peakAlpha: highlight
          ? rand(HIGHLIGHT_ALPHA_MIN, HIGHLIGHT_ALPHA_MAX)
          : rand(PEAK_ALPHA_MIN, PEAK_ALPHA_MAX),
        rgb: highlight ? (HUES[hueIdx] ?? INK_RGB) : INK_RGB,
        glow: highlight ? (glowSprites[hueIdx] ?? null) : null,
      };
    };

    const render = () => {
      ctx.clearRect(0, 0, w, h);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      for (const p of particles) {
        // Sine envelope: fade in over the first half of life, out over the second.
        const alpha = Math.sin(Math.PI * (p.age / p.life)) * p.peakAlpha;
        if (alpha <= 0.004) continue;
        const x = p.x + Math.sin(p.driftPhase + p.age * p.driftFreq) * p.driftAmp;
        const y = p.y;
        if (p.glow) {
          const s = p.size * GLOW_SCALE;
          ctx.globalAlpha = Math.min(1, alpha * 1.3);
          ctx.drawImage(p.glow, x - s / 2, y - s / 2, s, s);
          ctx.globalAlpha = 1;
        }
        ctx.save();
        ctx.translate(x, y);
        if (p.rotSpeed !== 0) ctx.rotate(p.rotation);
        ctx.font = `${p.size}px 'DM Mono', ui-monospace, monospace`;
        ctx.fillStyle = `rgba(${p.rgb}, ${alpha})`;
        ctx.fillText(p.glyph, 0, 0);
        ctx.restore();
      }
    };

    const step = (dt: number) => {
      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        if (!p) continue;
        p.age += dt;
        p.y -= p.speed * dt;
        p.rotation += p.rotSpeed * dt;
        if (p.age >= p.life || p.y < -p.size * 2) {
          particles[i] = makeParticle(false);
        }
      }
    };

    const frame = (now: number) => {
      rafId = requestAnimationFrame(frame);
      const dt = Math.min((now - lastTime) / 1000, 0.1);
      lastTime = now;
      step(dt);
      render();
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
      w = window.innerWidth;
      h = window.innerHeight;
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const target = Math.round(
        Math.min(MAX_COUNT, Math.max(MIN_COUNT, (w * h) / AREA_PER_GLYPH)),
      );
      while (particles.length < target) particles.push(makeParticle(true));
      if (particles.length > target) particles.length = target;
      render(); // repaint immediately (also serves as the static frame)
    };

    const onVisibility = () => {
      if (document.hidden) stop();
      else start();
    };

    const onMotionChange = () => {
      if (mql.matches) {
        stop();
        render(); // leave a single static frame
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
