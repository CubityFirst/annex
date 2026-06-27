// One-off: render PNG previews of each profile-card badge to the user's
// Desktop. Uses sharp (already in node_modules) to rasterize SVGs built
// from the same lucide path data the React UI uses.

import sharp from "sharp";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const SIZE = 512;

// Each icon's tight bounding box in lucide's 24-unit grid, BEFORE stroke
// caps. The cap radius (half of stroke-width=2 = 1 unit) gets added when
// computing the viewBox so round caps don't clip.
const ICONS = {
  developer: {
    // CodeXml
    paths: [
      "m18 16 4-4-4-4",
      "m6 8-4 4 4 4",
      "m14.5 4-5 16",
    ],
    bbox: { x: 2, y: 4, w: 20, h: 16 },
  },
  beta: {
    // FlaskConical
    paths: [
      "M10 2v7.527a2 2 0 0 1-.211.896L4.72 20.55a1 1 0 0 0 .9 1.45h12.76a1 1 0 0 0 .9-1.45l-5.069-10.127A2 2 0 0 1 14 9.527V2",
      "M8.5 2h7",
      "M7 16h10",
    ],
    bbox: { x: 4.72, y: 2, w: 14.56, h: 20 },
  },
  ink: {
    // Sparkles
    paths: [
      "M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z",
      "M20 3v4",
      "M22 5h-4",
      "M4 17v2",
      "M5 18H3",
    ],
    // The small star at top-right reaches x=22; bottom-left reaches y=19.
    // Big star reaches y≈21.635, x≈21.635. Top-right tip at y≈3.
    bbox: { x: 2.365, y: 2.365, w: 19.635, h: 19.270 },
  },
};

function pathTags(paths) {
  return paths.map(d => `<path d="${d}" />`).join("");
}

// Cap radius = stroke-width / 2 = 1 unit. Add half a unit on top so AA
// pixels at the cap edge don't get clipped on rasterization.
const CAP_PAD = 1.5;

function buildSvg({ paths, bbox, stroke, defs = "" }) {
  // Pad the path bbox with the cap radius, then expand the shorter axis
  // so the viewBox is square - the icon stays centered in the 1:1 PNG
  // canvas and keeps its natural proportions.
  const padded = {
    x: bbox.x - CAP_PAD,
    y: bbox.y - CAP_PAD,
    w: bbox.w + CAP_PAD * 2,
    h: bbox.h + CAP_PAD * 2,
  };
  const side = Math.max(padded.w, padded.h);
  const vbX = padded.x - (side - padded.w) / 2;
  const vbY = padded.y - (side - padded.h) / 2;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="${vbX} ${vbY} ${side} ${side}" shape-rendering="geometricPrecision">
  ${defs}
  <g fill="none"
     stroke="${stroke}"
     stroke-width="2"
     stroke-linecap="round"
     stroke-linejoin="round">
    ${pathTags(paths)}
  </g>
</svg>`;
}

const developerSvg = buildSvg({
  ...ICONS.developer,
  stroke: "#16a34a", // tailwind green-600
});

const betaSvg = buildSvg({
  ...ICONS.beta,
  stroke: "#9333ea", // tailwind purple-600
});

// Ink uses a conic-gradient ring + hue-cycling icon in the app. SVG can't
// animate on the static export, so approximate the visual identity with a
// linear gradient that runs across the same three hues.
const inkSvg = buildSvg({
  ...ICONS.ink,
  stroke: "url(#inkStroke)",
  defs: `<defs>
    <linearGradient id="inkStroke" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%"   stop-color="hsl(45 100% 60%)" />
      <stop offset="50%"  stop-color="hsl(320 80% 60%)" />
      <stop offset="100%" stop-color="hsl(200 80% 55%)" />
    </linearGradient>
  </defs>`,
});

const outDir = join(homedir(), "Desktop", "annex-badges");
await mkdir(outDir, { recursive: true });

const files = [
  ["developer.png", developerSvg],
  ["beta-tester.png", betaSvg],
  ["ink.png", inkSvg],
];

for (const [name, svg] of files) {
  const out = join(outDir, name);
  // Also drop the source SVGs alongside the PNGs in case the user wants
  // to rescale or recolor without re-running this.
  await writeFile(out.replace(/\.png$/, ".svg"), svg);
  await sharp(Buffer.from(svg)).png().toFile(out);
  console.log("wrote", out);
}
