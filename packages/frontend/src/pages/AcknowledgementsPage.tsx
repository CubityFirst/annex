import { Link } from "react-router-dom";
import { getToken } from "@/lib/auth";
import { AnnexLogo } from "@/components/AnnexLogo";
import { SiteFooter } from "@/components/SiteFooter";
import { ACKNOWLEDGEMENTS } from "@/lib/acknowledgements";
import "./LandingPage.css";

export function AcknowledgementsPage() {
  const isLoggedIn = !!getToken();

  return (
    <div className="landing">
      <nav className="l-nav">
        <div className="l-nav-inner">
          <Link to="/"><AnnexLogo height={21} /></Link>
          <div className="l-nav-links">
            {!isLoggedIn && <Link className="l-nav-link" to="/login">login</Link>}
            {isLoggedIn
              ? <Link className="l-nav-cta" to="/dashboard">go to dashboard</Link>
              : <Link className="l-nav-cta" to="/register">get started</Link>}
          </div>
        </div>
      </nav>

      <section className="l-legal">
        <div className="site-wrap">
          <div className="l-legal-inner">
            <div className="l-legal-label">Open Source</div>
            <h1 className="l-legal-title">Acknowledgements</h1>
            <p className="l-legal-meta">
              Annex is built on the work of many open-source projects. With thanks to
              their authors and maintainers.
            </p>

            <ul className="l-ack-list">
              {ACKNOWLEDGEMENTS.map((a) => (
                <li key={a.name} className="l-ack-item">
                  <a
                    className="l-ack-link"
                    href={a.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {a.name}
                  </a>
                  <span className="l-ack-license">{a.license}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <SiteFooter />
    </div>
  );
}
