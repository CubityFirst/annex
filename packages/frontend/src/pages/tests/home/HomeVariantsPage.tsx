import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { getToken } from "@/lib/auth";
import { roll } from "@/lib/dice";
import { AnnexLogo } from "@/components/AnnexLogo";
import { SiteFooter } from "@/components/SiteFooter";
import shotRead from "@/assets/landing/write.webp";
import shotEdit from "@/assets/landing/editor.webp";
import shotDraw from "@/assets/landing/draw.webp";
import shotPublish from "@/assets/landing/publish.webp";
import { DitherField } from "./DitherField";
import { DitherLens } from "./DitherLens";
import { GrainSmoke, type SmokeHandle } from "./GrainSmoke";
import { AsciiField } from "./AsciiField";
import { BAYER8, TreatedImage, type Treatment } from "./TreatedImage";
import "../../LandingPage.css";
import "./HomeVariantsPage.css";

// /test/home/:variant - three alternative landing pages exploring "unslop"
// textures: ordered dithering, film-grain smoke and ASCII. Each variant uses
// its technique for something Annex-specific rather than as wallpaper:
//   dither - the hero IS the product, dithered, with a lens that resolves the
//            real UI (dithered edge); dithered gradient type + section fades.
//   smoke  - an editor line in the hero; every keystroke puffs ink smoke from
//            the caret. Enter keeps the line, the rest drifts away.
//   ascii  - the headline is typeset out of a real markdown doc scrolling
//            through the letterforms; pointer decodes glyphs, clicks ripple;
//            screenshots rendered as ASCII; an ASCII dice roller.

type VariantId = "dither" | "smoke" | "ascii";

const VARIANTS: { id: VariantId; label: string }[] = [
  { id: "dither", label: "dither" },
  { id: "smoke", label: "smoke" },
  { id: "ascii", label: "ascii" },
];

const PALETTES: Record<VariantId, string[]> = {
  dither: ["#01030f", "#05125e", "#1a44f0", "#7fa2ff"],
  smoke: ["#020a07", "#0d5a3e", "#7dffc8"],
  ascii: ["#120205", "#4a0912", "#8c1324", "#d81c3a", "#ff5a70", "#ffc2ca"],
};

const TREATMENT: Record<VariantId, Treatment> = { dither: "dither", smoke: "grain", ascii: "ascii" };

const SHOWCASE = [
  {
    eyebrow: "write",
    title: "Markdown underneath. Nothing in the way.",
    body: "Annex renders your markdown as you type - callouts, tables, code, wikilinks and inline dice - and flips to raw text whenever you want it.",
    src: shotEdit,
    alt: "The Annex editor showing formatting, callouts and a code block",
  },
  {
    eyebrow: "organise",
    title: "Your files live next to your words.",
    body: "Images, audio, video, PDFs and Excalidraw drawings sit in the same folders as your docs, with previews inline.",
    src: shotDraw,
    alt: "An Excalidraw drawing open inside Annex",
  },
  {
    eyebrow: "publish",
    title: "Publish it when you're ready.",
    body: "One switch turns a site into a public website with navigation, search and link previews - on your own domain if you like.",
    src: shotPublish,
    alt: "A published Annex site in its public reading view",
  },
];

const EXTRAS = [
  ["version history", "Every save kept. Diff and restore in a click."],
  ["search", "Ctrl+K across titles and full text."],
  ["tags & graph", "See how every page links together."],
  ["organizations", "Roles trickle down to every site."],
  ["rest api", "Scoped keys for docs from your own tools."],
  ["export", "A zip of plain .md files, any time."],
] as const;

const USES = ["technical docs", "tabletop campaigns", "personal knowledge", "team wikis", "runbooks", "session notes", "recipes", "specs"];

// Fills the ASCII headline. Lifted from the demo's coffee guide.
const DOC_SOURCE = `# Coffee brewing guide
> [!tip] Grind just before you brew.
## Pour-over
- [x] 18g coffee, medium-fine
- [x] 300g water at 94°C
- [ ] bloom 45s, then pour in slow circles
| ratio | strength |
| 1:15 | bold |
| 1:17 | bright |
roll for the perfect cup: \`2d6+1d4\`
see also [[french-press]] #brewing #notes
`;

/** A vertical dithered gradient (from -> to, either may be "transparent") as a data URL. */
function ditherGradient(from: string, to: string, rows = 48, cols = 64) {
  const c = document.createElement("canvas");
  c.width = cols;
  c.height = rows;
  const ctx = c.getContext("2d")!;
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < cols; x++) {
      const t = (y + 0.5) / rows;
      const color = t > BAYER8[(y & 7) * 8 + (x & 7)] ? to : from;
      if (color === "transparent") continue;
      ctx.fillStyle = color;
      ctx.fillRect(x, y, 1, 1);
    }
  return c.toDataURL();
}

