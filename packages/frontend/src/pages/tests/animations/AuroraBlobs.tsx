// /test/animations variant: Aurora Blobs
// A full living aurora: five large blurred Ink-hued blobs (gold / pink /
// blue / teal / violet) drifting on overlapping loops, blended with
// mix-blend-mode: screen so overlaps glow additively, plus a slow
// hue-rotate cycle on the wrapper so the whole field shifts color.
// Pure CSS keyframes; blur is applied statically and only transform /
// opacity / a whole-layer hue-rotate are animated (all compositor-friendly).

// ---- Tuning knobs ---------------------------------------------------------
/** Peak opacity per blob (aurora range: 0.15–0.30). */
const BLOB_OPACITY = {
  gold: 0.26,
  pink: 0.2,
  blue: 0.24,
  teal: 0.17,
  violet: 0.19,
};
/** Static blur radius applied to each blob (px). Not animated. */
const BLUR_PX = 70;
/** Blob diameters — capped so huge monitors don't pay a huge blur cost. */
const BLOB_SIZE_LG = "min(58vmax, 940px)";
const BLOB_SIZE_SM = "min(42vmax, 680px)";
/** Drift-cycle durations per blob (seconds). Lively but not frantic. */
const DURATIONS = { gold: 19, pink: 27, blue: 23, teal: 33, violet: 37 };
/** One full hue-rotate cycle across the whole field (seconds). */
const HUE_CYCLE_S = 50;
// ---------------------------------------------------------------------------

const P = "at-aurora"; // unique prefix for classes/keyframes

const css = `
.${P}-layer {
  position: fixed;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  overflow: hidden;
}
.${P}-field {
  position: absolute;
  inset: 0;
  will-change: filter;
  animation: ${P}-hue ${HUE_CYCLE_S}s linear infinite;
}
.${P}-blob {
  position: absolute;
  width: ${BLOB_SIZE_LG};
  height: ${BLOB_SIZE_LG};
  border-radius: 50%;
  filter: blur(${BLUR_PX}px);
  mix-blend-mode: screen;
  will-change: transform;
  animation-timing-function: ease-in-out;
  animation-iteration-count: infinite;
}
.${P}-gold {
  top: -24%;
  left: -16%;
  opacity: ${BLOB_OPACITY.gold};
  background: radial-gradient(circle at 50% 50%, hsl(45 100% 65%) 0%, hsl(45 100% 65% / 0.4) 38%, transparent 70%);
  animation-name: ${P}-drift-a;
  animation-duration: ${DURATIONS.gold}s;
}
.${P}-pink {
  top: 22%;
  right: -22%;
  opacity: ${BLOB_OPACITY.pink};
  background: radial-gradient(circle at 50% 50%, hsl(320 80% 65%) 0%, hsl(320 80% 65% / 0.4) 38%, transparent 70%);
  animation-name: ${P}-drift-b;
  animation-duration: ${DURATIONS.pink}s;
}
.${P}-blue {
  bottom: -30%;
  left: 12%;
  opacity: ${BLOB_OPACITY.blue};
  background: radial-gradient(circle at 50% 50%, hsl(200 80% 60%) 0%, hsl(200 80% 60% / 0.4) 38%, transparent 70%);
  animation-name: ${P}-drift-c;
  animation-duration: ${DURATIONS.blue}s;
}
.${P}-teal {
  width: ${BLOB_SIZE_SM};
  height: ${BLOB_SIZE_SM};
  top: 8%;
  left: 32%;
  opacity: ${BLOB_OPACITY.teal};
  background: radial-gradient(circle at 50% 50%, hsl(170 80% 55%) 0%, hsl(170 80% 55% / 0.4) 38%, transparent 70%);
  animation-name: ${P}-drift-d;
  animation-duration: ${DURATIONS.teal}s;
}
.${P}-violet {
  width: ${BLOB_SIZE_SM};
  height: ${BLOB_SIZE_SM};
  bottom: 4%;
  right: 8%;
  opacity: ${BLOB_OPACITY.violet};
  background: radial-gradient(circle at 50% 50%, hsl(265 85% 65%) 0%, hsl(265 85% 65% / 0.4) 38%, transparent 70%);
  animation-name: ${P}-drift-a;
  animation-duration: ${DURATIONS.violet}s;
  animation-delay: ${-DURATIONS.violet / 2}s;
}
@keyframes ${P}-drift-a {
  0%   { transform: translate3d(0, 0, 0) scale(1); }
  33%  { transform: translate3d(20vw, 14vh, 0) scale(1.28); }
  66%  { transform: translate3d(-10vw, 22vh, 0) scale(0.86); }
  100% { transform: translate3d(0, 0, 0) scale(1); }
}
@keyframes ${P}-drift-b {
  0%   { transform: translate3d(0, 0, 0) scale(1); }
  30%  { transform: translate3d(-22vw, -12vh, 0) scale(0.85); }
  65%  { transform: translate3d(-9vw, 16vh, 0) scale(1.3); }
  100% { transform: translate3d(0, 0, 0) scale(1); }
}
@keyframes ${P}-drift-c {
  0%   { transform: translate3d(0, 0, 0) scale(1); }
  38%  { transform: translate3d(18vw, -18vh, 0) scale(1.24); }
  70%  { transform: translate3d(-16vw, -6vh, 0) scale(0.88); }
  100% { transform: translate3d(0, 0, 0) scale(1); }
}
@keyframes ${P}-drift-d {
  0%   { transform: translate3d(0, 0, 0) scale(1); }
  45%  { transform: translate3d(-14vw, 18vh, 0) scale(1.32); }
  75%  { transform: translate3d(12vw, 6vh, 0) scale(0.9); }
  100% { transform: translate3d(0, 0, 0) scale(1); }
}
@keyframes ${P}-hue {
  from { filter: hue-rotate(0deg); }
  to   { filter: hue-rotate(360deg); }
}
@media (prefers-reduced-motion: reduce) {
  .${P}-blob, .${P}-field { animation: none !important; }
}
`;

export default function AuroraBlobsBackground() {
  return (
    <div aria-hidden className={`${P}-layer`}>
      <style>{css}</style>
      <div className={`${P}-field`}>
        <div className={`${P}-blob ${P}-gold`} />
        <div className={`${P}-blob ${P}-pink`} />
        <div className={`${P}-blob ${P}-blue`} />
        <div className={`${P}-blob ${P}-teal`} />
        <div className={`${P}-blob ${P}-violet`} />
      </div>
    </div>
  );
}
