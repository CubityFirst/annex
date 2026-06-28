import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  History,
  Layers,
  Paintbrush,
  Users,
  Search,
  Globe,
  type LucideIcon,
} from "lucide-react";
import { getToken } from "@/lib/auth";
import { AnnexLogo } from "@/components/AnnexLogo";
import { InkSparkle } from "@/components/InkSparkle";
import { SiteFooter } from "@/components/SiteFooter";
import "./LandingPage.css";

const WORDS = ["research", "campaigns", "ideas", "knowledge", "writing"];

function useTypewriter(
  words: string[],
  { typingSpeed = 75, deletingSpeed = 42, pause = 1700 } = {}
) {
  const reducedMotion =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const [displayed, setDisplayed] = useState(reducedMotion ? words[0] : "");
  const [wordIdx, setWordIdx] = useState(0);
  const [phase, setPhase] = useState<"typing" | "deleting">("typing");
  const t = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (reducedMotion) return;
    const word = words[wordIdx];
    if (phase === "typing") {
      if (displayed.length < word.length) {
        t.current = setTimeout(
          () => setDisplayed(word.slice(0, displayed.length + 1)),
          typingSpeed
        );
      } else {
        t.current = setTimeout(() => setPhase("deleting"), pause);
      }
    } else {
      if (displayed.length > 0) {
        t.current = setTimeout(
          () => setDisplayed(displayed.slice(0, -1)),
          deletingSpeed
        );
      } else {
        setWordIdx((i) => (i + 1) % words.length);
        setPhase("typing");
      }
    }
    return () => { if (t.current) clearTimeout(t.current); };
  }, [displayed, phase, wordIdx, words, typingSpeed, deletingSpeed, pause, reducedMotion]);

  return displayed;
}

type TabKey = "api-reference.md" | "authentication.md" | "getting-started.md" | "dnd-campaign.md";

const TABS: Record<TabKey, {
  h: string;
  p: string;
  code: { c: string; t: string }[];
  lines: number[];
  badges: string[];
}> = {
  "api-reference.md": {
    h: "API Reference",
    p: "Programmatically create, read, update and delete docs in your Annex workspace using the REST API.",
    code: [
      { c: "#555", t: "BASE_URL = https://api.annex.app/v1" },
      { c: "#444", t: "Content-Type: application/json" },
    ],
    lines: [88, 72, 80, 65],
    badges: ["REST", "v1", "docs"],
  },
  "authentication.md": {
    h: "Authentication",
    p: "All requests require a bearer token in the Authorization header. Tokens are generated from workspace settings.",
    code: [
      { c: "#555", t: "POST /v1/auth/token" },
      { c: "#4a4a4a", t: "Authorization: Bearer <YOUR_TOKEN>" },
      { c: "#3a3a3a", t: '→  { "token": "ak_...", "expires": 3600 }' },
    ],
    lines: [82, 68, 74],
    badges: ["OAuth2", "bearer", "tokens"],
  },
  "getting-started.md": {
    h: "Getting Started",
    p: "Create your first workspace, invite collaborators, and publish your first doc in under five minutes.",
    code: [
      { c: "#555", t: "1. Create workspace" },
      { c: "#444", t: "2. Add your first page" },
    ],
    lines: [92, 78, 65, 74],
    badges: ["quickstart", "setup"],
  },
  "dnd-campaign.md": {
    h: "The Curse of Thornwall Keep",
    p: "Session 4 - the party arrives at Ironhaven and discovers the cult's true motives...",
    code: [
      { c: "#555", t: "Location: Ironhaven, Dusk Quarter" },
      { c: "#444", t: "Party level: 6  ·  Players: 4" },
    ],
    lines: [88, 70, 60, 80],
    badges: ["combat", "session-4", "lore"],
  },
};

const TAB_ORDER: TabKey[] = [
  "api-reference.md",
  "authentication.md",
  "getting-started.md",
  "dnd-campaign.md",
];

