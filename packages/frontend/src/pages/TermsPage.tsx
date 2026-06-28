import { Link } from "react-router-dom";
import { getToken } from "@/lib/auth";
import { AnnexLogo } from "@/components/AnnexLogo";
import { SiteFooter } from "@/components/SiteFooter";
import "./LandingPage.css";

export function TermsPage() {
  const isLoggedIn = !!getToken();

  return (
    <div className="landing">
      <nav className="l-nav">
        <div className="l-nav-inner">
          <Link to="/" aria-label="Annex home"><AnnexLogo height={21} /></Link>
          <div className="l-nav-links">
            {!isLoggedIn && <Link className="l-nav-link l-nav-login" to="/login">login</Link>}
            {isLoggedIn
              ? <Link className="l-nav-cta" to="/dashboard">go to dashboard</Link>
              : <Link className="l-nav-cta" to="/register">get started</Link>}
          </div>
        </div>
      </nav>

      <section className="l-legal">
        <div className="site-wrap">
          <div className="l-legal-inner">
            <div className="l-legal-label">Legal</div>
            <h1 className="l-legal-title">Terms of Service</h1>
            <p className="l-legal-meta">Effective date: May 10, 2026</p>

            <div className="l-legal-body">
              <h2>1. Acceptance</h2>
              <p>
                By creating an account or using Annex, you agree to these Terms of Service. If you
                do not agree, do not use the service. We may update these terms; continued use
                after notice of changes constitutes acceptance.
              </p>

              <h2>2. Your Account</h2>
              <p>
                You are responsible for maintaining the security of your account credentials. Do
                not share your password. You are responsible for all activity that occurs under
                your account. Notify us immediately if you suspect unauthorized access.
              </p>
              <p>
                You must provide accurate information when registering. Accounts found to use false
                information may be suspended.
              </p>

              <h2>3. Acceptable Use</h2>
              <p>You agree not to use Annex to:</p>
              <ul>
                <li>Upload or share content that is unlawful, harmful, abusive, defamatory, or infringing</li>
                <li>Distribute spam, malware, or phishing content</li>
                <li>Attempt to gain unauthorized access to our systems or other users' workspaces</li>
                <li>Scrape, crawl, or systematically extract data without prior written permission</li>
                <li>Interfere with or disrupt the integrity or performance of the service</li>
                <li>Use the service in any way that violates applicable laws or regulations</li>
              </ul>
              <p>
                We reserve the right to remove content or suspend accounts that violate these rules
                without prior notice.
              </p>

              <h2>4. Your Content</h2>
              <p>
                You retain ownership of all content you create in Annex. By using the service, you
                grant us a limited, non-exclusive license to store, process, and display your
                content solely to provide the service to you and your invited collaborators.
              </p>
              <p>
                You are solely responsible for the content you upload or publish. We do not
                moderate private workspaces. Public sites you publish are your responsibility.
              </p>

              <h2>5. Service Availability</h2>
              <p>
                We strive for high availability but do not guarantee uninterrupted access. The
                service is provided "as is" without warranty of any kind. We may modify, suspend,
                or discontinue any part of the service at any time with reasonable notice where
                possible.
              </p>

              <h2>6. Payments, Subscriptions, and Refunds</h2>
              <p>
                Paid plans (such as Annex Ink) are billed in advance on a recurring basis at the
                price shown when you subscribe. By starting a subscription you authorise us, through
                our payment processor Stripe, to charge your selected payment method on each
                renewal date until the subscription is cancelled. Subscriptions auto-renew at the
                end of each billing period unless cancelled.
              </p>
              <p>
                You can cancel at any time from your account settings, which opens Stripe's
                Customer Portal. Cancellation takes effect at the end of the current billing
                period; you keep access through the period you have already paid for, and your
                payment method will not be charged again.
              </p>
              <p>
                All fees are non-refundable except where required by law. We do not issue partial
                refunds for unused portions of a billing period, including when you cancel mid-cycle
                or when your account is deleted (whether by you or by us). We will display a
                reminder of this before you confirm account deletion.
              </p>
              <p>
                If a renewal payment fails, we may suspend or downgrade access after a short grace
                period during which Stripe retries the charge. We may change subscription prices
                from time to time; if we do, we will give at least 30 days' notice by email or
                in-app notice before the new price takes effect, and you can cancel before that
                date if you do not wish to continue.
              </p>
              <p>
                Free accounts and any complimentary supporter access (gifted Ink) we may grant are
                provided at our discretion and may be revoked at any time without refund or notice.
              </p>

              <h2>7. Termination</h2>
              <p>
                You may stop using Annex and delete your account at any time. We may suspend or
                terminate your account for violations of these terms. Upon termination, your right
                to use the service ceases immediately.
              </p>

              <h2>8. Limitation of Liability</h2>
              <p>
                To the fullest extent permitted by law, Annex and its operators are not liable for
                any indirect, incidental, special, or consequential damages arising from your use
                of the service. Our total liability for any claim shall not exceed the amount you
                paid us in the three months preceding the claim.
              </p>

              <h2>9. Governing Law</h2>
              <p>
                These terms are governed by the laws of the jurisdiction in which the operator is
                established, without regard to conflict-of-law principles.
              </p>

              <h2>10. Contact</h2>
              <p>
                Questions about these terms? Email us at{" "}
                <a href="mailto:cubity@cubityfir.st?subject=Annex%20Terms">cubity@cubityfir.st</a>.
              </p>
            </div>
          </div>
        </div>
      </section>

      <SiteFooter />
    </div>
  );
}
