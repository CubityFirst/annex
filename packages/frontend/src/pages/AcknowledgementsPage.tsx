import { SiteFooter, SiteNav } from "@/components/SiteFooter";
import { ACKNOWLEDGEMENTS } from "@/lib/acknowledgements";
import "./LandingPage.css";

export function AcknowledgementsPage() {
  return (
    <div className="landing">
      <SiteNav />

      <section className="l-legal">
        <div className="site-wrap">
          <div className="l-legal-inner">
            <div className="l-legal-label">Open source</div>
            <h1 className="l-legal-title">Acknowledgements</h1>
            <p className="l-legal-intro">
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