/* ─────────────────────────── DITHER ─────────────────────────── */

function DitherHero({ primary }: { primary: { to: string; label: string } }) {
  const textFill = useMemo(() => ditherGradient("#c9d6ff", "#2a55ff", 56, 8), []);
  return (
    <section className="th-hero th-hero-dither">
      <div className="site-wrap">
        <p className="th-kicker">▚ an annex for your mind</p>
        <h1 className="th-dither-title" style={{ backgroundImage: `url(${textFill})` }}>
          A place to keep anything.
        </h1>
        <div className="th-hero-row">
          <p className="th-sub">
            A calm docs workspace for markdown, files and drawings - published to the web
            when you're ready. Move your cursor over the screen below to see it in full resolution.
          </p>
          <div className="th-ctas">
            <Link className="th-btn th-btn-primary" to={primary.to}>{primary.label} <ArrowRight size={16} aria-hidden="true" /></Link>
            <Link className="th-btn" to="/demo">See a demo</Link>
          </div>
        </div>
        <DitherLens src={shotRead} alt="Annex - a calm reading view with an outline, tables and checklists" palette={PALETTES.dither} />
      </div>
    </section>
  );
}

function DitherFade({ from, to }: { from: string; to: string }) {
  const url = useMemo(() => ditherGradient(from, to), [from, to]);
  return <div className="th-fade" aria-hidden="true" style={{ backgroundImage: `url(${url})` }} />;
}

/* ─────────────────────────── SMOKE ─────────────────────────── */

const AUTO_LINES = [
  "grind 18g, bloom for 45 seconds",
  "session 12 - the lich remembers our names",
  "deploy auth before api, then admin",
  "idea: a reading list for the long winter",
];

