import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { GLYPH_FONT, MONO, buildTextMask, hash, prefersReducedMotion, runLoop } from "./ascii";

// Scroll-driven: the hero opens on a raw markdown file laid out as plain
// monospace text. As you scroll through the (tall, sticky) section, every
// character leaves its place in the file and flies, left-to-right in a
// staggered sweep, into a cell of the giant headline - the same characters,
// rearranged. Characters the headline doesn't need sink away. The headline
// itself is real DOM text (transparent), traced into a mask for the targets.

const SYNTAX = new Set("#-*[]|>`_=:".split(""));

export const ASSEMBLE_DOC = `# Coffee brewing guide
A sample doc. Annex is at home with anything structured: specs, notebooks, recipes, trip plans.

> [!tip] House rule
> "Weigh everything. Guessing is how you end up with sad coffee."

## Brew ratios
| Method      | Coffee | Water | Time |
| ----------- | ------ | ----- | ---- |
| V60         | 15 g   | 250 g | 2:30 |
| French press| 30 g   | 500 g | 4:00 |
| Aeropress   | 17 g   | 230 g | 1:30 |

## Can't decide?
Let the dice pick today's brewer: \`1d4\` - then roll \`2d6+1d4\` for the grind.

## Shopping list
- [x] Light roast, Ethiopia
- [x] Paper filters (V60 02)
- [ ] Burr grinder service
- [ ] New kettle thermometer

See also [[french-press]], [[cold-brew]] and the #coffee tag.

# Session 12 - The Lich Remembers
The party returns to Hollowmere. The innkeeper has been replaced by something that
smiles too widely. Mira rolls \`1d20+5\` to notice the missing shadow.
- [ ] Ask the ferryman about the bell
- [x] Return the borrowed lantern
> The dragon still owes us forty gold.

# Runbook: deploy
1. Apply remote migrations first.
2. Deploy auth, then api, then admin.
3. Watch the error rate for ten minutes.
\`\`\`sh
npx wrangler deploy
\`\`\`
`;

