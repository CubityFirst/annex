import { useEffect, useRef, useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";

const DEFAULT_SPACING = 24;
// Wheel-zoom bounds for the grid spacing: lower = denser (more dots).
const MIN_SPACING = 12;
const MAX_SPACING = 56;
const ZOOM_FACTOR = 1.1;
const BASE_RADIUS = 1.2;
const MAX_RADIUS = 6;
const INFLUENCE_RADIUS = 120;
// How much the wave field can add to a dot's radius on top of BASE_RADIUS.
const WAVE_AMPLITUDE = 2.6;
// Per-dot opacity range: BASE_ALPHA at the wave's trough, BASE_ALPHA +
// WAVE_ALPHA at its crest. Mouse proximity pushes toward full opacity.
const BASE_ALPHA = 0.2;
const WAVE_ALPHA = 0.75;
// One full loop of the wave field. The drift path below is built to close
// on itself over exactly this duration, so the animation wraps seamlessly.
const LOOP_MS = 24000;
// Approximate size of one noise feature in px. Larger than SPACING so the
// field reads as smooth blobs rather than per-dot flicker.
const NOISE_SCALE = 1 / 90;
// Second (parallax) layer: much larger blobs, drifting slower and the other
// way, superimposed as an extra swell for depth. Toggled by the temporary
// checkbox below.
const LAYER2_SCALE = NOISE_SCALE * 0.35;
const LAYER2_DRIFT = -0.2;
const LAYER2_AMPLITUDE = 2.0;
const LAYER2_ALPHA = 0.3;
// How fast the noise field pans across the grid, in px/s. The path is
// integrated at constant speed, so the pan never stalls or lurches.
const DRIFT_SPEED_PX = 50;
const DRIFT_PATH_SAMPLES = 1024;

// Precomputed looping pan path. Instead of animating position directly
// (which makes speed the derivative of whatever curve you picked, with
// near-stalls where terms cancel), integrate a constant-speed velocity
// whose heading rotates once per loop with irregular wobble. Result: the
// field always pans at ~DRIFT_SPEED_PX, and the direction keeps turning -
// up/down/left/right in a different-feeling order each pass.
function buildDriftPath(): Float32Array {
  const n = DRIFT_PATH_SAMPLES;
  const pts = new Float32Array((n + 1) * 2);
  const step = (DRIFT_SPEED_PX * NOISE_SCALE * (LOOP_MS / 1000)) / n;
  let px = 0;
  let py = 0;
  for (let i = 1; i <= n; i++) {
    const phi = ((i - 1) / n) * Math.PI * 2;
    // Two full heading rotations per loop caps any roughly-one-direction
    // stretch at ~5s; the wobble terms make the turning feel irregular.
    const heading = 2 * phi + 0.9 * Math.sin(3 * phi + 2.1) + 0.7 * Math.sin(5 * phi + 0.7);
    px += Math.cos(heading) * step;
    py += Math.sin(heading) * step;
    pts[i * 2] = px;
    pts[i * 2 + 1] = py;
  }
  // The wobbled heading doesn't integrate to exactly zero, so shear the
  // accumulated endpoint drift back out to close the loop. This folds a
  // small constant velocity into every sample - it nudges the speed away
  // from perfectly uniform but can never cancel it to a stall.
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    pts[i * 2] -= px * t;
    pts[i * 2 + 1] -= py * t;
  }
  return pts;
}

const driftPath = buildDriftPath();

