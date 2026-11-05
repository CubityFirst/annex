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
        <AnnexLogo height={18} fill="rgba(232, 228, 222, 0.45)" />
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
