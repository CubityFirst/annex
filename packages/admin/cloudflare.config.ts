import { bindings, defineConfig, triggers } from "cf/config";

export default defineConfig({
	accountId: "d843ae90cab33e54f4d284bc65d2fd6a",
	worker: {
		name: "annex-admin",
		// Keep in lockstep with the api worker's compatibilityDate: this worker
		// imports api source (account/*, routes/auth.ts) cross-package, so
		// runtime-behavior differences between dates would make shared code behave
		// differently per worker.
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
			// Hourly: performs Annex-data deletions scheduled from the Users page
			// once their grace window has passed (src/lib/userDeletion.ts
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
			// Sign in with auth.cubityfir.st: the admin panel is its own first-party
			// OIDC client (scopes `openid profile email roles`, sign-in requires the
			// admin role), registered with redirect URI APP_ORIGIN/api/auth/callback
			// and post-logout redirect URI APP_ORIGIN (no trailing slash; matched byte
			// for byte). OIDC_CLIENT_ID must be the id
			// it was registered with at auth.cubityfir.st/admin/clients;
			// OIDC_CLIENT_SECRET is a secret.
			OIDC_ISSUER: bindings.text("https://auth.cubityfir.st"),
			OIDC_CLIENT_ID: bindings.text("oidc_07c81f4a5aa63dd2bd0b15cc"),
			APP_ORIGIN: bindings.text("https://admin.cubityfir.st"),
			// Identity service RPC (live standing + admin role, user lookups).
			IDENTITY: bindings.worker({
				worker: "cubityfirst-auth",
				exportName: "IdentityService",
			}),
			// The identity worker's HTTP surface (default export) for server-side
			// OIDC requests (discovery, JWKS, token). Required: a Worker's fetch()
			// to auth.cubityfir.st from this same zone goes to the origin, not to
			// the identity worker. Only the browser redirects use the public URL.
			IDENTITY_OIDC: bindings.worker({
				worker: "cubityfirst-auth",
			}),
			ASSETS: bindings.r2({
				name: "cubedocs-assets",
			}),
			// GA ratelimit bindings - simulated locally in dev.
			// IP-keyed coarse abuse cap across every authenticated admin API route
			// and the sign-in endpoints.
			// Generous enough for an operator clicking around the dashboard; only
			// bites scripted abuse with a stolen admin token.
			RATE_LIMITER_ADMIN: bindings.rateLimit({
				namespace: "2001",
				simple: {
					limit: 60,
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
			//   JWT_SECRET         (signs this panel's own 'admin' session JWTs;
			//                       Annex-only, not shared with the identity service)
			//   OIDC_CLIENT_SECRET (the annex-admin client's secret from
			//                       auth.cubityfir.st)
			//   STRIPE_SECRET_KEY  (sk_test_... or sk_live_... - same value as the api
			//                       worker; used for admin-driven Stripe actions)
			//   CF_API_TOKEN       (same token as the api worker - zone-scoped, SSL
			//                       and Certificates: Edit; only used to release a
			//                       custom hostname on admin-driven site delete)
		},
	},
});
