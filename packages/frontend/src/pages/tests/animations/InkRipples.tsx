// /test/animations variant: Ink Ripples
// Expanding concentric rings at random positions, like ink drops landing
// in still water. Intense pass: frequent drops, bright rings in Annex Ink
// hues, a glowing impact flash at each drop point, and organic (wobbled,
// squashed, rotated) ring shapes for a liquid feel.
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
const DROP_INTERVAL_MIN = 1; // seconds between drops
const DROP_INTERVAL_MAX = 2.5;
const FIRST_DROP_DELAY_MIN = 0.2; // first drop arrives right away
const FIRST_DROP_DELAY_MAX = 0.8;
const RING_COUNT = 4; // concentric rings per drop
const RING_STAGGER = 0.55; // seconds between successive rings of one drop
const RING_DURATION = 5; // seconds for one ring to expand + fade
const RADIUS_FRACTION_MIN = 0.16; // max radius as fraction of min(w, h)
const RADIUS_FRACTION_MAX = 0.3;
const BASE_ALPHA_MIN = 0.25; // first ring's alpha at birth (fades to 0)
const BASE_ALPHA_MAX = 0.4;
const RING_DIM = 0.75; // each later ring's alpha multiplier vs the previous
const LINE_WIDTH_BIRTH = 2.2; // ring stroke width at birth -> thins as it grows
const LINE_WIDTH_DEATH = 0.8;
const FLASH_ALPHA = 0.65; // impact glow-dot peak alpha
const FLASH_DURATION = 1.4; // seconds for the impact flash to fade
const FLASH_SIZE_MIN = 40; // impact glow sprite diameter, px
const FLASH_SIZE_MAX = 80;
const WOBBLE_AMP_MIN = 0.015; // organic radius perturbation (fraction of r)
const WOBBLE_AMP_MAX = 0.05;
const SQUASH_MIN = 0.82; // elliptical squash of ring minor axis
const RING_POINTS = 56; // polyline segments per ring
const EDGE_MARGIN = 0.06; // keep drop centers off the extreme edges
const INK_RGB = "232, 228, 222"; // #e8e4de
// Annex Ink hues: gold hsl(45 100% 65%), pink hsl(320 80% 65%), blue hsl(200 80% 60%)
const HUES = ["255, 210, 77", "237, 94, 190", "71, 180, 235"];
const INK_WHITE_CHANCE = 0.2; // fraction of drops that stay off-white
const MAX_DPR = 2;
// ----------------------------------------------------------------------------

type Drop = {
  x: number;
  y: number;
  born: number; // in accumulated animation-time seconds
  maxRadius: number;
  baseAlpha: number;
  rgb: string;
  glow: HTMLCanvasElement;
  flashSize: number;
  squash: number;
  rot: number;
  wobbleAmp: number;
  wobbleLobes: number;
  wobblePhase: number;
};

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

// Decelerating expansion, like a real ripple losing energy.
function easeOutQuad(t: number): number {
  return t * (2 - t);
}