// Integer-lattice hash -> [0, 1). Math.imul keeps the multiplies in 32-bit
// space; plain * would lose low bits to float rounding and streak the noise.
function hash(ix: number, iy: number): number {
  let h = Math.imul(ix, 374761393) + Math.imul(iy, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// 2D value noise: bilinear blend of hashed lattice corners with smoothstep
// fade. Returns [0, 1]. Isotropic, so no directional banding.
function valueNoise(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy);
  const b = hash(ix + 1, iy);
  const c = hash(ix, iy + 1);
  const d = hash(ix + 1, iy + 1);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

export function DotGrid() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mouseRef = useRef<{ x: number; y: number } | null>(null);
  const animFrameRef = useRef<number>(0);
  // current animated radius for each dot: [col][row]
  const radiiRef = useRef<Float32Array | null>(null);
  const spacingRef = useRef(DEFAULT_SPACING);
  // TEMPORARY: second-layer experiment toggle. State drives the checkbox,
  // the ref lets the draw loop read it without re-running the effect.
  const [secondLayer, setSecondLayer] = useState(false);
  const secondLayerRef = useRef(secondLayer);
  secondLayerRef.current = secondLayer;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d")!;
    let cols = 0;
    let rows = 0;

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    function rebuildGrid() {
      const dpr = window.devicePixelRatio || 1;
      canvas!.width = canvas!.offsetWidth * dpr;
      canvas!.height = canvas!.offsetHeight * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const spacing = spacingRef.current;
      cols = Math.ceil(canvas!.offsetWidth / spacing) + 1;
      rows = Math.ceil(canvas!.offsetHeight / spacing) + 1;
      radiiRef.current = new Float32Array(cols * rows).fill(BASE_RADIUS);
    }

    rebuildGrid();
    const ro = new ResizeObserver(rebuildGrid);
    ro.observe(canvas);

    // React attaches wheel listeners passively, so preventDefault (needed to
    // keep the page from scrolling while zooming the grid) requires a native
    // non-passive listener.
    function handleWheel(e: WheelEvent) {
      e.preventDefault();
      // Scroll up zooms in (bigger spacing, fewer dots), down zooms out.
      const factor = e.deltaY < 0 ? ZOOM_FACTOR : 1 / ZOOM_FACTOR;
      const next = Math.min(MAX_SPACING, Math.max(MIN_SPACING, spacingRef.current * factor));
      if (next === spacingRef.current) return;
      spacingRef.current = next;
      rebuildGrid();
    }
    canvas.addEventListener("wheel", handleWheel, { passive: false });

    function draw(now: number) {
      animFrameRef.current = requestAnimationFrame(draw);
      if (!radiiRef.current) return;

      const w = canvas!.offsetWidth;
      const h = canvas!.offsetHeight;
      if (w === 0 || h === 0) return;
      ctx.clearRect(0, 0, w, h);

      const mouse = mouseRef.current;
      const radii = radiiRef.current;
      const spacing = spacingRef.current;
      const layer2 = secondLayerRef.current;
      const color = getComputedStyle(document.documentElement)
        .getPropertyValue("--muted-foreground")
        .trim() || "oklch(0.552 0.016 285.938)";

      ctx.fillStyle = color;

      // Sample the precomputed constant-speed pan path (interpolated between
      // table entries; the table has n+1 points so i0+1 never wraps).
      const tPath = reducedMotion ? 0 : ((now % LOOP_MS) / LOOP_MS) * DRIFT_PATH_SAMPLES;
      const i0 = Math.floor(tPath);
      const frac = tPath - i0;
      const driftX = driftPath[i0 * 2] + (driftPath[(i0 + 1) * 2] - driftPath[i0 * 2]) * frac;
      const driftY = driftPath[i0 * 2 + 1] + (driftPath[(i0 + 1) * 2 + 1] - driftPath[i0 * 2 + 1]) * frac;

      for (let c = 0; c < cols; c++) {
        for (let r = 0; r < rows; r++) {
          const x = c * spacing;
          const y = r * spacing;
          const idx = c * rows + r;

          // Two octaves drifting in opposite directions so the shapes morph
          // a little as they travel instead of sliding as a rigid sheet.
          const nx = x * NOISE_SCALE;
          const ny = y * NOISE_SCALE;
          let v = valueNoise(nx + driftX, ny + driftY) * 0.7
            + valueNoise(nx * 2.3 - driftX * 0.6, ny * 2.3 - driftY * 0.6) * 0.3;
          // Value noise clusters around 0.5 - stretch toward the extremes,
          // then smoothstep so crests visibly pop and troughs recede.
          v = Math.min(1, Math.max(0, (v - 0.5) * 1.8 + 0.5));
          const n = v * v * (3 - 2 * v);
          let target = BASE_RADIUS + WAVE_AMPLITUDE * n;
          let alpha = BASE_ALPHA + WAVE_ALPHA * n;

          if (layer2) {
            const n2 = valueNoise(
              x * LAYER2_SCALE + driftX * LAYER2_DRIFT,
              y * LAYER2_SCALE + driftY * LAYER2_DRIFT,
            );
            target += LAYER2_AMPLITUDE * n2;
            alpha = Math.min(1, alpha + LAYER2_ALPHA * n2);
          }

          if (mouse) {
            const dx = x - mouse.x;
            const dy = y - mouse.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < INFLUENCE_RADIUS) {
              const t = 1 - dist / INFLUENCE_RADIUS;
              target = Math.max(target, BASE_RADIUS + (MAX_RADIUS - BASE_RADIUS) * t * t);
              alpha = Math.max(alpha, Math.min(1, alpha + t));
            }
          }

          // lerp toward target
          radii[idx] += (target - radii[idx]) * 0.15;

          ctx.globalAlpha = alpha;
          ctx.beginPath();
          ctx.arc(x, y, radii[idx], 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
    }

    animFrameRef.current = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(animFrameRef.current);
      ro.disconnect();
      canvas.removeEventListener("wheel", handleWheel);
    };
  }, []);

  function handleMouseMove(e: React.MouseEvent<HTMLCanvasElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    mouseRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function handleMouseLeave() {
    mouseRef.current = null;
  }

  return (
    <>
      <canvas
        ref={canvasRef}
        className="absolute inset-0 h-full w-full"
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
      />
      {/* TEMPORARY: dev toggle for the parallax second-layer experiment. */}
      <label className="absolute bottom-3 right-3 flex items-center gap-1.5 text-xs text-muted-foreground select-none">
        <Checkbox
          checked={secondLayer}
          onCheckedChange={checked => setSecondLayer(checked === true)}
        />
        Second layer
      </label>
    </>
  );
}
