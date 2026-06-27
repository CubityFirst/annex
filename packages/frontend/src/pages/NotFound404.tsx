import { Link } from "react-router-dom";
import "./NotFound404.css";

interface SecondaryLink {
  label: string;
  /** Internal route ("/…") renders a router Link; anything else (mailto:, http) an <a>. */
  href: string;
}

interface Props {
  /** Situation-specific copy under the numeral. */
  subtitle: React.ReactNode;
  /** Primary CTA label, e.g. "Go home" / "Go back to Docs". */
  primaryLabel: string;
  /** Primary CTA target. Internal route ("/…") → router Link; else <a>. */
  primaryHref: string;
  /** Optional secondary link (the design's "report a broken link"). */
  secondary?: SecondaryLink;
  /** Status code, used only for the screen-reader label (defaults to "404"). */
  status?: string;
}

function CtaLink({ href, className, children }: { href: string; className: string; children: React.ReactNode }) {
  if (href.startsWith("/")) {
    return <Link className={className} to={href}>{children}</Link>;
  }
  const external = /^https?:/i.test(href);
  return (
    <a
      className={className}
      href={href}
      {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
    >
      {children}
    </a>
  );
}

/**
 * Terminal-style 404, ported from the Claude Design handoff. Used for the
 * global catch-all route and the public-reader "no published document" state -
 * same shell, swappable subtitle + CTA target (per the design's content slots).
 */
export function NotFound404({ subtitle, primaryLabel, primaryHref, secondary, status = "404" }: Props) {
  return (
    <div className="v404">
      <div className="v404-stage">
        <div className="v404-grid" aria-hidden="true" />

        <div className="v404-content">
          <div className="v404-numeral" role="heading" aria-level={1} aria-label={`${status} - page not found`}>
            <span aria-hidden="true">4</span>
            <span aria-hidden="true">0</span>
            <span aria-hidden="true">4</span>
            <span className="v404-cursor" aria-hidden="true">_</span>
          </div>

          <div className="v404-subtitle">{subtitle}</div>

          <div className="v404-cta">
            <CtaLink href={primaryHref} className="v404-btn">
              {primaryLabel} <span className="v404-btn-arrow" aria-hidden="true">→</span>
            </CtaLink>
            {secondary && (
              <CtaLink href={secondary.href} className="v404-link">
                {secondary.label}
              </CtaLink>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