function makeGlowSprite(rgb: string): HTMLCanvasElement {
  const size = 128;
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const g = c.getContext("2d");
  if (g) {
    const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, `rgba(${rgb}, 0.9)`);
    grad.addColorStop(0.35, `rgba(${rgb}, 0.3)`);
    grad.addColorStop(1, `rgba(${rgb}, 0)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
  }
  return c;
}

export default function InkRipplesBackground() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    const hueSprites = HUES.map(makeGlowSprite);
    const inkSprite = makeGlowSprite(INK_RGB);
    const drops: Drop[] = [];
    const dropLifetime = RING_STAGGER * (RING_COUNT - 1) + RING_DURATION;
    let rafId = 0;
    let running = false;
    let lastTime = 0;
    let time = 0; // accumulated seconds; freezes while hidden, so no backlog
    let nextDropAt = rand(FIRST_DROP_DELAY_MIN, FIRST_DROP_DELAY_MAX);
    let w = 0;
    let h = 0;

    const makeDrop = (x: number, y: number): Drop => {
      const white = Math.random() < INK_WHITE_CHANCE;
      const hueIdx = Math.floor(Math.random() * HUES.length);
      return {
        x,
        y,
        born: time,
        maxRadius: Math.min(w, h) * rand(RADIUS_FRACTION_MIN, RADIUS_FRACTION_MAX),
        baseAlpha: rand(BASE_ALPHA_MIN, BASE_ALPHA_MAX),
        rgb: white ? INK_RGB : (HUES[hueIdx] ?? INK_RGB),
        glow: white ? inkSprite : (hueSprites[hueIdx] ?? inkSprite),
        flashSize: rand(FLASH_SIZE_MIN, FLASH_SIZE_MAX),
        squash: rand(SQUASH_MIN, 1),
        rot: rand(0, Math.PI),
        wobbleAmp: rand(WOBBLE_AMP_MIN, WOBBLE_AMP_MAX),
        wobbleLobes: 3 + Math.floor(Math.random() * 4), // 3..6 lobes
        wobblePhase: rand(0, Math.PI * 2),
      };
    };

    const spawnDrop = () => {
      const mx = w * EDGE_MARGIN;
      const my = h * EDGE_MARGIN;
      drops.push(makeDrop(rand(mx, w - mx), rand(my, h - my)));
    };

    // Organic ring: wobbled radius, squashed minor axis, rotated.
    const drawRing = (d: Drop, r: number, alpha: number, width: number) => {
      if (r <= 1 || alpha <= 0.004) return;
      const cosA = Math.cos(d.rot);
      const sinA = Math.sin(d.rot);
      ctx.beginPath();
      ctx.lineWidth = width;
      ctx.strokeStyle = `rgba(${d.rgb}, ${alpha})`;
      for (let k = 0; k <= RING_POINTS; k++) {
        const th = (k / RING_POINTS) * Math.PI * 2;
        const rr = r * (1 + d.wobbleAmp * Math.sin(d.wobbleLobes * th + d.wobblePhase));
        const ux = Math.cos(th) * rr;
        const uy = Math.sin(th) * rr * d.squash;
        const px = d.x + ux * cosA - uy * sinA;
        const py = d.y + ux * sinA + uy * cosA;
        if (k === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
    };

    const drawDrop = (d: Drop, at: number) => {
      // Impact flash: bright glow dot that fades as the rings take over.
      const fp = (at - d.born) / FLASH_DURATION;
      if (fp >= 0 && fp < 1) {
        const fade = (1 - fp) * (1 - fp);
        const s = d.flashSize * (0.6 + 0.7 * easeOutQuad(fp));
        ctx.globalAlpha = FLASH_ALPHA * fade;
        ctx.drawImage(d.glow, d.x - s / 2, d.y - s / 2, s, s);
        ctx.globalAlpha = 1;
      }
      for (let i = 0; i < RING_COUNT; i++) {
        const p = (at - d.born - i * RING_STAGGER) / RING_DURATION;
        if (p <= 0 || p >= 1) continue;
        const r = d.maxRadius * easeOutQuad(p);
        const alpha = d.baseAlpha * (1 - p) * Math.pow(RING_DIM, i);
        const width = LINE_WIDTH_BIRTH + (LINE_WIDTH_DEATH - LINE_WIDTH_BIRTH) * p;
        drawRing(d, r, alpha, width);
      }
    };

    const render = () => {
      ctx.clearRect(0, 0, w, h);
      for (const d of drops) drawDrop(d, time);
    };

    const step = (dt: number) => {
      time += dt;
      if (time >= nextDropAt) {
        spawnDrop();
        nextDropAt = time + rand(DROP_INTERVAL_MIN, DROP_INTERVAL_MAX);
      }
      for (let i = drops.length - 1; i >= 0; i--) {
        const d = drops[i];
        if (d && time - d.born > dropLifetime) drops.splice(i, 1);
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

    // Static frame for prefers-reduced-motion: two frozen drops, mid-ripple.
    const renderStatic = () => {
      ctx.clearRect(0, 0, w, h);
      const a = makeDrop(w * 0.68, h * 0.32);
      a.born = -RING_STAGGER * 2; // freeze partway through its life
      const b = makeDrop(w * 0.25, h * 0.7);
      b.born = -RING_STAGGER;
      drawDrop(a, time);
      drawDrop(b, time);
    };

    const resize = () => {
      w = canvas.clientWidth || window.innerWidth;
      h = canvas.clientHeight || window.innerHeight;
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (mql.matches) renderStatic();
      else render();
    };

    const onVisibility = () => {
      if (document.hidden) stop();
      else start();
    };

    const onMotionChange = () => {
      if (mql.matches) {
        stop();
        renderStatic();
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
