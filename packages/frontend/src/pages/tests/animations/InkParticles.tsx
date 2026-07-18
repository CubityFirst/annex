// /test/animations variant: Ink Particles
// Ink motes drifting through the dark — now dense, glowing, and alive:
// palette-tinted particles with pre-rendered glow sprites, occasional
// bright "spark" flares, and cursor repulsion. Canvas-based.
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
// Annex Ink palette: paper, gold hsl(45 100% 65%), pink hsl(320 80% 65%),
// blue hsl(200 80% 60%). Weights control the color mix of the swarm.
const PALETTE: { rgb: [number, number, number]; weight: number }[] = [
  { rgb: [232, 228, 222], weight: 0.5 }, // paper #e8e4de
  { rgb: [255, 210, 77], weight: 0.2 }, // gold
  { rgb: [237, 94, 190], weight: 0.14 }, // pink
  { rgb: [71, 180, 235], weight: 0.16 }, // blue
];
const DENSITY = 1 / 9000; // particles per px^2 of viewport
const MIN_COUNT = 80;
const MAX_COUNT = 380;
const MIN_SPEED = 6; // px/s at the far depth plane
const MAX_SPEED = 24; // px/s at the near depth plane
const MIN_RADIUS = 0.8; // core px at the far depth plane
const MAX_RADIUS = 2.8; // core px at the near depth plane
const GLOW_SCALE = 7; // glow sprite radius = core radius * this
const GLOW_ALPHA = 0.5; // glow strength relative to core alpha
const MIN_ALPHA = 0.1;
const MAX_ALPHA = 0.5;
const TURN_RATE = 0.5; // rad/s max heading wander
const TWINKLE_SPEED = 0.5; // Hz-ish alpha shimmer
const TWINKLE_DEPTH = 0.35; // 0..1 fraction of alpha that shimmers
const MOUSE_RADIUS = 170; // px cursor influence radius
const MOUSE_FORCE = 1400; // px/s^2 repulsion at cursor center
const MOUSE_DAMPING = 3.2; // 1/s decay of the push velocity
const SPARKS_PER_SECOND = 1.5; // expected spark flares per second
const SPARK_DURATION = 1.3; // s
const SPARK_GLOW = 4; // glow size multiplier at spark peak
const SPARK_ALPHA = 0.85; // extra alpha at spark peak
// -----------------------------------------------------------------------

interface Mote {
  x: number;
  y: number;
  z: number; // 0 (far) .. 1 (near)
  dir: number; // heading, radians
  turn: number; // rad/s
  phase: number; // twinkle phase offset
  color: number; // palette index
  ox: number; // cursor-push velocity x
  oy: number; // cursor-push velocity y
  spark: number; // -1 idle, else 0..1 flare progress
}

