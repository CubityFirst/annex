import { useEffect, useRef } from "react";
import { GLYPH_FONT, MONO, gridMetrics, prefersReducedMotion, runLoop } from "./ascii";

// Annex's "tags & graph" view drawn in characters: a small force-directed
// layout of demo docs and tags, edges rasterised into the grid with
// slope-picked glyphs (- / | \), nodes as [ bracketed-labels ]. Hovering a
// node lights its neighbourhood and dims the rest.

const DOCS = [
  "coffee-brewing-guide", "french-press", "cold-brew", "session-12", "hollowmere",
  "the-lich", "runbook-deploy", "editor-tour", "roadmap.excalidraw", "reading-list",
];
const TAGS = ["#coffee", "#campaign", "#ops"];
const EDGES: [string, string][] = [
  ["coffee-brewing-guide", "french-press"], ["coffee-brewing-guide", "cold-brew"],
  ["coffee-brewing-guide", "#coffee"], ["french-press", "#coffee"], ["cold-brew", "#coffee"],
  ["session-12", "hollowmere"], ["session-12", "the-lich"], ["hollowmere", "#campaign"],
  ["the-lich", "#campaign"], ["session-12", "#campaign"], ["runbook-deploy", "#ops"],
  ["roadmap.excalidraw", "runbook-deploy"], ["roadmap.excalidraw", "editor-tour"],
  ["editor-tour", "coffee-brewing-guide"], ["reading-list", "editor-tour"], ["reading-list", "the-lich"],
];

type Node = { id: string; label: string; x: number; y: number; vx: number; vy: number; tag: boolean };

