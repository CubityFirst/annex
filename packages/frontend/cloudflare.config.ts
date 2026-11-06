import { bindings, defineConfig, triggers } from "cf/config";

/**
 * Secret-like files were detected but not read or migrated: .env.production. Only `secrets.required` entries are migrated.
 * @see https://developers.cloudflare.com/workers/configuration/secrets/
 */

export default defineConfig({
	worker: {
		name: "annex-frontend",
		compatibilityDate: "2026-02-24",
		entrypoint: "worker/index.ts",
		domains: [
			"docs.cubityfir.st",
		],
		triggers: [
			triggers.fetch({
				pattern: "*/*",
				zone: "yourannex.com",
			}),
		],
		env: {
			API: bindings.worker({
				worker: "annex-api",
			}),
			AUTH: bindings.worker({
				worker: "annex-auth",
			}),
			ASSETS: bindings.assets(),
		},
	},
});
