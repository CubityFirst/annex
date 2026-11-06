import { bindings, defineConfig, triggers } from "cf/config";

/**
 * This migration needs manual work. Resolve every TODO in this file, then remove the error below.
 */
/**
 * TODO(@cloudflare): cf migrate: d1_databases.0: The options `migrations_dir` at `d1_databases.0` require manual migration.
 */
/**
 * TODO(@cloudflare): cf migrate: durable_objects.bindings.0: Durable Object bindings require manual review after migration.
 * @see https://developers.cloudflare.com/workers/runtime-apis/context/#exports
 */
/**
 * TODO(@cloudflare): cf migrate: migrations: Wrangler Durable Object migrations are unsupported. Replace them with an exports lifecycle declaration, for example `exports: { MyDurableObject: exports.durableObject({ storage: "sqlite" }) }`.
 * @see https://developers.cloudflare.com/workers/runtime-apis/context/#exports
 */
/**
 * TODO(@cloudflare): cf migrate: Automatic dependency installation was disabled. Install `cf@latest` before using the generated configuration.
 */
throw new Error("Migration incomplete. Resolve every cf migrate TODO in `cloudflare.config.ts`.");

export default defineConfig({
	worker: {
		name: "annex-api",
		compatibilityDate: "2026-02-24",
		compatibilityFlags: [
			"nodejs_compat",
		],
		entrypoint: "src/index.ts",
		workersDev: false,
		triggers: [
			triggers.scheduled({
				schedule: "0 4 * * *",
			}),
		],
		env: {
			ENVIRONMENT: bindings.text("production"),
			CUSTOM_DOMAIN_CNAME_TARGET: bindings.text("publish.yourannex.com"),
			CF_ZONE_ID: bindings.text("397deb54a68d306201a295d1793fe84c"),
			R2_BUCKET_NAME: bindings.text("cubedocs-assets"),
			R2_ACCOUNT_ID: bindings.text("d843ae90cab33e54f4d284bc65d2fd6a"),
			DB: bindings.d1({
				name: "cubedocs-main",
				id: "267490be-7141-4d00-ab23-152742f2f6ef",
			}),
			AUTH_DB: bindings.d1({
				name: "cubedocs-auth",
				id: "db327d85-b8c2-4fed-adaa-25e748778c86",
			}),
			FLAGS: bindings.flagship({
				id: "08fb610f-b8ed-4a60-afcf-7f5fe6b9f948",
			}),
			ASSETS: bindings.r2({
				name: "cubedocs-assets",
			}),
			AUTH: bindings.worker({
				worker: "annex-auth",
			}),
			DOC_COLLAB: bindings.durableObject({
				worker: "annex-api",
				exportName: "DocCollabRoom",
			}),
			RATE_LIMITER_INVITE_LOOKUP: bindings.rateLimit({
				namespace: "2001",
				simple: {
					limit: 8,
					period: 60,
				},
			}),
			RATE_LIMITER_API: bindings.rateLimit({
				namespace: "2002",
				simple: {
					limit: 120,
					period: 60,
				},
			}),
			RATE_LIMITER_REPORT: bindings.rateLimit({
				namespace: "2003",
				simple: {
					limit: 3,
					period: 60,
				},
			}),
		},
		/**
		 * TODO(@cloudflare): cf migrate: The options `migrations_dir` at `d1_databases.0` require manual migration.
		 */
		/**
		 * TODO(@cloudflare): cf migrate: Durable Object bindings require manual review after migration.
		 * @see https://developers.cloudflare.com/workers/runtime-apis/context/#exports
		 */
		/**
		 * TODO(@cloudflare): cf migrate: Wrangler Durable Object migrations are unsupported. Replace them with an exports lifecycle declaration, for example `exports: { MyDurableObject: exports.durableObject({ storage: "sqlite" }) }`.
		 * @see https://developers.cloudflare.com/workers/runtime-apis/context/#exports
		 */
	},
});
