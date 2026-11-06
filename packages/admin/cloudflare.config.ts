import { bindings, defineConfig, triggers } from "cf/config";

export default defineConfig({
	worker: {
		name: "annex-admin",
		compatibilityDate: "2026-02-24",
		entrypoint: "src/index.ts",
		workersDev: false,
		assets: {
			htmlHandling: "auto-trailing-slash",
			notFoundHandling: "single-page-application",
		},
		domains: [
			"admin.cubityfir.st",
		],
		triggers: [
			triggers.scheduled({
				schedule: "17 * * * *",
			}),
		],
		env: {
			CF_ZONE_ID: bindings.text("397deb54a68d306201a295d1793fe84c"),
			CUSTOM_DOMAIN_CNAME_TARGET: bindings.text("cname.yourannex.com"),
			DB: bindings.d1({
				name: "cubedocs-main",
				id: "267490be-7141-4d00-ab23-152742f2f6ef",
			}),
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
			RATE_LIMITER_ADMIN: bindings.rateLimit({
				namespace: "2001",
				simple: {
					limit: 60,
					period: 60,
				},
			}),
			RATE_LIMITER_ADMIN_HANDOFF: bindings.rateLimit({
				namespace: "2002",
				simple: {
					limit: 10,
					period: 60,
				},
			}),
			RATE_LIMITER_AVATAR: bindings.rateLimit({
				namespace: "2003",
				simple: {
					limit: 300,
					period: 60,
				},
			}),
			SITE_ASSETS: bindings.assets(),
		},
	},
});
