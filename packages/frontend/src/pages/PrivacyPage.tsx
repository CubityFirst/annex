import { Link } from "react-router-dom";
import { getToken } from "@/lib/auth";
import { AnnexLogo } from "@/components/AnnexLogo";
import { SiteFooter } from "@/components/SiteFooter";
import "./LandingPage.css";

export function PrivacyPage() {
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
            <h1 className="l-legal-title">Privacy Policy</h1>
            <p className="l-legal-meta">Effective date: May 29, 2026</p>

            <div className="l-legal-body">
              <h2>1. What We Collect</h2>
              <p>
                When you create an account, we collect your email address and a hashed password.
                If you add a display name or avatar, we store those too.
              </p>
              <p>
                If you subscribe to a paid plan (such as Annex Ink), we store identifiers that link
                your account to our payment processor - specifically a Stripe customer ID, a Stripe
                subscription ID, which plan you're on and its current status, the end of your current
                billing period, any pending cancellation date, and the date your supporter status
                began. If an administrator grants you complimentary supporter status, we also store
                that grant, when it starts and expires, and an internal note recording the reason.
                Card numbers and other payment details are collected directly by Stripe at checkout
                and never reach our servers.
              </p>
              <p>
                We log standard server-side request data (IP address, user-agent, timestamps) for
                security monitoring and abuse prevention. These logs are retained for up to 90 days.
              </p>
              <p>
                When you sign in, we also create a persistent session record so you can review and
                revoke active sign-ins from your account settings. Each record stores the IP address
                you signed in from, a coarse device type (phone, tablet, laptop, or desktop), a
                short client label derived from your browser's user-agent (for example, “Chrome on
                macOS”), and sign-in / last-used timestamps. We do not retain the full user-agent
                string. Each session expires 7 days after you sign in. When you sign out or revoke a
                session it is immediately marked inactive and can no longer be used; inactive and
                expired records are then permanently deleted within about 30 days.
              </p>

              <h2>2. Content You Create</h2>
              <p>
                Documents, files, and workspaces you create are stored on our servers and belong to
                you. We do not sell your content or share it with third parties except as required
                to operate the service (e.g., backups, CDN delivery, the optional features
                described below).
              </p>
              <p>
                Published public sites are accessible to anyone with the link. Private workspaces
                are not reachable by other users; only you and members you explicitly invite can
                access them through the application.
              </p>
              <p>
                Although other users cannot reach your private workspaces, Annex's operators
                retain technical access to stored content for the platform to function (storage,
                backups, search indexing). We will only read your private workspace content when:
              </p>
              <ul>
                <li>You explicitly ask us to (for example, a support request about a specific document)</li>
                <li>We are responding to a credible report that the content violates our Terms</li>
                <li>We are required to comply with law or a valid legal process</li>
                <li>It is necessary to investigate or resolve a security incident</li>
              </ul>
              <p>
                We do not access private content for advertising, profiling, or to train
                machine-learning models.
              </p>

              <h2>3. How We Use Your Data</h2>
              <p>We use the information we collect to:</p>
              <ul>
                <li>Provide, maintain, and improve Annex</li>
                <li>Send transactional emails (account confirmation, password reset, invites)</li>
                <li>Detect and prevent abuse or unauthorized access</li>
                <li>Comply with legal obligations</li>
              </ul>
              <p>
                We do not use your content or personal data to train machine learning models, and
                we do not serve advertising.
              </p>

              <h2>4. Data Sharing</h2>
              <p>
                We do not sell your personal data. We share data only with service providers that
                help us operate Annex (cloud infrastructure, email delivery, error monitoring,
                payment processing), and only to the extent necessary. Infrastructure is hosted on
                Cloudflare, whose handling of your data is governed by their own terms of service
                rather than a direct contractual obligation to us.
              </p>
              <p>
                Payments are processed by Stripe, Inc. When you start a checkout, we send Stripe a
                reference to your account - and, on your first checkout, your email address - so the
                resulting subscription can be tied back to you. Stripe collects payment details (card number, expiry, billing
                address) directly. Stripe's handling of that data is governed by their own privacy
                policy, available at{" "}
                <a href="https://stripe.com/privacy" target="_blank" rel="noopener noreferrer">
                  stripe.com/privacy
                </a>
                . Stripe is based in the United States and may transfer data outside your country
                of residence under their own contractual safeguards.
              </p>
              <p>
                AI features (such as document summarisation) are <strong>off by default</strong>{" "}
                for every project. They only operate after a project admin explicitly turns them
                on in project settings. By default, even with the feature enabled, AI actions are
                manual - summaries are only generated when a user clicks the "summarise" button on
                a document. A project admin can additionally opt the project in to automatic
                summarisation; in that mode content is sent to the AI provider when a document is
                viewed. Automatic summarisation is a separate, deliberate setting and is not enabled
                by default.
              </p>
              <p>
                When an AI action runs (manual or automatic), the relevant document content is
                sent to a third-party AI provider (currently OpenAI) to generate the response. We
                do not retain a copy of the content sent for this purpose beyond the request
                itself; the provider may process and briefly store it under their own terms.
              </p>
              <p>
                Where AI providers offer settings to opt out of training-data collection or
                extended retention of inputs and outputs, we use them. OpenAI's API does not use
                API request data to train its models by default, and we have not enabled any
                feature that would change that. If we add other providers in future (for example,
                OpenRouter or a self-hosted model), we will configure them to the strictest
                privacy setting they support.
              </p>
              <p>
                We may disclose data if required by law or to protect the rights and safety of our
                users.
              </p>

              <h2>5. Cookies and Tracking</h2>
              <p>
                We use a session token stored in localStorage to keep you logged in. We do not use
                third-party tracking cookies or analytics pixels. Basic aggregate usage metrics
                (page loads, feature usage counts) may be collected without any personally
                identifying information.
              </p>
              <p>
                When you complete a checkout or open the subscription management portal, you are
                briefly redirected to a Stripe-hosted page. Those pages set their own cookies for
                fraud detection and session management, governed by Stripe's privacy policy rather
                than ours.
              </p>

              <h2>6. Data Retention and Deletion</h2>
              <p>
                Your account and all associated data remain on our servers until you delete your
                account, which you can do at any time from your account settings. Because workspaces
                can have other members, you'll first need to delete or transfer any workspaces you
                own; once you do, deleting your account immediately and permanently removes your
                account and associated data, except where retention is required by law.
              </p>
              <p>
                When you delete your account, any active subscription is cancelled immediately and
                we ask Stripe to delete the corresponding customer record, which removes the email,
                payment methods, and billing history Stripe held about you. Stripe may retain a
                record of past transactions for tax, accounting, or fraud-prevention purposes as
                required by their own legal obligations.
              </p>

              <h2>7. Security</h2>
              <p>
                All data is transmitted over HTTPS. Passwords are stored as salted cryptographic hashes and are never stored in plain text. We take
                reasonable technical and organizational measures to protect your data, but no
                system is perfectly secure. Use a strong, unique password and enable two-factor
                authentication where available.
              </p>

              <h2>8. Children</h2>
              <p>
                Annex is not directed at children under 13. We do not knowingly collect personal
                information from children. If you believe a child has provided us personal data,
                contact us and we will delete it.
              </p>

              <h2>9. Changes to This Policy</h2>
              <p>
                We may update this policy from time to time. If we make material changes we will
                notify registered users by email or via an in-app notice. The effective date at the
                top of this page reflects the most recent revision.
              </p>

              <h2>10. Contact</h2>
              <p>
                Questions about this policy? Email us at{" "}
                <a href="mailto:cubity@cubityfir.st?subject=Annex%20Privacy">cubity@cubityfir.st</a>.
              </p>
            </div>
          </div>
        </div>
      </section>

      <SiteFooter />
    </div>
  );
}