type Props = {
  /** The headline; wrap each line in an element with `data-ascii-line`. */
  title: ReactNode;
  kicker: [string, string];
  children: ReactNode;
};

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export function AsciiAssemble({ title, kicker, children }: Props) {
  const section = useRef<HTMLElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const titleRoot = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const sec = section.current;
    const cv = canvas.current;
    const ctx = cv?.getContext("2d");
    if (!sec || !cv || !ctx) return;
    const reduced = prefersReducedMotion();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    let w = 0, h = 0, cw = 6.6, lineH = 13, fontPx = 11;
    // Per particle: source x/y, target x/y (NaN = leftover), char, source tone, jitter.
    let sx = new Float32Array(0), sy = sx, tx = sx, ty = sx, jit = sx;
    let tone = new Uint8Array(0);
    let chars: string[] = [];
    let target = reduced ? 1 : 0;
    let shown = target;

    const layout = () => {
      const r = cv.getBoundingClientRect();
      w = r.width; h = r.height;
      cv.width = Math.max(1, Math.round(w * dpr));
      cv.height = Math.max(1, Math.round(h * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const small = w < 700;
      fontPx = small ? 8 : 11;
      lineH = small ? 10 : 13;
      ctx.font = `${fontPx}px ${GLYPH_FONT}`;
      cw = ctx.measureText("M").width || fontPx * 0.6;
      const cols = Math.ceil(w / cw), rows = Math.ceil(h / lineH);

      const mask = buildTextMask(titleRoot.current, r, cols, rows, cw, lineH);
      const targets: number[] = [];
      for (let i = 0; i < mask.length; i++) if (mask[i] > 0.38) targets.push(i);

      // Lay the doc out in side-by-side text columns (a wall of raw files),
      // repeating it only once every column is full.
      const docCols = Math.max(24, Math.min(64, cols - 6));
      const gutter = 6;
      const ncol = Math.max(1, Math.floor((cols - 4) / (docCols + gutter)));
      const left0 = Math.max(2, Math.floor((cols - (ncol * docCols + (ncol - 1) * gutter)) / 2));
      const top = Math.ceil(84 / lineH);
      const bottom = rows - 3;
      const src: { c: number; r: number; ch: string; tone: number }[] = [];
      let colIdx = 0, row = top, pass = 0;
      const lines = ASSEMBLE_DOC.split("\n");
      while (src.length < targets.length + 200 && pass < 40) {
        // Start each pass at a different doc so neighbouring columns differ.
        const start = (pass * 17) % lines.length;
        for (let li = 0; li < lines.length; li++) {
          const raw = lines[(start + li) % lines.length];
          const heading = raw.startsWith("#");
          for (let o = 0; o < Math.max(1, raw.length); o += docCols) {
            if (row > bottom && colIdx < ncol - 1) { colIdx++; row = top; }
            const left = left0 + colIdx * (docCols + gutter);
            const seg = raw.slice(o, o + docCols);
            for (let c = 0; c < seg.length; c++) {
              const ch = seg[c];
              if (ch === " ") continue;
              src.push({ c: left + c, r: row, ch, tone: SYNTAX.has(ch) ? 1 : heading ? 5 : 3 });
            }
            row++;
          }
        }
        pass++;
      }

      const n = src.length;
      sx = new Float32Array(n); sy = new Float32Array(n);
      tx = new Float32Array(n); ty = new Float32Array(n);
      jit = new Float32Array(n);
      tone = new Uint8Array(n);
      chars = new Array(n);
      for (let i = 0; i < n; i++) {
        const s = src[i];
        sx[i] = s.c * cw; sy[i] = (s.r + 0.5) * lineH;
        chars[i] = s.ch; tone[i] = s.tone;
        jit[i] = hash(i, 91);
        if (i < targets.length) {
          const t = targets[i];
          tx[i] = (t % cols) * cw;
          ty[i] = (Math.floor(t / cols) + 0.5) * lineH;
        } else {
          tx[i] = NaN; ty[i] = NaN;
        }
      }
      draw(shown);
    };

    const draw = (p: number) => {
      ctx.clearRect(0, 0, w, h);
      ctx.font = `${fontPx}px ${GLYPH_FONT}`;
      ctx.textBaseline = "middle";
      // Bucket by tone so each colour is one fillStyle change.
      const buckets: number[][] = MONO.map(() => []);
      const px = new Float32Array(sx.length), py = new Float32Array(sx.length);
      for (let i = 0; i < sx.length; i++) {
        const leftover = Number.isNaN(tx[i]);
        const delay = leftover ? 0.05 + jit[i] * 0.3 : (tx[i] / w) * 0.4 + jit[i] * 0.12;
        const q = Math.min(1, Math.max(0, (p - delay) / 0.45));
        const e = easeInOut(q);
        let x: number, y: number, k: number;
        if (leftover) {
          // Unused characters sink and fade out.
          x = sx[i];
          y = sy[i] + e * e * h * 0.6;
          k = Math.round(tone[i] * (1 - e));
          if (k <= 0) continue;
        } else {
          const arc = Math.sin(Math.PI * q) * (jit[i] - 0.5) * 140;
          x = sx[i] + (tx[i] - sx[i]) * e + arc;
          y = sy[i] + (ty[i] - sy[i]) * e - arc * 0.4;
          k = q > 0 && q < 1 ? 5 : q >= 1 ? 4 + (hash(i, Math.floor(performance.now() / 600)) < 0.03 ? 1 : 0) : tone[i];
        }
        if (y < -lineH || y > h + lineH) continue;
        px[i] = x; py[i] = y;
        buckets[k].push(i);
      }
      for (let k = 1; k < MONO.length; k++) {
        ctx.fillStyle = MONO[k];
        for (const i of buckets[k]) ctx.fillText(chars[i], px[i], py[i]);
      }
    };

    const onScroll = () => {
      const r = sec.getBoundingClientRect();
      const span = Math.max(1, r.height - window.innerHeight);
      target = reduced ? 1 : Math.min(1, Math.max(0, -r.top / span));
    };

    const ro = new ResizeObserver(layout);
    ro.observe(cv);
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    document.fonts?.ready.then(layout).catch(() => {});
    const stop = runLoop(cv, 30, () => {
      shown += (target - shown) * 0.18;
      if (Math.abs(target - shown) < 0.0005) shown = target;
      sec.style.setProperty("--p", shown.toFixed(4));
      draw(shown);
    });

    return () => {
      stop();
      ro.disconnect();
      window.removeEventListener("scroll", onScroll);
    };
  }, []);

  return (
    <section ref={section} className="th-assemble-hero" style={{ "--p": 0 } as CSSProperties}>
      <div className="th-assemble-sticky">
        <canvas ref={canvas} className="th-hero-bg" aria-hidden="true" />
        <p className="th-kicker th-assemble-kicker th-assemble-kicker-a" aria-hidden="true">{kicker[0]}</p>
        <div className="site-wrap th-assemble-inner">
          <p className="th-kicker th-assemble-kicker-b">{kicker[1]}</p>
          <div ref={titleRoot}>{title}</div>
          <div className="th-assemble-copy">{children}</div>
        </div>
        <p className="th-assemble-hint" aria-hidden="true">scroll ↓</p>
      </div>
    </section>
  );
}