function SmokeHero({ primary }: { primary: { to: string; label: string } }) {
  const smoke = useRef<SmokeHandle>(null);
  const input = useRef<HTMLInputElement>(null);
  const measure = useRef<CanvasRenderingContext2D | null>(null);
  const [value, setValue] = useState("");
  const [kept, setKept] = useState<string[]>([]);
  const [touched, setTouched] = useState(false);

  const puffAtCaret = (text: string, strength = 1) => {
    const el = input.current;
    if (!el) return;
    measure.current ??= document.createElement("canvas").getContext("2d");
    const m = measure.current!;
    const cs = getComputedStyle(el);
    m.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const r = el.getBoundingClientRect();
    const x = r.left + parseFloat(cs.paddingLeft) + Math.min(m.measureText(text).width - el.scrollLeft, r.width - 40);
    smoke.current?.puff(x, r.top + r.height * 0.3, strength);
  };

  // Ghost-types sample lines until the visitor types themselves.
  useEffect(() => {
    if (touched || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    let line = 0, ch = 0, timer = 0;
    const step = () => {
      const target = AUTO_LINES[line % AUTO_LINES.length];
      if (ch <= target.length) {
        const next = target.slice(0, ch++);
        setValue(next);
        if (next && next.at(-1) !== " ") puffAtCaret(next, 0.3);
        timer = window.setTimeout(step, 55 + Math.random() * 70);
      } else {
        puffAtCaret(target, 1);
        timer = window.setTimeout(() => { setValue(""); line++; ch = 0; step(); }, 1600);
      }
    };
    timer = window.setTimeout(step, 900);
    return () => window.clearTimeout(timer);
  }, [touched]);

  const onChange = (next: string) => {
    if (!touched) setTouched(true);
    setValue(next);
    if (next.length > value.length) puffAtCaret(next.slice(0, input.current?.selectionStart ?? next.length), 0.45);
  };

  const onKeep = (e: FormEvent) => {
    e.preventDefault();
    const line = value.trim();
    if (!line) return;
    puffAtCaret(value, 1.2);
    setKept((k) => [line, ...k].slice(0, 3));
    setValue("");
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") setValue("");
  };

  return (
    <section className="th-hero th-hero-smoke">
      <GrainSmoke className="th-hero-bg" handle={smoke} />
      <div className="site-wrap th-smoke-inner">
        <p className="th-kicker">an annex for your mind</p>
        <h1 className="th-smoke-title">Thoughts drift.<br /><em>Annex keeps them.</em></h1>
        <form className="th-smoke-line" onSubmit={onKeep}>
          <span className="th-smoke-prompt" aria-hidden="true">›</span>
          <input
            ref={input}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onFocus={() => { if (!touched) { setTouched(true); setValue(""); } }}
            onKeyDown={onKeyDown}
            placeholder="type a thought, press enter to keep it"
            aria-label="Try it: type a thought and press enter to keep it"
            spellCheck={false}
            autoComplete="off"
          />
          <kbd aria-hidden="true">enter</kbd>
        </form>
        <ul className="th-smoke-kept" aria-live="polite">
          {kept.map((k, i) => <li key={`${k}-${kept.length - i}`}><span>kept</span>{k}</li>)}
        </ul>
        <div className="th-ctas">
          <Link className="th-btn th-btn-primary" to={primary.to}>{primary.label} <ArrowRight size={16} aria-hidden="true" /></Link>
          <Link className="th-btn" to="/demo">See a demo</Link>
        </div>
      </div>
    </section>
  );
}

/* ─────────────────────────── ASCII ─────────────────────────── */

function AsciiHero({ primary }: { primary: { to: string; label: string } }) {
  const title = useRef<HTMLHeadingElement>(null);
  return (
    <section className="th-hero th-hero-ascii">
      <AsciiField className="th-hero-bg" textRoot={title} source={DOC_SOURCE} palette={PALETTES.ascii} />
      <div className="site-wrap th-ascii-inner">
        <p className="th-kicker">$ annex --keep anything</p>
        <h1 ref={title} className="th-ascii-title">
          <span data-ascii-line>Keep</span>
          <span data-ascii-line>anything.</span>
        </h1>
        <p className="th-sub">
          The letters above are a real markdown doc. Annex keeps your writing as plain text,
          renders it beautifully, and publishes it when you're ready. Click anywhere to send a ripple.
        </p>
        <div className="th-ctas">
          <Link className="th-btn th-btn-primary" to={primary.to}>{primary.label} <ArrowRight size={16} aria-hidden="true" /></Link>
          <Link className="th-btn" to="/demo">See a demo</Link>
        </div>
      </div>
    </section>
  );
}

const DICE = ["1d20", "2d6+1d4", "4d6kh3", "1d100"];

function AsciiDice() {
  const [notation, setNotation] = useState(DICE[1]);
  const [shown, setShown] = useState("--");
  const [rolling, setRolling] = useState(false);

  const doRoll = (n = notation) => {
    if (rolling) return;
    const result = roll(n);
    const max = result.maxTotal ?? 20;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      setShown(String(result.total));
      return;
    }
    setRolling(true);
    let ticks = 0;
    const id = window.setInterval(() => {
      if (++ticks > 14) {
        window.clearInterval(id);
        setShown(String(result.total));
        setRolling(false);
        return;
      }
      setShown(String(1 + Math.floor(Math.random() * max)));
    }, 45 + ticks * 4);
  };

  const pad = (s: string, n: number) => s.padStart(Math.ceil((n + s.length) / 2)).padEnd(n);
  const W = 16;
  return (
    <div className="th-dice">
      <pre aria-hidden="true">
        {`┌${"─".repeat(W)}┐\n│${pad(notation, W)}│\n│${pad(`[ ${shown} ]`, W)}│\n└${"─".repeat(W)}┘`}
      </pre>
      <span className="sr-only" aria-live="polite">{rolling ? "" : `Rolled ${notation}: ${shown}`}</span>
      <div className="th-dice-opts">
        {DICE.map((d) => (
          <button key={d} type="button" aria-pressed={d === notation} onClick={() => { setNotation(d); doRoll(d); }}>{d}</button>
        ))}
      </div>
      <p>Inline dice rolls are real Annex syntax - write <code>{notation}</code> in any doc and click to roll.</p>
    </div>
  );
}

function AsciiCta({ primary }: { primary: { to: string; label: string } }) {
  const title = useRef<HTMLHeadingElement>(null);
  return (
    <section className="th-cta th-cta-ascii">
      <AsciiField className="th-hero-bg" textRoot={title} source={DOC_SOURCE} palette={PALETTES.ascii} />
      <div className="site-wrap th-cta-inner">
        <h2 ref={title} className="th-ascii-title th-ascii-title-sm"><span data-ascii-line>Your annex.</span></h2>
        <div className="th-ctas">
          <Link className="th-btn th-btn-primary" to={primary.to}>{primary.label} <ArrowRight size={16} aria-hidden="true" /></Link>
        </div>
      </div>
    </section>
  );
}

/* ─────────────────────────── PAGE ─────────────────────────── */

