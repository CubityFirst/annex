import { bindings, defineConfig, triggers } from "cf/config";

/**
 * This migration needs manual work. Resolve every TODO in this file, then remove the error below.
 */
/**
 * TODO(@cloudflare): cf migrate: d1_databases.0: The options `migrations_dir` at `d1_databases.0` require manual migration.
 */
throw new Error("Migration incomplete. Resolve every cf migrate TODO in `cloudflare.config.ts`.");

export default defineConfig({
	worker: {
		name: "annex-auth",
		compatibilityDate: "2026-02-24",
		compatibilityFlags: [
			"nodejs_compat",
		],
		entrypoint: "src/index.ts",
		workersDev: false,
		triggers: [
			triggers.fetch({
				pattern: "auth.cubityfir.st/oauth/*",
				zone: "cubityfir.st",
			}),
			triggers.fetch({
				pattern: "auth.cubityfir.st/.well-known/*",
				zone: "cubityfir.st",
			}),
			triggers.scheduled({
				schedule: "0 3 * * SUN",
			}),
		],
		env: {
			JWT_ISSUER: bindings.text("https://auth.cubedocs.com"),
			ADMIN_APP_ORIGIN: bindings.text("https://admin.cubityfir.st"),
			APP_ORIGIN: bindings.text("https://docs.cubityfir.st"),
			OIDC_ISSUER: bindings.text("https://auth.cubityfir.st"),
			OIDC_AUTHORIZE_URL: bindings.text("https://docs.cubityfir.st/oauth/authorize"),
			WEBAUTHN_RP_ID: bindings.text("docs.cubityfir.st"),
			WEBAUTHN_RP_NAME: bindings.text("Annex"),
			WEBAUTHN_ORIGIN: bindings.text("https://docs.cubityfir.st"),
			STRIPE_INK_PRICE_ID: bindings.text("price_1TVJk5Rckd4Ls9nPHpnY4tAN"),
			DB: bindings.d1({
				name: "cubedocs-auth",
				id: "db327d85-b8c2-4fed-adaa-25e748778c86",
			}),
			FLAGS: bindings.flagship({
				id: "08fb610f-b8ed-4a60-afcf-7f5fe6b9f948",
			}),
			EMAIL: bindings.sendEmail({
				allowedSenderAddresses: [
					"noreply@docs.cubityfir.st",
				],
			}),
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
			RATE_LIMITER_OIDC: bindings.rateLimit({
				namespace: "1004",
				simple: {
					limit: 100,
					period: 60,
				},
			}),
		},
		/**
		 * TODO(@cloudflare): cf migrate: The options `migrations_dir` at `d1_databases.0` require manual migration.
		 */
	},
});
