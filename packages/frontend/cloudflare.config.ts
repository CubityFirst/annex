import { bindings, defineConfig, triggers } from "cf/config";

// .env.production only holds Vite build-time (VITE_*) public values; it is not
// a Worker secret file and is read by `vite build`, not by cf.

export default defineConfig({
	accountId: "d843ae90cab33e54f4d284bc65d2fd6a",
	worker: {
		name: "annex-frontend",
		compatibilityDate: "2026-02-24",
		entrypoint: "worker/index.ts",
		// Asset directory (./dist, built by `pnpm build`) is a build setting - see
		// wrangler.config.ts.
		domains: [
			"docs.cubityfir.st",
		],
		triggers: [
			// Cloudflare-for-SaaS catch-all, on the DEDICATED `yourannex.com` zone.
			// Customer custom domains (their.domain -> publish.yourannex.com) arrive
			// as custom hostnames on that zone; this `*/*` route hands them to
			// annex-frontend in host-mode. Required - without it, custom hostnames
			// hit the originless fallback origin and return 522. The zone is
			// dedicated to SaaS routing (nothing else lives on it), so `*/*` is safe
			// here: it can't shadow our own infra the way it did on cubityfir.st
			// (where it once hijacked i.cubityfir.st). The app itself still serves
			// on docs.cubityfir.st via the exact custom domain above.
			// NOTE: the OLD `*/*` route on the cubityfir.st zone must be deleted in
			// the dashboard - deploys only manage the routes in this file and won't
			// remove it. See memories/Custom-Domains.md.
			triggers.fetch({
				pattern: "*/*",
				zone: "yourannex.com",
			}),
		],
		env: {
			API: bindings.worker({
				worker: "annex-api",
			}),
			// Service binding to the auth worker - used only for Stripe webhook
			// forwarding (/stripe/webhook). The auth worker is otherwise reached
			// via the api worker's own AUTH binding for authenticated calls.
			AUTH: bindings.worker({
				worker: "annex-auth",
			}),
			ASSETS: bindings.assets(),
		},
	},
});
