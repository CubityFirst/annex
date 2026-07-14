// /test/animations variant: Starfield Dust
// Three dense parallax layers of star specks drifting sideways at different
// speeds, with colour-temperature variance (warm gold / cool blue / rare
// pink), glow halos on the brightest stars, lively twinkle, and a shooting
// star streaking across every few seconds with a fading tail.
//
// Contract: default-export a component that renders a full-viewport
// background layer (position: fixed, inset: 0, z-index: 0,
// pointer-events: none, aria-hidden). Respect prefers-reduced-motion
// (render static or nothing) and clean up rAF/listeners on unmount.
import { useEffect, useRef } from "react";

// ---- Tuning knobs -----------------------------------------------------------
// One entry per parallax layer (far -> near). `area` = px^2 of viewport per
// speck, so counts scale with window size (~270 specks total at 1080p).
const LAYERS = [
  { speed: 6, rMin: 0.4, rMax: 0.9, aMin: 0.06, aMax: 0.14, area: 15000 },
  { speed: 14, rMin: 0.7, rMax: 1.3, aMin: 0.1, aMax: 0.26, area: 24000 },
  { speed: 26, rMin: 1.0, rMax: 1.9, aMin: 0.18, aMax: 0.5, area: 42000 },
];
const DRIFT_DIR = -1; // -1 drifts leftward, 1 rightward

// Colour temperature mix (cumulative weights; remainder = neutral white).
const TINTS: { rgb: [number, number, number]; weight: number }[] = [
  { rgb: [255, 210, 77], weight: 0.24 }, // warm gold
  { rgb: [71, 180, 235], weight: 0.2 }, // cool blue
  { rgb: [237, 94, 190], weight: 0.06 }, // rare pink
  { rgb: [235, 232, 226], weight: 1 }, // neutral (catch-all)
];

const TWINKLE_CHANCE = 0.5; // fraction of specks that twinkle
const TWINKLE_SPEED_MIN = 0.6; // rad/s
const TWINKLE_SPEED_MAX = 2.0; // rad/s
const TWINKLE_DEPTH = 0.65; // fraction of a speck's alpha the twinkle dips

const HALO_MIN_ALPHA = 0.28; // stars at least this bright get a glow halo
const HALO_SCALE = 9; // halo radius = core radius * this
const HALO_ALPHA = 0.55; // halo opacity relative to the star's alpha

// Shooting stars.
const SHOOT_MIN_GAP = 4000; // ms between spawns (randomized in this range)
const SHOOT_MAX_GAP = 8000;
const SHOOT_SPEED_MIN = 900; // px/s
const SHOOT_SPEED_MAX = 1350;
const SHOOT_TAIL = 220; // px tail length
const SHOOT_ALPHA = 0.85; // peak head brightness
const MAX_DPR = 2;
// -----------------------------------------------------------------------------

type Star = {
  x: number;
  y: number;
  r: number;
  a: number;
  speed: number;
  tint: number; // index into TINTS
  halo: boolean;
  twSpeed: number; // 0 = no twinkle
  twPhase: number;
};

type Shot = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  born: number;
  life: number; // seconds
};

const makeHaloSprite = (
  rgb: [number, number, number],
  size: number,
): HTMLCanvasElement => {
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const g = c.getContext("2d");
  if (g) {
    const half = size / 2;
    const grad = g.createRadialGradient(half, half, 0, half, half, half);
    grad.addColorStop(0, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.8)`);
    grad.addColorStop(0.35, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.25)`);
    grad.addColorStop(1, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
  }
  return c;
};