export function HomeVariantsPage() {
  const { variant: raw } = useParams();
  const variant: VariantId = VARIANTS.some((v) => v.id === raw) ? (raw as VariantId) : "dither";
  const isLoggedIn = !!getToken();
  const primary = isLoggedIn
    ? { to: "/dashboard", label: "Open your Annex" }
    : { to: "/register", label: "Create your Annex" };
  const palette = PALETTES[variant];

  // Instrument Serif for the smoke variant's italics; test page only.
  useEffect(() => {
    const id = "th-fonts";
    if (document.getElementById(id)) return;
    const link = document.createElement("link");
    link.id = id;
    link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&display=swap";
    document.head.appendChild(link);
  }, []);

  return (
    <div className={`landing th th-${variant}`}>
      <nav className="th-nav" aria-label="Main">
        <div className="th-nav-inner">
          <Link to="/" aria-label="Annex home"><AnnexLogo height={20} /></Link>
          <div className="th-nav-links">
            <a href="#features">features</a>
            <a href="#pricing">pricing</a>
            {!isLoggedIn && <Link to="/login">login</Link>}
            <Link className="th-nav-cta" to={primary.to}>{isLoggedIn ? "dashboard" : "get started"}</Link>
          </div>
        </div>
      </nav>

      <main>
        {variant === "dither" && <DitherHero primary={primary} />}
        {variant === "smoke" && <SmokeHero primary={primary} />}
        {variant === "ascii" && <AsciiHero primary={primary} />}

        <section className="th-uses" aria-label="What people keep in Annex">
          <div className="th-uses-track">
            {[...USES, ...USES].map((u, i) => (
              <span key={i} aria-hidden={i >= USES.length}>{u}</span>
            ))}
          </div>
        </section>

        {variant === "dither" && <DitherFade from={palette[0]} to="#030a2a" />}

        <section id="features" className="th-showcase" aria-label="Features">
          {SHOWCASE.map((s, i) => (
            <div key={s.eyebrow} className={`site-wrap th-show${i % 2 ? " th-show-flip" : ""}`}>
              <div className="th-show-copy">
                <p className="th-eyebrow">{String(i + 1).padStart(2, "0")} / {s.eyebrow}</p>
                <h2 className="th-show-title">{s.title}</h2>
                <p className="th-show-body">{s.body}</p>
              </div>
              <TreatedImage src={s.src} alt={s.alt} treatment={TREATMENT[variant]} palette={palette} />
            </div>
          ))}
        </section>

        <section className="th-extras" aria-labelledby="th-extras-label">
          <div className="site-wrap">
            <h2 id="th-extras-label" className="th-eyebrow th-center">and everything else a docs site should do</h2>
            <ul className="th-extras-grid">
              {EXTRAS.map(([title, desc]) => (
                <li key={title} className="th-extra">
                  <h3>{title}</h3>
                  <p>{desc}</p>
                </li>
              ))}
              {variant === "ascii" && <li className="th-extra th-extra-wide"><AsciiDice /></li>}
            </ul>
          </div>
        </section>

        <section id="pricing" className="th-pricing" aria-labelledby="th-pricing-title">
          <div className="site-wrap">
            <h2 id="th-pricing-title" className="th-pricing-title">Free. <span>Ink is optional.</span></h2>
            <div className="th-plans">
              <div className="th-plan">
                <p className="th-eyebrow">annex</p>
                <p className="th-price">$0<span> / month</span></p>
                <p>The whole product, for everyone. No paywall, no missing buttons.</p>
              </div>
              <div className="th-plan th-plan-ink">
                <p className="th-eyebrow">annex ink</p>
                <p className="th-price">$5<span> / month</span></p>
                <p>Chip in and get quietly fancy cosmetics: avatar rings, cursor colours, crit sparkles.</p>
              </div>
            </div>
          </div>
        </section>

        {variant === "dither" && (
          <section className="th-cta">
            <DitherField className="th-hero-bg" />
            <div className="site-wrap th-cta-inner">
              <h2 className="th-cta-title">Ready to build your Annex?</h2>
              <Link className="th-btn th-btn-primary" to={primary.to}>{primary.label} <ArrowRight size={16} aria-hidden="true" /></Link>
            </div>
          </section>
        )}
        {variant === "smoke" && (
          <section className="th-cta">
            <GrainSmoke className="th-hero-bg" ambient={0.8} />
            <div className="site-wrap th-cta-inner">
              <h2 className="th-cta-title">Before it <em>drifts away.</em></h2>
              <Link className="th-btn th-btn-primary" to={primary.to}>{primary.label} <ArrowRight size={16} aria-hidden="true" /></Link>
            </div>
          </section>
        )}
        {variant === "ascii" && <AsciiCta primary={primary} />}
      </main>

      <SiteFooter />

      <nav className="th-switch" aria-label="Test variants">
        <span>test/home</span>
        {VARIANTS.map((v) => (
          <Link key={v.id} to={`/test/home/${v.id}`} aria-current={v.id === variant ? "page" : undefined}>{v.label}</Link>
        ))}
      </nav>
    </div>
  );
}
