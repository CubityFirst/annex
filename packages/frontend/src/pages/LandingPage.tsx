import { useRef, useState, type KeyboardEvent } from "react";
import { Link } from "react-router-dom";
import {
  ArrowRight,
  Check,
  Code2,
  FileDown,
  Hash,
  History,
  Network,
  Search,
  Sparkles,
  Users,
  type LucideIcon,
} from "lucide-react";
import { getToken } from "@/lib/auth";
import { AnnexLogo } from "@/components/AnnexLogo";
import { InkSparkle } from "@/components/InkSparkle";
import { SiteFooter } from "@/components/SiteFooter";
import shotRead from "@/assets/landing/write.webp";
import shotEdit from "@/assets/landing/editor.webp";
import shotFiles from "@/assets/landing/files.webp";
import shotDraw from "@/assets/landing/draw.webp";
import shotPublish from "@/assets/landing/publish.webp";
import "./LandingPage.css";

const HELP_URL = "https://docs.cubityfir.st/s/help/";

// Hero product viewer. Screenshots are untouched captures of the /demo
// sandbox (demo banner hidden) - regenerate them from the demo, not by hand.
const SHOTS = [
  { key: "read", label: "Read", src: shotRead, path: "demo-site/coffee-brewing-guide", caption: "A calm reading view with an outline, tables, checklists and inline dice." },
  { key: "write", label: "Write", src: shotEdit, path: "demo-site/editor-tour", caption: "Markdown underneath, rendered as you type - callouts, code, wikilinks and more." },
  { key: "organise", label: "Organise", src: shotFiles, path: "demo-site/files", caption: "Docs, uploads and drawings side by side, in folders that make sense to you." },
  { key: "draw", label: "Draw", src: shotDraw, path: "demo-site/roadmap.excalidraw", caption: "A built-in Excalidraw canvas for diagrams, maps and whiteboard thinking." },
  { key: "publish", label: "Publish", src: shotPublish, path: "s/demo-site", caption: "Turn any site into a public, searchable website in one click." },
] as const;

function ProductViewer() {
  const [active, setActive] = useState(0);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const delta = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    const jump = e.key === "Home" ? 0 : e.key === "End" ? SHOTS.length - 1 : null;
    if (!delta && jump === null) return;
    e.preventDefault();
    const next = jump ?? (active + delta + SHOTS.length) % SHOTS.length;
    setActive(next);
    tabs.current[next]?.focus();
  };

  return (
    <div className="l-viewer">
      <div className="l-viewer-tabs" role="tablist" aria-label="Product tour" onKeyDown={onKeyDown}>
        {SHOTS.map((s, i) => (
          <button
            key={s.key}
            ref={(el) => { tabs.current[i] = el; }}
            role="tab"
            id={`l-viewer-tab-${s.key}`}
            aria-selected={active === i}
            aria-controls="l-viewer-panel"
            tabIndex={active === i ? 0 : -1}
            className="l-viewer-tab"
            onClick={() => setActive(i)}
          >
            {s.label}
          </button>
        ))}
      </div>
      <div
        className="l-viewer-frame"
        role="tabpanel"
        id="l-viewer-panel"
        aria-labelledby={`l-viewer-tab-${SHOTS[active].key}`}
      >
        <div className="l-viewer-chrome" aria-hidden="true">
          <span className="l-viewer-dots"><i /><i /><i /></span>
          <span className="l-viewer-url">docs.cubityfir.st/{SHOTS[active].path}</span>
        </div>
        <div className="l-viewer-stage">
          {SHOTS.map((s, i) => (
            <img
              key={s.key}
              src={s.src}
              alt={i === active ? `Annex - ${s.caption}` : ""}
              aria-hidden={i !== active}
              width={1920}
              height={1200}
              decoding="async"
              loading={i === 0 ? "eager" : "lazy"}
              fetchPriority={i === 0 ? "high" : "low"}
              className={i === active ? "is-active" : undefined}
            />
          ))}
        </div>
      </div>
      <p className="l-viewer-caption" aria-live="polite">{SHOTS[active].caption}</p>
    </div>
  );
}

const USES: { title: string; items: string }[] = [
  { title: "Technical docs", items: "API references, runbooks, specs, changelogs" },
  { title: "Tabletop campaigns", items: "Session notes, lore, maps, inline dice rolls" },
  { title: "Personal knowledge", items: "Notes, research, recipes, reading lists" },
  { title: "Team wikis", items: "Handbooks and how-tos with shared roles" },
];

