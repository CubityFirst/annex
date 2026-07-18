// /test/animations variant: Constellation
// A living "doc graph": glowing palette-tinted nodes, gradient-colored
// links that brighten with proximity, pulses of light traveling along
// edges, and the cursor acting as an extra node that draws links to its
// neighbors. Echoes the app's graph page. Canvas-based.
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
// blue hsl(200 80% 60%). Weights control the color mix of the graph.
const PALETTE: { rgb: [number, number, number]; weight: number }[] = [
  { rgb: [232, 228, 222], weight: 0.4 }, // paper #e8e4de
  { rgb: [255, 210, 77], weight: 0.24 }, // gold
  { rgb: [237, 94, 190], weight: 0.16 }, // pink
  { rgb: [71, 180, 235], weight: 0.2 }, // blue
];
const DENSITY = 1 / 26000; // nodes per px^2 of viewport
const MIN_COUNT = 36;
const MAX_COUNT = 110;
const LINK_DIST = 160; // px; max distance for a line to appear
const MAX_LINE_ALPHA = 0.32; // link alpha at zero distance
const LINE_WIDTH = 1.1;
const MIN_NODE_RADIUS = 1.2;
const MAX_NODE_RADIUS = 2.6;
const MIN_NODE_ALPHA = 0.45;
const MAX_NODE_ALPHA = 0.85;
const NODE_GLOW_SCALE = 7; // glow sprite radius = node radius * this
const NODE_GLOW_ALPHA = 0.4; // glow strength relative to node alpha
const MIN_SPEED = 6; // px/s
const MAX_SPEED = 16; // px/s
const MOUSE_LINK_DIST = 220; // px; cursor connects to nodes within this
const MOUSE_LINE_ALPHA = 0.5; // cursor link alpha at zero distance
const MOUSE_GLOW_RADIUS = 30; // px; cursor halo
const PULSES_PER_SECOND = 2.2; // expected pulse spawns per second
const MAX_PULSES = 12;
const PULSE_MIN_SPEED = 0.6; // link traversals per second
const PULSE_MAX_SPEED = 1.4;
const PULSE_ALPHA = 0.75; // peak alpha of a traveling pulse
const PULSE_GLOW = 11; // px; pulse halo radius
// -----------------------------------------------------------------------

interface Node {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  alpha: number;
  color: number; // palette index
  phase: number; // glow breathing offset
}

interface Pulse {
  a: number; // node index
  b: number; // node index
  t: number; // 0..1 progress along the link
  speed: number; // progress per second
}

function pickColor(): number {
  let r = Math.random();
  for (let i = 0; i < PALETTE.length; i++) {
    r -= PALETTE[i].weight;
    if (r <= 0) return i;
  }
  return 0;
}

