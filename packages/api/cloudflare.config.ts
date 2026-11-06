import { bindings, defineConfig, exports, triggers } from "cf/config";

// D1 migrations for `DB` live in ./migrations (the `cf d1 migrations apply`
// default `--dir`). Apply them with `pnpm migrate` (local) or
// `node scripts/migrate.mjs remote` from the repo root.

export default defineConfig({
	accountId: "d843ae90cab33e54f4d284bc65d2fd6a",
	worker: {
		name: "annex-api",
		compatibilityDate: "2026-02-24",
		compatibilityFlags: [
			"nodejs_compat",
		],
		entrypoint: "src/index.ts",
		workersDev: false,
		triggers: [
			// Daily revision-retention sweep (pruneDocRevisions in lib/docOps.ts):
			// doc revisions older than 90 days are pruned, always keeping each
			// doc's newest.
			triggers.scheduled({
				schedule: "0 4 * * *",
			}),
		],
		// Replaces the Wrangler `[[migrations]]` history (tag "v1",
		// new_classes = ["DocCollabRoom"]). DocCollabRoom was created with
		// `new_classes`, so its live namespace is KV-backed - it MUST stay
		// "legacy-kv" (the namespace reports use_sqlite = false; "sqlite" is only
		// valid for brand-new namespaces).
		exports: {
			DocCollabRoom: exports.durableObject({ storage: "legacy-kv" }),
		},
		env: {
			ENVIRONMENT: bindings.text("production"),
			// Cloudflare for SaaS custom domains (see memories/Custom-Domains.md).
			// These live on the DEDICATED `yourannex.com` zone, kept separate from
			// cubityfir.st so the SaaS `*/*` catch-all route can't shadow our own
			// hosts (it once hijacked i.cubityfir.st). CUSTOM_DOMAIN_CNAME_TARGET is
			// the proxied hostname customers CNAME their domain to; CF_ZONE_ID is the
			// yourannex.com zone id. When CF_ZONE_ID or CF_API_TOKEN is unset, the
			// custom-domain endpoints report "not configured" and never call
			// Cloudflare.
			CUSTOM_DOMAIN_CNAME_TARGET: bindings.text("publish.yourannex.com"),
			CF_ZONE_ID: bindings.text("397deb54a68d306201a295d1793fe84c"),
			// Direct-from-R2 presigned video streaming (see lib/r2Presign.ts). The
			// bucket name matches the ASSETS R2 binding below. R2_ACCOUNT_ID is the
			// CF account id; R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY are secrets
			// (an R2 API token with Object Read for cubedocs-assets). When any of
			// the four is unset, video falls back to the in-Worker token streaming
			// route.
			R2_BUCKET_NAME: bindings.text("cubedocs-assets"),
			R2_ACCOUNT_ID: bindings.text("d843ae90cab33e54f4d284bc65d2fd6a"),
			DB: bindings.d1({
				name: "cubedocs-main",
				id: "267490be-7141-4d00-ab23-152742f2f6ef",
			}),
			// Read-only access to the auth DB so this worker can verify sessions
			// inline (one D1 batch read of users + sessions) instead of
			// round-tripping through the auth worker's /verify route on every
			// request. Migrations live with the auth worker - never apply
			// migrations to cubedocs-auth from this package.
			AUTH_DB: bindings.d1({
				name: "cubedocs-auth",
				id: "db327d85-b8c2-4fed-adaa-25e748778c86",
			}),
			// Cloudflare Flagship feature flags. Shared app with the auth worker.
			// Flags in use:
			//   api              (default on)  - killswitch for the whole /v1 public API surface (v1.ts).
			//   custom-theming   (default off) - per-user gate for custom themes (index.ts).
			//   ai-summaries     (default on)  - killswitch for the OpenAI summarize endpoint (routes/ai.ts).
			//   realtime-collab  (default on)  - killswitch for new collab WS connections (handleCollabUpgrade).
			// NOTE: local dev DOES serve this binding with the real flag state, so a
			// flag flipped in the Flagship dashboard affects local dev too. The
			// per-call code defaults only apply when the binding itself is missing.
			FLAGS: bindings.flagship({
				id: "08fb610f-b8ed-4a60-afcf-7f5fe6b9f948",
			}),
			ASSETS: bindings.r2({
				name: "cubedocs-assets",
			}),
			// Service binding to auth worker (zero-latency internal calls).
			AUTH: bindings.worker({
				worker: "annex-auth",
			}),
			DOC_COLLAB: bindings.durableObject({
				worker: "annex-api",
				exportName: "DocCollabRoom",
			}),
			// Per-user limiter for the invite-by-email lookup. The auth worker's
			// /lookup also has its own coarser IP-keyed limiter - this one caps any
			// single account from scraping the email→user map even when multiple
			// users share an IP (office NAT).
			RATE_LIMITER_INVITE_LOOKUP: bindings.rateLimit({
				namespace: "2001",
				simple: {
					limit: 8,
					period: 60,
				},
			}),
			// Per-API-key limiter for the public /v1 surface, keyed by
			// `apikey:<id>`. Caps abuse / runaway scripts on a single scoped key
			// without touching the interactive JWT routes.
			RATE_LIMITER_API: bindings.rateLimit({
				namespace: "2002",
				simple: {
					limit: 120,
					period: 60,
				},
			}),
			// Per-IP limiter for the public "Report Site" endpoint (routes/public.ts
			// handlePublicReport). Reports are rare, deliberate actions - a human
			// files one or two; anything faster is a script.
			RATE_LIMITER_REPORT: bindings.rateLimit({
				namespace: "2003",
				simple: {
					limit: 3,
					period: 60,
				},
			}),
			// Secrets (set via `npx wrangler secret put <NAME> --name annex-api`;
			// existing secrets are kept across `cf deploy`):
			//   JWT_SECRET            (same value as auth worker - used for local JWT verification)
			//   OPENAI_API_KEY        (OpenAI API key for AI summarisation feature)
			//   CF_API_TOKEN          (Cloudflare token scoped to the zone with "SSL and
			//                          Certificates: Edit" - used to create/poll custom hostnames)
			//   R2_ACCESS_KEY_ID      (presigned video streaming, see above)
			//   R2_SECRET_ACCESS_KEY  (presigned video streaming, see above)
		},
	},
});