const SHOWCASE: {
  id?: string;
  eyebrow: string;
  title: [string, string];
  body: string;
  points: string[];
  src: string;
  alt: string;
}[] = [
  {
    eyebrow: "Write",
    title: ["Markdown underneath.", "Nothing in the way."],
    body: "Annex renders your markdown as you type, so you get a clean page without giving up plain text. Flip to raw mode any time.",
    points: [
      "Callouts, tables, code blocks and task lists",
      "Wikilinks, tags and a live outline for long docs",
      "Inline dice rolls like 2d6+1d4, right in the text",
    ],
    src: shotEdit,
    alt: "The Annex editor showing formatting, callouts and a code block",
  },
  {
    eyebrow: "Organise",
    title: ["Your files live", "next to your words."],
    body: "Upload images, audio, video, PDFs and text, then preview them inline. Sketch on a built-in Excalidraw canvas without leaving the site.",
    points: [
      "Folders for docs, uploads and drawings together",
      "Uploads up to 50 MB with in-browser previews",
      "Drawings save alongside everything else",
    ],
    src: shotDraw,
    alt: "An Excalidraw drawing open inside Annex",
  },
  {
    id: "publishing",
    eyebrow: "Publish",
    title: ["Publish it", "when you're ready."],
    body: "Any site can become a public website with navigation, search and link previews. Keep it private until it is ready, then switch it on.",
    points: [
      "One switch to publish a whole site",
      "Friendly doc URLs from a slug: in the frontmatter",
      "Your own domain for published sites (early access)",
    ],
    src: shotPublish,
    alt: "A published Annex site in its public reading view",
  },
];

const EXTRAS: { Icon: LucideIcon; title: string; desc: string; early?: boolean }[] = [
  { Icon: History, title: "Version history", desc: "Every save is kept. See what changed and restore an old version in a click." },
  { Icon: Search, title: "Fast search", desc: "Ctrl+K searches titles and full text across every doc in a site." },
  { Icon: Hash, title: "Tags & graph", desc: "Tag pages, then see how everything links together on the graph." },
  { Icon: Network, title: "Organizations", desc: "Group sites under an org and roles trickle down to every one of them." },
  { Icon: Code2, title: "REST API", desc: "Scoped API keys for creating, updating and moving docs from your own tools." },
  { Icon: FileDown, title: "Plain-markdown export", desc: "Download a whole site as a zip of .md files and attachments." },
  { Icon: Users, title: "Live collaboration", desc: "Edit together in real time and see who else is in the doc.", early: true },
  { Icon: Sparkles, title: "AI summaries", desc: "Optional AI-written summaries at the top of your docs.", early: true },
];

const FREE_PERKS = [
  "Unlimited sites and docs",
  "Files, drawings and version history",
  "Public publishing and search",
  "Organizations, roles and the REST API",
];

const INK_PERKS = [
  "Animated avatar ring in four styles",
  "Custom collab cursor colour",
  "A rainbow sparkle by your name",
  "Sparkles when your dice roll a crit",
];

const FAQ: { q: string; a: string }[] = [
  {
    q: "Is Annex really free?",
    a: "Yes. Every feature is available on a free account. Annex Ink is an optional $5/month supporter tier that only adds cosmetic touches.",
  },
  {
    q: "Can I get my data out?",
    a: "Docs are stored as markdown. Site owners can export an entire site as a zip of .md files and attachments whenever they like.",
  },
  {
    q: "What does \"early access\" mean?",
    a: "Live collaboration, AI summaries and custom domains are being rolled out gradually and are switched on per site while they mature.",
  },
  {
    q: "Can I try it before signing up?",
    a: "The demo is a fully working copy of Annex that runs in your browser. Nothing you do there is saved, so feel free to break things.",
  },
];