function pickColor(): number {
  let r = Math.random();
  for (let i = 0; i < PALETTE.length; i++) {
    r -= PALETTE[i].weight;
    if (r <= 0) return i;
  }
  return 0;
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

export default function InkParticlesBackground() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const sprites = PALETTE.map((p) => makeGlowSprite(p.rgb));

    let raf = 0;
    let running = false;
    let last = 0;
    let w = 0;
    let h = 0;
    let motes: Mote[] = [];
    const pointer = { x: 0, y: 0, active: false };

    const seed = () => {
      const count = Math.max(
        MIN_COUNT,
        Math.min(MAX_COUNT, Math.round(w * h * DENSITY)),
      );
      motes = Array.from({ length: count }, () => ({
        x: Math.random() * w,
        y: Math.random() * h,
        z: Math.random(),
        dir: Math.random() * Math.PI * 2,
        turn: (Math.random() * 2 - 1) * TURN_RATE,
        phase: Math.random() * Math.PI * 2,
        color: pickColor(),
        ox: 0,
        oy: 0,
        spark: -1,
      }));
    };

    const draw = (t: number) => {
      ctx.globalCompositeOperation = "source-over";
      ctx.clearRect(0, 0, w, h);
      ctx.globalCompositeOperation = "lighter";
      for (const m of motes) {
        const r = MIN_RADIUS + m.z * (MAX_RADIUS - MIN_RADIUS);
        const base = MIN_ALPHA + m.z * (MAX_ALPHA - MIN_ALPHA);
        const twinkle =
          1 -
          TWINKLE_DEPTH * (0.5 + 0.5 * Math.sin(t * TWINKLE_SPEED * Math.PI * 2 + m.phase));
        let alpha = base * twinkle;
        let glow = r * GLOW_SCALE;
        if (m.spark >= 0) {
          const flare = Math.sin(Math.PI * m.spark);
          alpha = Math.min(1, alpha + flare * SPARK_ALPHA);
          glow *= 1 + flare * (SPARK_GLOW - 1);
        }
        const rgb = PALETTE[m.color].rgb;
        // halo
        ctx.globalAlpha = alpha * GLOW_ALPHA;
        ctx.drawImage(sprites[m.color], m.x - glow, m.y - glow, glow * 2, glow * 2);
        // core
        ctx.globalAlpha = 1;
        ctx.fillStyle = `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha.toFixed(4)})`;
        ctx.beginPath();
        ctx.arc(m.x, m.y, r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
    };

    const step = (dt: number) => {
      const margin = MAX_RADIUS * GLOW_SCALE;
      const push = Math.exp(-MOUSE_DAMPING * dt);
      // spark spawner
      if (motes.length > 0 && Math.random() < SPARKS_PER_SECOND * dt) {
        const m = motes[Math.floor(Math.random() * motes.length)];
        if (m.spark < 0) m.spark = 0;
      }
      for (const m of motes) {
        const speed = MIN_SPEED + m.z * (MAX_SPEED - MIN_SPEED);
        m.dir += m.turn * dt;
        m.x += Math.cos(m.dir) * speed * dt;
        m.y += Math.sin(m.dir) * speed * dt;
        if (m.spark >= 0) {
          m.spark += dt / SPARK_DURATION;
          if (m.spark >= 1) m.spark = -1;
        }
        if (pointer.active) {
          const dx = m.x - pointer.x;
          const dy = m.y - pointer.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < MOUSE_RADIUS * MOUSE_RADIUS && d2 > 0.01) {
            const d = Math.sqrt(d2);
            const f = (MOUSE_FORCE * (1 - d / MOUSE_RADIUS)) / d;
            m.ox += dx * f * dt;
            m.oy += dy * f * dt;
          }
        }
        m.x += m.ox * dt;
        m.y += m.oy * dt;
        m.ox *= push;
        m.oy *= push;
        if (m.x < -margin) m.x = w + margin;
        else if (m.x > w + margin) m.x = -margin;
        if (m.y < -margin) m.y = h + margin;
        else if (m.y > h + margin) m.y = -margin;
      }
    };

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (last === 0) last = now;
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      step(dt);
      draw(now / 1000);
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
      seed();
      if (reduced) draw(0);
    };

    const onVisibility = () => {
      if (document.hidden) stop();
      else start();
    };

    const onPointerMove = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      pointer.x = e.clientX - rect.left;
      pointer.y = e.clientY - rect.top;
      pointer.active = true;
    };
    const onPointerLeave = () => {
      pointer.active = false;
    };

    resize();
    if (reduced) {
      draw(0);
    } else {
      start();
      document.addEventListener("visibilitychange", onVisibility);
      window.addEventListener("pointermove", onPointerMove);
      document.addEventListener("pointerleave", onPointerLeave);
      window.addEventListener("blur", onPointerLeave);
    }
    window.addEventListener("resize", resize);

    return () => {
      stop();
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerleave", onPointerLeave);
      window.removeEventListener("blur", onPointerLeave);
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