export default function StarfieldBackground() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    const epoch = performance.now();

    const haloSprites = TINTS.map((t) => makeHaloSprite(t.rgb, 64));
    const coreStyles = TINTS.map(
      (t) => `rgb(${t.rgb[0]},${t.rgb[1]},${t.rgb[2]})`,
    );

    let raf = 0;
    let running = false;
    let last = 0;
    let width = 0;
    let height = 0;
    let stars: Star[] = [];
    let shots: Shot[] = [];
    let nextShotAt = epoch + 1500 + Math.random() * 2500;

    const lerp = (min: number, max: number) =>
      min + Math.random() * (max - min);

    const pickTint = (): number => {
      const roll = Math.random();
      let acc = 0;
      for (let i = 0; i < TINTS.length; i++) {
        acc += TINTS[i].weight;
        if (roll < acc) return i;
      }
      return TINTS.length - 1;
    };

    const seed = () => {
      stars = [];
      for (const layer of LAYERS) {
        const count = Math.ceil((width * height) / layer.area);
        for (let i = 0; i < count; i++) {
          const a = lerp(layer.aMin, layer.aMax);
          stars.push({
            x: Math.random() * width,
            y: Math.random() * height,
            r: lerp(layer.rMin, layer.rMax),
            a,
            speed: layer.speed,
            tint: pickTint(),
            halo: a >= HALO_MIN_ALPHA,
            twSpeed:
              Math.random() < TWINKLE_CHANCE
                ? lerp(TWINKLE_SPEED_MIN, TWINKLE_SPEED_MAX)
                : 0,
            twPhase: Math.random() * Math.PI * 2,
          });
        }
      }
    };

    const spawnShot = (now: number) => {
      const dir = Math.random() < 0.5 ? 1 : -1;
      const angle = ((10 + Math.random() * 25) * Math.PI) / 180; // downward tilt
      const speed = lerp(SHOOT_SPEED_MIN, SHOOT_SPEED_MAX);
      shots.push({
        x: dir > 0 ? -60 : width + 60,
        y: height * (0.05 + Math.random() * 0.45),
        vx: Math.cos(angle) * speed * dir,
        vy: Math.sin(angle) * speed,
        born: now,
        life: lerp(0.9, 1.4),
      });
    };

    const drawShot = (s: Shot, now: number) => {
      const t = (now - s.born) / 1000;
      const env = Math.sin(Math.PI * Math.min(1, t / s.life)); // fade in/out
      if (env <= 0) return;
      const speed = Math.hypot(s.vx, s.vy);
      const nx = s.vx / speed;
      const ny = s.vy / speed;
      const tailX = s.x - nx * SHOOT_TAIL;
      const tailY = s.y - ny * SHOOT_TAIL;

      const grad = ctx.createLinearGradient(s.x, s.y, tailX, tailY);
      grad.addColorStop(0, `rgba(255,250,235,${SHOOT_ALPHA * env})`);
      grad.addColorStop(0.3, `rgba(255,210,77,${SHOOT_ALPHA * env * 0.5})`);
      grad.addColorStop(1, "rgba(255,210,77,0)");
      ctx.strokeStyle = grad;
      ctx.lineWidth = 2;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(tailX, tailY);
      ctx.stroke();

      // Bright head with a halo.
      const headHalo = haloSprites[0]; // gold
      const hr = 16;
      ctx.globalAlpha = env;
      ctx.drawImage(headHalo, s.x - hr, s.y - hr, hr * 2, hr * 2);
      ctx.globalAlpha = 1;
    };

    const draw = (tSec: number, now: number) => {
      ctx.clearRect(0, 0, width, height);

      // Halos first (additive), so overlapping bright stars bloom.
      ctx.globalCompositeOperation = "lighter";
      for (const s of stars) {
        if (!s.halo) continue;
        let alpha = s.a;
        if (s.twSpeed > 0) {
          alpha *= 1 - TWINKLE_DEPTH * (0.5 + 0.5 * Math.sin(tSec * s.twSpeed + s.twPhase));
        }
        const hr = s.r * HALO_SCALE;
        ctx.globalAlpha = alpha * HALO_ALPHA;
        ctx.drawImage(haloSprites[s.tint], s.x - hr, s.y - hr, hr * 2, hr * 2);
      }

      // Shooting stars (also additive).
      for (const s of shots) drawShot(s, now);
      ctx.globalCompositeOperation = "source-over";

      // Star cores.
      for (const s of stars) {
        let alpha = s.a;
        if (s.twSpeed > 0) {
          alpha *= 1 - TWINKLE_DEPTH * (0.5 + 0.5 * Math.sin(tSec * s.twSpeed + s.twPhase));
        }
        ctx.fillStyle = coreStyles[s.tint];
        ctx.globalAlpha = alpha;
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    };

    const tick = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;

      const margin = 3;
      for (const s of stars) {
        s.x += s.speed * dt * DRIFT_DIR;
        if (s.x < -margin) {
          s.x = width + margin;
          s.y = Math.random() * height;
        } else if (s.x > width + margin) {
          s.x = -margin;
          s.y = Math.random() * height;
        }
      }

      if (now >= nextShotAt) {
        spawnShot(now);
        nextShotAt =
          now + SHOOT_MIN_GAP + Math.random() * (SHOOT_MAX_GAP - SHOOT_MIN_GAP);
      }
      shots = shots.filter((s) => {
        s.x += s.vx * dt;
        s.y += s.vy * dt;
        const age = (now - s.born) / 1000;
        return (
          age <= s.life &&
          s.x > -SHOOT_TAIL - 100 &&
          s.x < width + SHOOT_TAIL + 100 &&
          s.y < height + SHOOT_TAIL + 100
        );
      });

      draw((now - epoch) / 1000, now);
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
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      seed(); // re-scale speck counts to the new viewport
      if (!running) draw(0, performance.now());
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
        shots = [];
        draw(0, performance.now()); // static frame, no shooting stars
      } else {
        start();
      }
    };

    resize();
    window.addEventListener("resize", resize);
    document.addEventListener("visibilitychange", onVisibility);
    mql.addEventListener("change", onMotionChange);
    if (mql.matches) {
      draw(0, performance.now());
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
