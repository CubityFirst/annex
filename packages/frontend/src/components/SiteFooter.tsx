import { useEffect, useState, type RefObject } from "react";
import { Link, useLocation } from "react-router-dom";
import { getToken } from "@/lib/auth";
import { AnnexLogo } from "@/components/AnnexLogo";

// Landing-page sections linked from the shared nav (hidden on phones).
const NAV_SECTIONS = [
  { id: "features", label: "Features" },
  { id: "publishing", label: "Publishing" },
  { id: "pricing", label: "Pricing" },
];

/**
 * Shared top nav for the public marketing / legal pages (landing, privacy,
 * terms, acknowledgements, 404). Identical everywhere: the landing's section
 * links (in-page anchors on the landing, `/#section` elsewhere - LandingPage
 * scrolls to the hash on arrival), then the sign-in / CTA pair. Sentence case
 * throughout, matching the app.
 */
export function SiteNav() {
  const isLoggedIn = !!getToken();
  const onLanding = useLocation().pathname === "/";
  return (
    <nav className="l-nav" aria-label="Main">
      <div className="l-nav-inner">
        <Link to="/" aria-label="Annex home"><AnnexLogo height={21} /></Link>
        <div className="l-nav-links">
          {NAV_SECTIONS.map((s) =>
            onLanding ? (
              <a key={s.id} className="l-nav-link" href={`#${s.id}`}>{s.label}</a>
            ) : (
              <Link key={s.id} className="l-nav-link" to={`/#${s.id}`}>{s.label}</Link>
            ),
          )}
          {!isLoggedIn && <Link className="l-nav-link l-nav-login" to="/login">Sign in</Link>}
          {isLoggedIn
            ? <Link className="l-nav-cta" to="/dashboard">Go to dashboard</Link>
            : <Link className="l-nav-cta" to="/register">Get started</Link>}
        </div>
      </div>
    </nav>
  );
}

/**
 * Shared footer for the public marketing / legal pages (landing, privacy,
 * terms, acknowledgements, 404, and any future page in that family). Keep the
 * link set here so it stays identical everywhere.
 */
export function SiteFooter() {
  return (
    <footer className="l-footer">
      <div className="l-footer-inner">
        <AnnexLogo height={18} fill="rgba(232, 232, 232, 0.45)" />
        <div className="l-footer-links">
          <Link className="l-footer-link" to="/">Home</Link>
          <a
            className="l-footer-link"
            href="https://docs.cubityfir.st/s/help/"
            target="_blank"
            rel="noopener noreferrer"
          >
            Docs
          </a>
          <Link className="l-footer-link" to="/privacy">Privacy</Link>
          <Link className="l-footer-link" to="/terms">Terms</Link>
          <Link className="l-footer-link" to="/acknowledgements">Acknowledgements</Link>
        </div>
      </div>
    </footer>
  );
}

/** Turns "3. How we use your data" into a stable anchor id ("how-we-use-your-data"). */
function sectionId(text: string): string {
  return text
    .replace(/^\s*\d+\.\s*/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Sticky "On this page" list for the long legal pages (privacy, terms): built
 * from the `<h2>`s inside `bodyRef` (each gets an id if it lacks one), with a
 * 2px bar on the section currently at the top of the viewport - the same
 * shape as the settings rail. Hidden below 1024px (see `.l-legal-toc`).
 */
export function LegalToc({ bodyRef }: { bodyRef: RefObject<HTMLElement | null> }) {
  const [sections, setSections] = useState<{ id: string; label: string }[]>([]);
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const heads = Array.from(body.querySelectorAll("h2"));
    const list = heads.map((h) => {
      const text = h.textContent ?? "";
      if (!h.id) h.id = sectionId(text);
      return { id: h.id, label: text.replace(/^\s*\d+\.\s*/, "") };
    });
    setSections(list);
    if (!list.length) return;

    // Active = the last heading scrolled past a line just under the fixed nav;
    // pinned to the last section once the page bottoms out.
    const update = () => {
      const line = 140;
      let current = list[0].id;
      for (const h of heads) {
        if (h.getBoundingClientRect().top <= line) current = h.id;
      }
      const doc = document.documentElement;
      if (window.innerHeight + window.scrollY >= doc.scrollHeight - 2) current = list[list.length - 1].id;
      setActive(current);
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [bodyRef]);

  if (!sections.length) return null;
  return (
    <aside className="l-legal-toc">
      <nav aria-label="On this page">
        <p className="l-legal-toc-label">On this page</p>
        <ul className="l-legal-toc-list">
          {sections.map((s) => (
            <li key={s.id}>
              <a
                href={`#${s.id}`}
                className="l-legal-toc-link"
                aria-current={active === s.id ? "true" : undefined}
                onClick={(e) => {
                  // Scroll without a router navigation, and keep the hash
                  // shareable.
                  const el = document.getElementById(s.id);
                  if (!el) return;
                  e.preventDefault();
                  el.scrollIntoView({ block: "start" });
                  history.replaceState(history.state, "", `#${s.id}`);
                  setActive(s.id);
                }}
              >
                {s.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>
    </aside>
  );
}