export function AsciiGraph() {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const cv = canvas.current;
    const ctx = cv?.getContext("2d");
    if (!cv || !ctx) return;
    const reduced = prefersReducedMotion();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let w = 0, h = 0, cols = 0, rows = 0, cw = 6, lineH = 11, fontPx = 10;
    let hover: number | null = null;
    let settled = false;

    const nodes: Node[] = [...DOCS, ...TAGS].map((id, i) => {
      const a = (i / (DOCS.length + TAGS.length)) * Math.PI * 2;
      return { id, label: id.startsWith("#") ? ` ${id} ` : `[ ${id} ]`, x: Math.cos(a) * 0.3, y: Math.sin(a) * 0.3, vx: 0, vy: 0, tag: id.startsWith("#") };
    });
    const index = new Map(nodes.map((n, i) => [n.id, i]));
    const edges = EDGES.map(([a, b]) => [index.get(a)!, index.get(b)!] as const);

    // Layout lives in a unit box (aspect-corrected), mapped to the grid on draw.
    const tick = (t: number) => {
      const aspect = w / Math.max(1, h);
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j];
          const dx = (a.x - b.x) * aspect, dy = a.y - b.y;
          const d2 = Math.max(0.002, dx * dx + dy * dy);
          const f = 0.00035 / d2;
          a.vx += dx * f; a.vy += dy * f; b.vx -= dx * f; b.vy -= dy * f;
        }
        // Gentle pull to centre plus a slow orbital drift so it never freezes.
        a.vx += -a.x * 0.004 + Math.sin(t * 0.3 + i) * 0.00012;
        a.vy += -a.y * 0.006 + Math.cos(t * 0.27 + i * 1.7) * 0.00012;
      }
      for (const [i, j] of edges) {
        const a = nodes[i], b = nodes[j];
        const dx = b.x - a.x, dy = b.y - a.y;
        const dist = Math.hypot(dx * aspect, dy) || 0.001;
        const f = (dist - 0.2) * 0.014;
        a.vx += (dx / dist) * f; a.vy += (dy / dist) * f;
        b.vx -= (dx / dist) * f; b.vy -= (dy / dist) * f;
      }
      for (const n of nodes) {
        n.vx *= 0.86; n.vy *= 0.86;
        // Keep the whole label inside the box, not just its centre.
        const halfW = cols ? (n.label.length / 2 + 2) / cols : 0.1;
        n.x = Math.max(-0.5 + halfW, Math.min(0.5 - halfW, n.x + n.vx));
        n.y = Math.max(-0.44, Math.min(0.44, n.y + n.vy));
      }
    };

    const toCell = (n: Node) => [Math.round((n.x + 0.5) * (cols - 1)), Math.round((n.y + 0.5) * (rows - 1))] as const;

    const draw = () => {
      const grid: string[] = new Array(cols * rows).fill("");
      const tone = new Uint8Array(cols * rows);
      const lit = new Set<number>();
      if (hover !== null) {
        lit.add(hover);
        for (const [i, j] of edges) if (i === hover || j === hover) { lit.add(i); lit.add(j); }
      }
      const put = (x: number, y: number, ch: string, k: number) => {
        if (x < 0 || y < 0 || x >= cols || y >= rows) return;
        const g = y * cols + x;
        if (k >= tone[g]) { grid[g] = ch; tone[g] = k; }
      };
      for (const [i, j] of edges) {
        const [x0, y0] = toCell(nodes[i]);
        const [x1, y1] = toCell(nodes[j]);
        const on = hover !== null && (i === hover || j === hover);
        const k = hover === null ? 2 : on ? 4 : 1;
        // Slope in screen space picks the glyph.
        const ang = Math.atan2((y1 - y0) * lineH, (x1 - x0) * cw);
        const oct = ((Math.round(ang / (Math.PI / 4)) % 4) + 4) % 4;
        const ch = ["-", "\\", "|", "/"][oct];
        const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
        for (let s = 0; s <= steps; s++) {
          const x = Math.round(x0 + ((x1 - x0) * s) / (steps || 1));
          const y = Math.round(y0 + ((y1 - y0) * s) / (steps || 1));
          put(x, y, on || s % 2 === 0 ? ch : "·", k);
        }
      }
      nodes.forEach((n, i) => {
        const [cx, cy] = toCell(n);
        const k = hover === null ? (n.tag ? 4 : 5) : lit.has(i) ? 5 : 2;
        const start = cx - Math.floor(n.label.length / 2);
        // Clear a gutter around the label so edges don't touch it.
        for (let c = -1; c <= n.label.length; c++) put(start + c, cy, " ", 6);
        for (let c = 0; c < n.label.length; c++) put(start + c, cy, n.label[c], 7 + k);
      });

      ctx.clearRect(0, 0, w, h);
      ctx.font = `${fontPx}px ${GLYPH_FONT}`;
      ctx.textBaseline = "middle";
      for (let k = 1; k < MONO.length; k++) {
        ctx.fillStyle = MONO[k];
        for (let g = 0; g < grid.length; g++) {
          const tk = tone[g] > 6 ? tone[g] - 7 : tone[g];
          if (tk !== k || !grid[g] || grid[g] === " ") continue;
          ctx.fillText(grid[g], (g % cols) * cw, (Math.floor(g / cols) + 0.5) * lineH);
        }
      }
    };

    const resize = () => {
      const r = cv.getBoundingClientRect();
      w = r.width; h = r.height;
      cv.width = Math.max(1, Math.round(w * dpr));
      cv.height = Math.max(1, Math.round(h * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ({ fontPx, lineH, cw, cols, rows } = gridMetrics(ctx, w, h));
      // Settle the layout once real dimensions are known (forces use the aspect).
      if (!settled && w > 0) {
        for (let i = 0; i < 500; i++) tick(i / 30);
        settled = true;
      }
      draw();
    };

    const onMove = (e: PointerEvent) => {
      const r = cv.getBoundingClientRect();
      const x = (e.clientX - r.left) / cw, y = (e.clientY - r.top) / lineH;
      hover = null;
      nodes.forEach((n, i) => {
        const [cx, cy] = toCell(n);
        if (Math.abs(y - cy - 0.5) < 1.2 && Math.abs(x - cx) < n.label.length / 2 + 1) hover = i;
      });
      cv.style.cursor = hover === null ? "default" : "pointer";
      if (reduced) draw();
    };
    const onLeave = () => { hover = null; if (reduced) draw(); };

    const ro = new ResizeObserver(resize);
    ro.observe(cv);
    document.fonts?.ready.then(resize).catch(() => {});
    cv.addEventListener("pointermove", onMove);
    cv.addEventListener("pointerleave", onLeave);
    const stop = reduced ? () => {} : runLoop(cv, 30, (t) => { tick(t); draw(); });
    return () => {
      stop();
      ro.disconnect();
      cv.removeEventListener("pointermove", onMove);
      cv.removeEventListener("pointerleave", onLeave);
    };
  }, []);

  return (
    <figure className="th-graph">
      <canvas ref={canvas} aria-hidden="true" />
      <figcaption className="sr-only">
        A graph of linked docs: {EDGES.map(([a, b]) => `${a} links to ${b}`).join(", ")}.
      </figcaption>
    </figure>
  );
}