function EditorMockup() {
  const [active, setActive] = useState<TabKey>("api-reference.md");
  const tab = TABS[active];
  return (
    <div className="l-editor">
      <div className="l-editor-titlebar">
        <div className="l-editor-dots">
          <div className="l-editor-dot" />
          <div className="l-editor-dot" />
          <div className="l-editor-dot" />
        </div>
        <div className="l-editor-tabs" role="tablist" aria-label="Example documents">
          {TAB_ORDER.map((k) => (
            <button
              key={k}
              role="tab"
              id={`l-editor-tab-${k}`}
              aria-selected={active === k}
              aria-controls="l-editor-tabpanel"
              onClick={() => setActive(k)}
              className={`l-editor-tab ${active === k ? "l-editor-tab-active" : "l-editor-tab-inactive"}`}
            >
              {k}
            </button>
          ))}
        </div>
      </div>
      <div
        className="l-editor-body"
        role="tabpanel"
        id="l-editor-tabpanel"
        aria-labelledby={`l-editor-tab-${active}`}
      >
        <div className="l-editor-h">{tab.h}</div>
        <div className="l-editor-p">{tab.p}</div>
        {tab.lines.slice(0, 2).map((w, i) => (
          <div key={i} className="l-editor-line" style={{ width: `${w}%` }} />
        ))}
        <div className="l-editor-code">
          {tab.code.map((l, i) => (
            <span key={i} style={{ color: l.c }}>{l.t}</span>
          ))}
        </div>
        {tab.lines.slice(2).map((w, i) => (
          <div key={i} className="l-editor-line" style={{ width: `${w}%` }} />
        ))}
        <div>
          {tab.badges.map((b) => (
            <span key={b} className="l-editor-badge">{b}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

const FEATURES: {
  Icon: LucideIcon;
  title: string;
  desc: string;
  soon?: boolean;
  link?: string;
}[] = [
  { Icon: History, title: "Version History", desc: "Every edit is recorded. Roll back, branch off, compare - nothing is ever lost." },
  { Icon: Layers, title: "Flexible Structure", desc: "Nested pages, tags, cross-links. Build any hierarchy that fits your content." },
  {
    Icon: Paintbrush,
    title: "Rich Media",
    desc: "Embed images, tables, code blocks, and callouts in any doc.",
    link: "https://docs.cubityfir.st/s/help/a0ea410e-95ff-455b-a495-cdf00ea5a890",
  },
  { Icon: Users, title: "Live Collaboration", desc: "Work together in real time. See who's editing, leave inline comments." },
  { Icon: Search, title: "Fast Search", desc: "Full-text search across every page, heading, and tag in your workspace." },
  { Icon: Globe, title: "Publish Anywhere", desc: "Share a private link or publish a styled public site in one click." },
];

export function LandingPage() {
  const word = useTypewriter(WORDS);
  const isLoggedIn = !!getToken();

  return (
    <div className="landing">
      {/* NAV */}
      <nav className="l-nav">
        <div className="l-nav-inner">
          <AnnexLogo height={21} />
          <div className="l-nav-links">
            <a className="l-nav-link" href="#features">features</a>
            <a className="l-nav-link" href="#pricing">pricing</a>
            {!isLoggedIn && <Link className="l-nav-link l-nav-login" to="/login">login</Link>}
            {isLoggedIn
              ? <Link className="l-nav-cta" to="/dashboard">go to dashboard</Link>
              : <Link className="l-nav-cta" to="/register">get started</Link>}
          </div>
        </div>
      </nav>

      {/* HERO */}
      <section className="l-hero">
        <div className="l-hero-inner">
          <div className="l-hero-copy">
            <div className="l-hero-pre">an annex for your mind</div>
            <h1 className="l-hero-headline">A place to keep</h1>
            <div className="l-hero-headline-b">
              your&nbsp;<span>{word}</span><span className="l-tw-cursor">&nbsp;</span>
            </div>
            <p className="l-hero-sub">
              Annex is the flexible writing platform for any kind of structured thought,
              from technical specs to tabletop campaigns.
            </p>
            <div className="l-hero-ctas">
              <Link className="l-btn-primary" to="/register">Create your Annex →</Link>
              <Link className="l-btn-ghost" to="/demo">
                See a demo
              </Link>
            </div>
          </div>
          <EditorMockup />
        </div>
      </section>

      {/* FEATURES */}
      <hr className="l-section-divider" />
      <section id="features" className="l-features">
        <div className="site-wrap">
          <h2 className="l-features-label">What it does</h2>
          <div className="l-features-grid">
            {FEATURES.map((f) => {
              const inner = (
                <>
                  <div className="l-feature-icon">
                    <f.Icon size={21} />
                  </div>
                  <h3 className="l-feature-title">
                    {f.title}
                    {f.soon && <span className="l-feature-soon">soon</span>}
                  </h3>
                  <div className="l-feature-desc">{f.desc}</div>
                </>
              );
              return f.link ? (
                <a key={f.title} className="l-feature-card" href={f.link}>
                  {inner}
                </a>
              ) : (
                <div key={f.title} className="l-feature-card">
                  {inner}
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* INK PRICING */}
      <hr className="l-section-divider" />
      <section id="pricing" className="l-ink">
        <div className="site-wrap">
          <h2 className="l-features-label">Annex Ink</h2>
          <div className="l-ink-grid">
            <div className="l-ink-copy">
              <h3 className="l-ink-headline">
                A small supporter tier.
                <br />
                <span>Cosmetic&nbsp;only.</span>
              </h3>
              <p className="l-ink-sub">
                There's no paywall, no upsell, no missing buttons. Annex Ink is a
                way to chip in if the project's useful to you - in return, your
                account gets some quietly fancy decoration.
              </p>
              <div className="l-ink-price">
                <span className="l-ink-price-amount">$5</span>
                <span className="l-ink-price-unit">/month</span>
              </div>
              <Link className="l-btn-primary" to={isLoggedIn ? "/settings#billing" : "/register"}>
                {isLoggedIn ? "Become a supporter" : "Get started →"}
              </Link>
            </div>

            <div className="l-ink-card">
              <div className="l-ink-card-head">
                <span className="l-ink-card-icon"><InkSparkle className="l-ink-sparkle" /></span>
                <div>
                  <div className="l-ink-card-title">What you get</div>
                  <div className="l-ink-card-sub">Cosmetic perks only - no extra features locked behind it.</div>
                </div>
              </div>
              <ul className="l-ink-perks">
                <li>
                  <div className="l-ink-perk-title">Animated avatar ring</div>
                  <div className="l-ink-perk-desc">Pick from four styles: shimmer, aurora, ember, or mono.</div>
                </li>
                <li>
                  <div className="l-ink-perk-title">Custom collab cursor colour</div>
                  <div className="l-ink-perk-desc">Override the default and stand out in shared documents.</div>
                </li>
                <li>
                  <div className="l-ink-perk-title">Rainbow sparkle by your name</div>
                  <div className="l-ink-perk-desc">A small animated mark next to your profile, everywhere it shows.</div>
                </li>
                <li>
                  <div className="l-ink-perk-title">Sparkles on dice crits</div>
                  <div className="l-ink-perk-desc">A small burst of sparkles whenever an inline dice roll lands a critical success.</div>
                </li>
                <li>
                  <div className="l-ink-perk-title">Support Annex</div>
                  <div className="l-ink-perk-desc">Keeps the workers running and the project moving. Cancel anytime.</div>
                </li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* CTA BAND */}
      <section className="l-cta-band">
        <div className="site-wrap">
          <h2 className="l-cta-band-headline">
            Ready to build your <b>Annex?</b>
          </h2>
          <Link className="l-btn-primary" to="/register">Create your Annex →</Link>
        </div>
      </section>

      {/* FOOTER */}
      <SiteFooter />
    </div>
  );
}
