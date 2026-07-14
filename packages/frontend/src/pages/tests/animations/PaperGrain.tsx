// /test/animations variant: Paper Grain
// A dramatic living-texture: strong film-grain shimmer (inline SVG
// feTurbulence data-URI tiled, jittered at ~9fps via CSS steps()) layered
// with two large-scale low-frequency turbulence "mottling" sheets that
// counter-drift and slowly scale — the whole background visibly churns like
// paper fibers / smoke — plus a deep breathing vignette that makes the page
// pulse. Pure CSS keyframes; only transform/opacity animate.

// ---- Tuning knobs ---------------------------------------------------------
/** Fine grain layer opacity (dramatic range: 0.10–0.16). */
const GRAIN_OPACITY = 0.13;
/** Fine grain tile size in px (smaller = finer grain, denser tiling). */
const TILE_PX = 128;
/** Fine grain feTurbulence base frequency — higher = finer speckle. */
const BASE_FREQUENCY = 0.9;
/** One jitter loop (seconds). 8 frames / 0.9s ≈ 9 fps shimmer. */
const JITTER_S = 0.9;
/** Mottling (smoke) sheets: tile size, turbulence frequency, opacities. */
const MOTTLE_TILE_PX = 512;
const MOTTLE_FREQUENCY = 0.008;
const MOTTLE_OPACITY_A = 0.16;
const MOTTLE_OPACITY_B = 0.12;
/** Mottle drift-cycle durations (seconds); the two sheets counter-drift. */
const MOTTLE_DRIFT_A_S = 38;
const MOTTLE_DRIFT_B_S = 55;
/** Vignette: darkest-edge alpha, breath length, and low end of the pulse. */
const VIGNETTE_ALPHA = 0.45;
const BREATH_S = 7;
const VIGNETTE_MIN = 0.35;
// ---------------------------------------------------------------------------

const P = "at-grain"; // unique prefix for classes/keyframes

const noiseSvg = (size: number, frequency: number, octaves: number) =>
  `<svg xmlns='http://www.w3.org/2000/svg' width='${size}' height='${size}'>` +
  `<filter id='n'>` +
  `<feTurbulence type='fractalNoise' baseFrequency='${frequency}' numOctaves='${octaves}' stitchTiles='stitch'/>` +
  `<feColorMatrix type='saturate' values='0'/>` +
  `</filter>` +
  `<rect width='100%' height='100%' filter='url(#n)'/>` +
  `</svg>`;

// Fine monochrome speckle (film grain) + large soft monochrome mottle (smoke).
const GRAIN_URI =
  "data:image/svg+xml," + encodeURIComponent(noiseSvg(TILE_PX, BASE_FREQUENCY, 2));
const MOTTLE_URI =
  "data:image/svg+xml," +
  encodeURIComponent(noiseSvg(MOTTLE_TILE_PX, MOTTLE_FREQUENCY, 3));

const css = `
.${P}-layer {
  position: fixed;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  overflow: hidden;
}
.${P}-mottle {
  position: absolute;
  inset: -60%;
  background-image: url("${MOTTLE_URI}");
  background-repeat: repeat;
  background-size: ${MOTTLE_TILE_PX}px ${MOTTLE_TILE_PX}px;
  mix-blend-mode: screen;
  will-change: transform;
  animation-timing-function: ease-in-out;
  animation-iteration-count: infinite;
  animation-direction: alternate;
}
.${P}-mottle-a {
  opacity: ${MOTTLE_OPACITY_A};
  animation-name: ${P}-churn-a;
  animation-duration: ${MOTTLE_DRIFT_A_S}s;
}
.${P}-mottle-b {
  opacity: ${MOTTLE_OPACITY_B};
  animation-name: ${P}-churn-b;
  animation-duration: ${MOTTLE_DRIFT_B_S}s;
}
.${P}-noise {
  position: absolute;
  inset: -100%;
  background-image: url("${GRAIN_URI}");
  background-repeat: repeat;
  background-size: ${TILE_PX}px ${TILE_PX}px;
  opacity: ${GRAIN_OPACITY};
  will-change: transform;
  animation: ${P}-jitter ${JITTER_S}s steps(1, end) infinite;
}
.${P}-vignette {
  position: absolute;
  inset: 0;
  background: radial-gradient(
    ellipse at 50% 45%,
    rgba(0, 0, 0, 0) 48%,
    rgba(0, 0, 0, ${VIGNETTE_ALPHA}) 100%
  );
  opacity: 1;
  will-change: opacity;
  animation: ${P}-breathe ${BREATH_S}s ease-in-out infinite alternate;
}
@keyframes ${P}-churn-a {
  from { transform: translate3d(-8%, -6%, 0) scale(1); }
  to   { transform: translate3d(8%, 6%, 0) scale(1.18); }
}
@keyframes ${P}-churn-b {
  from { transform: translate3d(7%, 5%, 0) scale(1.15); }
  to   { transform: translate3d(-7%, -7%, 0) scale(1); }
}
@keyframes ${P}-jitter {
  0%, 100% { transform: translate3d(0, 0, 0); }
  12.5%    { transform: translate3d(-3%, -5%, 0); }
  25%      { transform: translate3d(4%, -2%, 0); }
  37.5%    { transform: translate3d(-5%, 3%, 0); }
  50%      { transform: translate3d(2%, 6%, 0); }
  62.5%    { transform: translate3d(6%, 1%, 0); }
  75%      { transform: translate3d(-2%, -6%, 0); }
  87.5%    { transform: translate3d(5%, 4%, 0); }
}
@keyframes ${P}-breathe {
  from { opacity: ${VIGNETTE_MIN}; }
  to   { opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .${P}-noise, .${P}-vignette, .${P}-mottle { animation: none !important; }
}
`;

export default function PaperGrainBackground() {
  return (
    <div aria-hidden className={`${P}-layer`}>
      <style>{css}</style>
      <div className={`${P}-mottle ${P}-mottle-a`} />
      <div className={`${P}-mottle ${P}-mottle-b`} />
      <div className={`${P}-noise`} />
      <div className={`${P}-vignette`} />
    </div>
  );
}
