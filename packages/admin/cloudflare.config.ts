import { bindings, defineConfig, triggers } from "cf/config";

export default defineConfig({
	accountId: "d843ae90cab33e54f4d284bc65d2fd6a",
	worker: {
		name: "annex-admin",
		// Keep in lockstep with the auth worker's compatibilityDate: this worker
		// imports auth source (session.ts/jwt.ts) cross-package, so runtime-behavior
		// differences between dates would make shared code behave differently per
		// worker.
		compatibilityDate: "2026-02-24",
		entrypoint: "src/index.ts",
		workersDev: false,
		// Asset directory (./dist, built by `pnpm build` from ./frontend) is a
		// build setting - see wrangler.config.ts.
		assets: {
			htmlHandling: "auto-trailing-slash",
			notFoundHandling: "single-page-application",
		},
		domains: [
			"admin.cubityfir.st",
		],
		triggers: [
			// Hourly: performs account deletions scheduled from the Users page once
			// their grace window has passed (src/lib/userDeletion.ts
			// runDueUserDeletions).
			triggers.scheduled({
				schedule: "17 * * * *",
			}),
		],
		env: {
			// Cloudflare-for-SaaS custom domains - used to release a site's custom
			// hostname when an admin removes a domain or deletes the site (mirrors
			// the api worker). MUST match the api worker's values (the dedicated
			// yourannex.com zone - see memories/Custom-Domains.md), and CF_API_TOKEN
			// must be scoped to that zone. When CF_ZONE_ID / CF_API_TOKEN are unset,
			// the CF call is a safe no-op (the DB row is still removed).
			CF_ZONE_ID: bindings.text("397deb54a68d306201a295d1793fe84c"),
			CUSTOM_DOMAIN_CNAME_TARGET: bindings.text("cname.yourannex.com"),
			DB: bindings.d1({
				name: "cubedocs-main",
				id: "267490be-7141-4d00-ab23-152742f2f6ef",
			}),
			// Read+write: unlike the API worker's read-only-by-convention AUTH_DB
			// binding, the admin worker writes users (moderation/
			// force_password_change), user_moderation_events, user_preferences
			// (badges), user_billing (grant columns), and admin_audit_log directly.
			// Credential/session/oauth_clients writes still go through the AUTH
			// service binding. Migrations live only in packages/auth/migrations/.
			AUTH_DB: bindings.d1({
				name: "cubedocs-auth",
				id: "db327d85-b8c2-4fed-adaa-25e748778c86",
			}),
			ASSETS: bindings.r2({
				name: "cubedocs-assets",
			}),
			AUTH: bindings.worker({
				worker: "annex-auth",
			}),
			// GA ratelimit bindings - simulated locally in dev. See the auth
			// worker's cloudflare.config.ts.
			// IP-keyed coarse abuse cap across every authenticated admin API route.
			// Generous enough for an operator clicking around the dashboard; only
			// bites scripted abuse with a stolen admin token.
			RATE_LIMITER_ADMIN: bindings.rateLimit({
				namespace: "2001",
				simple: {
					limit: 60,
					period: 60,
				},
			}),
			// Tighter, separate bucket for the unauthenticated handoff-exchange
			// proxy (the only pre-auth endpoint that hits the auth worker + DB).
			RATE_LIMITER_ADMIN_HANDOFF: bindings.rateLimit({
				namespace: "2002",
				simple: {
					limit: 10,
					period: 60,
				},
			}),
			// Separate budget for the public avatar route: a 25-row dashboard page
			// costs 25 avatar fetches, which previously drained the shared admin
			// API budget and started 429ing the operator after ~2 searches/min.
			RATE_LIMITER_AVATAR: bindings.rateLimit({
				namespace: "2003",
				simple: {
					limit: 300,
					period: 60,
				},
			}),
			SITE_ASSETS: bindings.assets(),
			// Secrets (set via `npx wrangler secret put <NAME> --name annex-admin`;
			// existing secrets are kept across `cf deploy`):
			//   JWT_SECRET         (same value as the auth worker's JWT_SECRET - the
			//                       admin worker verifies sessions inline against
			//                       AUTH_DB instead of calling auth's /verify route)
			//   STRIPE_SECRET_KEY  (sk_test_... or sk_live_... - same value as auth
			//                       worker; only used for admin-driven cancellations
			//                       triggered from the user details panel)
			//   CF_API_TOKEN       (same token as the api worker - zone-scoped, SSL
			//                       and Certificates: Edit; only used to release a
			//                       custom hostname on admin-driven site delete)
		},
	},
});