function mixRgb(a: [number, number, number], b: [number, number, number]): string {
  return `${(a[0] + b[0]) >> 1}, ${(a[1] + b[1]) >> 1}, ${(a[2] + b[2]) >> 1}`;
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

export default function ConstellationBackground() {
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
    let nodes: Node[] = [];
    let pulses: Pulse[] = [];
    const pointer = { x: 0, y: 0, active: false };

    const seed = () => {
      const count = Math.max(
        MIN_COUNT,
        Math.min(MAX_COUNT, Math.round(w * h * DENSITY)),
      );
      nodes = Array.from({ length: count }, () => {
        const speed = MIN_SPEED + Math.random() * (MAX_SPEED - MIN_SPEED);
        const dir = Math.random() * Math.PI * 2;
        const t = Math.random();
        return {
          x: Math.random() * w,
          y: Math.random() * h,
          vx: Math.cos(dir) * speed,
          vy: Math.sin(dir) * speed,
          r: MIN_NODE_RADIUS + t * (MAX_NODE_RADIUS - MIN_NODE_RADIUS),
          alpha: MIN_NODE_ALPHA + t * (MAX_NODE_ALPHA - MIN_NODE_ALPHA),
          color: pickColor(),
          phase: Math.random() * Math.PI * 2,
        };
      });
      pulses = [];
    };

    const spawnPulse = () => {
      if (pulses.length >= MAX_PULSES || nodes.length < 2) return;
      const a = Math.floor(Math.random() * nodes.length);
      const na = nodes[a];
      const linkDist2 = LINK_DIST * LINK_DIST;
      const near: number[] = [];
      for (let j = 0; j < nodes.length; j++) {
        if (j === a) continue;
        const dx = na.x - nodes[j].x;
        const dy = na.y - nodes[j].y;
        if (dx * dx + dy * dy < linkDist2) near.push(j);
      }
      if (near.length === 0) return;
      pulses.push({
        a,
        b: near[Math.floor(Math.random() * near.length)],
        t: 0,
        speed: PULSE_MIN_SPEED + Math.random() * (PULSE_MAX_SPEED - PULSE_MIN_SPEED),
      });
    };

    const draw = (t: number) => {
      ctx.globalCompositeOperation = "source-over";
      ctx.clearRect(0, 0, w, h);
      ctx.globalCompositeOperation = "lighter";
      const linkDist2 = LINK_DIST * LINK_DIST;
      ctx.lineWidth = LINE_WIDTH;

      // links
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const d2 = dx * dx + dy * dy;
          if (d2 >= linkDist2) continue;
          const closeness = 1 - Math.sqrt(d2) / LINK_DIST;
          const alpha = closeness * closeness * MAX_LINE_ALPHA;
          ctx.strokeStyle = `rgba(${mixRgb(PALETTE[a.color].rgb, PALETTE[b.color].rgb)}, ${alpha.toFixed(4)})`;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }

      // cursor as an extra node: links + halo
      if (pointer.active) {
        const mouseDist2 = MOUSE_LINK_DIST * MOUSE_LINK_DIST;
        for (const n of nodes) {
          const dx = n.x - pointer.x;
          const dy = n.y - pointer.y;
          const d2 = dx * dx + dy * dy;
          if (d2 >= mouseDist2) continue;
          const closeness = 1 - Math.sqrt(d2) / MOUSE_LINK_DIST;
          const alpha = closeness * closeness * MOUSE_LINE_ALPHA;
          const rgb = PALETTE[n.color].rgb;
          ctx.strokeStyle = `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha.toFixed(4)})`;
          ctx.beginPath();
          ctx.moveTo(pointer.x, pointer.y);
          ctx.lineTo(n.x, n.y);
          ctx.stroke();
        }
        ctx.globalAlpha = 0.55;
        ctx.drawImage(
          sprites[0],
          pointer.x - MOUSE_GLOW_RADIUS,
          pointer.y - MOUSE_GLOW_RADIUS,
          MOUSE_GLOW_RADIUS * 2,
          MOUSE_GLOW_RADIUS * 2,
        );
        ctx.globalAlpha = 1;
        ctx.fillStyle = "rgba(232, 228, 222, 0.9)";
        ctx.beginPath();
        ctx.arc(pointer.x, pointer.y, 2.2, 0, Math.PI * 2);
        ctx.fill();
      }

      // pulses traveling along links
      for (const p of pulses) {
        const a = nodes[p.a];
        const b = nodes[p.b];
        const x = a.x + (b.x - a.x) * p.t;
        const y = a.y + (b.y - a.y) * p.t;
        const alpha = Math.sin(Math.PI * p.t) * PULSE_ALPHA;
        const rgb = mixRgb(PALETTE[a.color].rgb, PALETTE[b.color].rgb);
        ctx.globalAlpha = alpha;
        ctx.drawImage(sprites[a.color], x - PULSE_GLOW, y - PULSE_GLOW, PULSE_GLOW * 2, PULSE_GLOW * 2);
        ctx.globalAlpha = 1;
        ctx.fillStyle = `rgba(${rgb}, ${alpha.toFixed(4)})`;
        ctx.beginPath();
        ctx.arc(x, y, 2, 0, Math.PI * 2);
        ctx.fill();
      }

      // nodes: breathing glow + bright core
      for (const n of nodes) {
        const breathe = 0.8 + 0.2 * Math.sin(t * 0.9 + n.phase);
        const glow = n.r * NODE_GLOW_SCALE * breathe;
        ctx.globalAlpha = n.alpha * NODE_GLOW_ALPHA * breathe;
        ctx.drawImage(sprites[n.color], n.x - glow, n.y - glow, glow * 2, glow * 2);
        ctx.globalAlpha = 1;
        const rgb = PALETTE[n.color].rgb;
        ctx.fillStyle = `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${n.alpha.toFixed(4)})`;
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
    };

    const step = (dt: number) => {
      for (const n of nodes) {
        n.x += n.vx * dt;
        n.y += n.vy * dt;
        // Soft bounce keeps links from popping the way edge-wrapping would.
        if (n.x < 0) {
          n.x = 0;
          n.vx = Math.abs(n.vx);
        } else if (n.x > w) {
          n.x = w;
          n.vx = -Math.abs(n.vx);
        }
        if (n.y < 0) {
          n.y = 0;
          n.vy = Math.abs(n.vy);
        } else if (n.y > h) {
          n.y = h;
          n.vy = -Math.abs(n.vy);
        }
      }
      if (Math.random() < PULSES_PER_SECOND * dt) spawnPulse();
      for (let i = pulses.length - 1; i >= 0; i--) {
        pulses[i].t += pulses[i].speed * dt;
        if (pulses[i].t >= 1) pulses.splice(i, 1);
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