export function LandingPage() {
  const isLoggedIn = !!getToken();
  const primary = isLoggedIn
    ? { to: "/dashboard", label: "Open your Annex" }
    : { to: "/register", label: "Create your Annex" };

  return (
    <div className="landing">
      {/* NAV */}
      <nav className="l-nav" aria-label="Main">
        <div className="l-nav-inner">
          <Link to="/" aria-label="Annex home"><AnnexLogo height={21} /></Link>
          <div className="l-nav-links">
            <a className="l-nav-link" href="#features">features</a>
            <a className="l-nav-link" href="#publishing">publishing</a>
            <a className="l-nav-link" href="#pricing">pricing</a>
            {!isLoggedIn && <Link className="l-nav-link l-nav-login" to="/login">login</Link>}
            {isLoggedIn
              ? <Link className="l-nav-cta" to="/dashboard">go to dashboard</Link>
              : <Link className="l-nav-cta" to="/register">get started</Link>}
          </div>
        </div>
      </nav>

      <main>
        {/* HERO */}
        <section className="l-hero">
          <div className="site-wrap l-hero-inner">
            <div className="l-hero-pre">an annex for your mind</div>
            <h1 className="l-hero-headline">
              A place to keep <b>anything.</b>
            </h1>
            <p className="l-hero-sub">
              Annex is a calm, flexible docs workspace. Write in markdown, keep
              your files and drawings alongside, and publish any of it to the web
              when you're ready.
            </p>
            <div className="l-hero-ctas">
              <Link className="l-btn-primary" to={primary.to}>
                {primary.label} <ArrowRight size={18} aria-hidden="true" />
              </Link>
              <Link className="l-btn-secondary" to="/demo">See a demo</Link>
            </div>
            <p className="l-hero-note">Free to use · no card required</p>
          </div>
          <div className="site-wrap">
            <ProductViewer />
          </div>
        </section>

        {/* USES */}
        <section className="l-uses" aria-labelledby="l-uses-label">
          <div className="site-wrap">
            <h2 id="l-uses-label" className="l-label">From specs to tabletop campaigns</h2>
            <ul className="l-uses-grid">
              {USES.map((u) => (
                <li key={u.title} className="l-use">
                  <div className="l-use-title">{u.title}</div>
                  <div className="l-use-items">{u.items}</div>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* SHOWCASE */}
        <section id="features" className="l-showcase" aria-label="Features">
          {SHOWCASE.map((s, i) => (
            <div
              key={s.eyebrow}
              id={s.id}
              className={`site-wrap l-show ${i % 2 ? "l-show-flip" : ""}`}
            >
              <div className="l-show-copy">
                <div className="l-show-eyebrow">{s.eyebrow}</div>
                <h2 className="l-show-title">
                  {s.title[0]}<br /><b>{s.title[1]}</b>
                </h2>
                <p className="l-show-body">{s.body}</p>
                <ul className="l-checks">
                  {s.points.map((p) => (
                    <li key={p}><Check size={16} aria-hidden="true" />{p}</li>
                  ))}
                </ul>
              </div>
              <div className="l-show-media">
                <img src={s.src} alt={s.alt} width={1920} height={1200} loading="lazy" decoding="async" />
              </div>
            </div>
          ))}
        </section>

        {/* EXTRAS */}
        <section className="l-extras" aria-labelledby="l-extras-label">
          <div className="site-wrap">
            <h2 id="l-extras-label" className="l-label">And everything else a docs site should do</h2>
            <ul className="l-extras-grid">
              {EXTRAS.map((f) => (
                <li key={f.title} className="l-extra">
                  <div className="l-extra-head">
                    <div className="l-extra-icon"><f.Icon size={18} aria-hidden="true" /></div>
                    {f.early && <span className="l-tag">early access</span>}
                  </div>
                  <h3 className="l-extra-title">{f.title}</h3>
                  <p className="l-extra-desc">{f.desc}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* PRICING */}
        <section id="pricing" className="l-pricing" aria-labelledby="l-pricing-title">
          <div className="site-wrap">
            <h2 className="l-label">Pricing</h2>
            <h3 id="l-pricing-title" className="l-pricing-headline">
              Free. <span>Ink is optional.</span>
            </h3>
            <p className="l-pricing-sub">
              There's no paywall and no missing buttons. If Annex is useful to you,
              Ink is a way to chip in, and your account gets some quietly fancy
              decoration in return.
            </p>
            <div className="l-plans">
              <div className="l-plan">
                <div className="l-plan-name">Annex</div>
                <div className="l-plan-price"><span>$0</span> / month</div>
                <p className="l-plan-desc">The whole product, for everyone.</p>
                <ul className="l-checks">
                  {FREE_PERKS.map((p) => (
                    <li key={p}><Check size={16} aria-hidden="true" />{p}</li>
                  ))}
                </ul>
                <Link className="l-btn-secondary l-plan-cta" to={primary.to}>{primary.label}</Link>
              </div>
              <div className="l-plan l-plan-ink">
                <div className="l-plan-name">
                  <InkSparkle className="l-ink-sparkle" /> Annex Ink
                </div>
                <div className="l-plan-price"><span>$5</span> / month</div>
                <p className="l-plan-desc">Everything in Annex, plus cosmetic perks.</p>
                <ul className="l-checks">
                  {INK_PERKS.map((p) => (
                    <li key={p}><Check size={16} aria-hidden="true" />{p}</li>
                  ))}
                </ul>
                <Link className="l-btn-primary l-plan-cta" to={isLoggedIn ? "/settings#billing" : "/register"}>
                  Become a supporter
                </Link>
              </div>
            </div>
          </div>
        </section>

        {/* FAQ */}
        <section className="l-faq" aria-labelledby="l-faq-label">
          <div className="site-wrap l-faq-inner">
            <h2 id="l-faq-label" className="l-label">Questions</h2>
            {FAQ.map((f) => (
              <details key={f.q} className="l-faq-item">
                <summary>{f.q}</summary>
                <p>{f.a}</p>
              </details>
            ))}
            <p className="l-faq-more">
              More in the <a href={HELP_URL} target="_blank" rel="noopener noreferrer">help docs</a>.
            </p>
          </div>
        </section>

        {/* CTA BAND */}
        <section className="l-cta-band">
          <div className="site-wrap">
            <h2 className="l-cta-band-headline">
              Ready to build your <b>Annex?</b>
            </h2>
            <div className="l-hero-ctas l-cta-band-ctas">
              <Link className="l-btn-primary" to={primary.to}>
                {primary.label} <ArrowRight size={18} aria-hidden="true" />
              </Link>
              <Link className="l-btn-secondary" to="/demo">Try the demo</Link>
            </div>
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}
