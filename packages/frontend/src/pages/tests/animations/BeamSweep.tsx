// /test/animations variant: Beam Sweep
// Two staggered diagonal light beams sweeping the page every ~9s. The
// primary beam is prismatic — a bright warm-white core with faint Annex Ink
// tints (gold / pink / blue) across its width and a thin near-white glint on
// its leading edge; the secondary beam is a narrower warm-white chaser at a
// slightly different tilt for depth. Pure CSS keyframes: the gradient strips
// are static; only transform animates.

// ---- Tuning knobs ---------------------------------------------------------
/** Full cycle length (seconds): sweep + rest before the next pass. */
const CYCLE_S = 9;
/** Fraction of the cycle spent actually crossing the page (0–1). */
const SWEEP_FRACTION = 0.55;
/** Peak alpha of the primary beam's warm-white core. */
const CORE_ALPHA = 0.17;
/** Alpha of the wide soft halo around the core. */
const HALO_ALPHA = 0.06;
/** Alpha of the Ink prism tints flanking the core. */
const PRISM_ALPHA = 0.1;
/** Alpha of the thin bright glint on the beam's leading edge. */
const GLINT_ALPHA = 0.28;
/** Secondary (chaser) beam core alpha. */
const CHASER_ALPHA = 0.1;
/** Beam tilts in degrees (slightly different for depth). */
const TILT_A_DEG = 24;
const TILT_B_DEG = 19;
/** Beam strip widths. */
const BEAM_WIDTH_A = "min(48vmax, 760px)";
const BEAM_WIDTH_B = "min(26vmax, 400px)";
// ---------------------------------------------------------------------------

const P = "at-beam"; // unique prefix for classes/keyframes
const SWEEP_END = Math.round(SWEEP_FRACTION * 100);

const sweepKeyframes = (name: string, tiltDeg: number) => `
@keyframes ${name} {
  0% {
    transform: translate3d(calc(-50% - 100vw), -50%, 0) rotate(${tiltDeg}deg);
  }
  ${SWEEP_END}% {
    transform: translate3d(calc(-50% + 100vw), -50%, 0) rotate(${tiltDeg}deg);
  }
  100% {
    transform: translate3d(calc(-50% + 100vw), -50%, 0) rotate(${tiltDeg}deg);
  }
}`;

const css = `
.${P}-layer {
  position: fixed;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  overflow: hidden;
}
.${P}-strip {
  position: absolute;
  top: 50%;
  left: 50%;
  height: 260vmax;
  will-change: transform;
}
.${P}-prism {
  width: ${BEAM_WIDTH_A};
  background: linear-gradient(
    90deg,
    rgba(232, 228, 222, 0) 0%,
    rgba(232, 228, 222, ${HALO_ALPHA}) 22%,
    hsl(45 100% 65% / ${PRISM_ALPHA}) 36%,
    hsl(320 80% 65% / ${PRISM_ALPHA}) 46%,
    rgba(232, 228, 222, ${CORE_ALPHA}) 51%,
    hsl(200 80% 60% / ${PRISM_ALPHA}) 58%,
    rgba(255, 252, 245, 0) 66%,
    rgba(255, 252, 245, ${GLINT_ALPHA}) 69%,
    rgba(255, 252, 245, 0) 72%,
    rgba(232, 228, 222, ${HALO_ALPHA * 0.7}) 82%,
    rgba(232, 228, 222, 0) 100%
  );
  animation: ${P}-sweep-a ${CYCLE_S}s linear infinite;
}
.${P}-chaser {
  width: ${BEAM_WIDTH_B};
  background: linear-gradient(
    90deg,
    rgba(232, 228, 222, 0) 0%,
    rgba(232, 228, 222, ${CHASER_ALPHA * 0.4}) 32%,
    rgba(232, 228, 222, ${CHASER_ALPHA}) 50%,
    rgba(232, 228, 222, ${CHASER_ALPHA * 0.4}) 68%,
    rgba(232, 228, 222, 0) 100%
  );
  animation: ${P}-sweep-b ${CYCLE_S}s linear infinite;
  animation-delay: ${-CYCLE_S / 2}s;
}
${sweepKeyframes(`${P}-sweep-a`, TILT_A_DEG)}
${sweepKeyframes(`${P}-sweep-b`, TILT_B_DEG)}
@media (prefers-reduced-motion: reduce) {
  /* A frozen mid-page beam would look like a rendering glitch; hide them. */
  .${P}-strip { display: none; }
}
`;

export default function BeamSweepBackground() {
  return (
    <div aria-hidden className={`${P}-layer`}>
      <style>{css}</style>
      <div className={`${P}-strip ${P}-prism`} />
      <div className={`${P}-strip ${P}-chaser`} />
    </div>
  );
}
