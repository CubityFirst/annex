import { defineWranglerConfig } from "wrangler/experimental-config";

// Wrangler build settings for `cf build` / `cf deploy` (Worker config and
// bindings live in cloudflare.config.ts).
//
// There is no wrangler.toml. Local dev (`pnpm dev`) runs
// `wrangler dev --experimental-new-config --persist-to ../../.wrangler/state`,
// which reads this file + cloudflare.config.ts directly: every worker must share
// one local state dir (the api worker reads the auth DB via AUTH_DB), and
// `cf dev` cannot set a persist directory yet.
export default defineWranglerConfig({
	// Match the previous `wrangler deploy` default (no source map upload).
	uploadSourceMaps: false,
});
