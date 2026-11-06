import { bindings, defineConfig, triggers } from "cf/config";

// D1 migrations for `DB` live in ./migrations (the `cf d1 migrations apply`
// default `--dir`). Apply them with `pnpm migrate` (local) or
// `node scripts/migrate.mjs remote` from the repo root.

export default defineConfig({
	accountId: "d843ae90cab33e54f4d284bc65d2fd6a",
	worker: {
		name: "annex-auth",
		compatibilityDate: "2026-02-24",
		compatibilityFlags: [
			"nodejs_compat",
		],
		entrypoint: "src/index.ts",
		workersDev: false,
		triggers: [
			// "Sign in with Annex" OIDC provider - public endpoints on a DEDICATED
			// identity host so the issuer is decoupled from the app origin
			// (docs.cubityfir.st), which may migrate. Only /oauth/* and /.well-known/*
			// are exposed here; nothing else on the auth worker is reachable at
			// auth.cubityfir.st. Requires a proxied DNS record for `auth.cubityfir.st`
			// on the cubityfir.st zone (see docs/oauth/README.md). The browser-facing
			// authorization page lives on the app origin (OIDC_AUTHORIZE_URL).
			triggers.fetch({
				pattern: "auth.cubityfir.st/oauth/*",
				zone: "cubityfir.st",
			}),
			triggers.fetch({
				pattern: "auth.cubityfir.st/.well-known/*",
				zone: "cubityfir.st",
			}),
			// Weekly sweep of long-dead session rows (see scheduled handler).
			triggers.scheduled({
				schedule: "0 3 * * SUN",
			}),
		],
		env: {
			JWT_ISSUER: bindings.text("https://auth.cubedocs.com"),
			ADMIN_APP_ORIGIN: bindings.text("https://admin.cubityfir.st"),
			APP_ORIGIN: bindings.text("https://docs.cubityfir.st"),
			// "Sign in with Annex" OIDC provider. OIDC_ISSUER is the `iss` of every
			// token and the base for discovery
			// (https://auth.cubityfir.st/.well-known/openid-configuration).
			// OIDC_AUTHORIZE_URL is the browser-facing authorize page on the app
			// origin (the user's Annex session lives there, not on the issuer host).
			OIDC_ISSUER: bindings.text("https://auth.cubityfir.st"),
			OIDC_AUTHORIZE_URL: bindings.text("https://docs.cubityfir.st/oauth/authorize"),
			WEBAUTHN_RP_ID: bindings.text("docs.cubityfir.st"),
			WEBAUTHN_RP_NAME: bindings.text("Annex"),
			WEBAUTHN_ORIGIN: bindings.text("https://docs.cubityfir.st"),
			// Stripe price id for the Annex Ink supporter tier ($5/mo recurring).
			// Not a secret - safe to commit.
			STRIPE_INK_PRICE_ID: bindings.text("price_1TVJk5Rckd4Ls9nPHpnY4tAN"),
			DB: bindings.d1({
				name: "cubedocs-auth",
				id: "db327d85-b8c2-4fed-adaa-25e748778c86",
			}),
			// Cloudflare Flagship feature flags. Shares the same app as the API
			// worker so a single source governs both. Flags in use:
			//   signup              (default on)  - when false, /register is refused (handleRegister).
			//   email-verification  (default off) - gates registration verification emails,
			//                                       blocks unverified logins, and selects the
			//                                       confirm-first email-change flow (register.ts /
			//                                       login.ts / change-email.ts).
			// NOTE: local dev DOES serve this binding with the real flag state, so a
			// flag flipped in the Flagship dashboard affects local dev too (e.g. a
			// disabled `signup` flag blocks the e2e suites, which register accounts).
			// The per-call code defaults only apply when the binding itself is missing.
			// Exception: `email-verification` is never enforced on a localhost
			// deployment - isEmailVerificationEnabled (verification.ts) bypasses it so
			// dashboard flips can't break local login/e2e; set
			// DEV_EMAIL_VERIFICATION=true in .dev.vars to opt back in.
			FLAGS: bindings.flagship({
				id: "08fb610f-b8ed-4a60-afcf-7f5fe6b9f948",
			}),
			EMAIL: bindings.sendEmail({
				allowedSenderAddresses: [
					"noreply@docs.cubityfir.st",
				],
			}),
			// Rate limiters use the GA ratelimit binding: simulated locally in dev
			// instead of proxying to Cloudflare - the remote proxy breaks requests
			// that arrive via cross-process service bindings.
			// Coarse abuse cap, IP-keyed. Per-user limiting for authenticated callers
			// happens on the API worker (see RATE_LIMITER_INVITE_LOOKUP there).
			RATE_LIMITER_LOOKUP: bindings.rateLimit({
				namespace: "1001",
				simple: {
					limit: 30,
					period: 60,
				},
			}),
			RATE_LIMITER_AUTH: bindings.rateLimit({
				namespace: "1002",
				simple: {
					limit: 10,
					period: 60,
				},
			}),
			RATE_LIMITER_EMAIL_VERIFY: bindings.rateLimit({
				namespace: "1003",
				simple: {
					limit: 3,
					period: 60,
				},
			}),
			// OIDC token endpoint (/oauth/token). Server-to-server, so a single
			// connected service exchanges every user's code from one egress IP -
			// needs a far higher ceiling than the interactive login limiter.
			// IP-keyed (CF-Connecting-IP is real on the directly-routed
			// auth.cubityfir.st host).
			RATE_LIMITER_OIDC: bindings.rateLimit({
				namespace: "1004",
				simple: {
					limit: 100,
					period: 60,
				},
			}),
			// Secrets (set via `npx wrangler secret put <NAME> --name annex-auth`;
			// existing secrets are kept across `cf deploy`):
			//   JWT_SECRET
			//   TURNSTILE_SECRET
			//   STRIPE_SECRET_KEY      (sk_test_... or sk_live_...)
			//   STRIPE_WEBHOOK_SECRET  (whsec_... - generated by Stripe when you
			//                           register the /stripe/webhook endpoint)
			//   OIDC_PRIVATE_KEY       (RS256 signing key - RSA private JWK as a JSON
			//                           string. Generate with
			//                           `node scripts/gen-oidc-key.mjs`. The public
			//                           half is published at /oauth/jwks.)
		},
	},
});
