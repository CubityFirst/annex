import { Link } from "react-router-dom";
import { AnnexLogo } from "@/components/AnnexLogo";

/**
 * Shared footer for the public marketing / legal pages (landing, privacy,
 * terms, acknowledgements, and any future page in that family). Keep the link
 * set here so it stays identical everywhere.
 */
export function SiteFooter() {
  return (
    <footer className="l-footer">
      <div className="l-footer-inner">
        <AnnexLogo height={18} fill="#383430" />
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
