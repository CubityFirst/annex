import { defineWranglerConfig } from "wrangler/experimental-config";

// Wrangler build settings for `cf build` / `cf deploy` (Worker config and
// bindings live in cloudflare.config.ts).
//
// Local dev (`pnpm dev`) still runs `wrangler dev --persist-to ../../.wrangler/state`
// against wrangler.toml: every worker must share one local state dir (the api
// worker reads the auth DB via AUTH_DB), and `cf dev` cannot set a persist
// directory yet (it always uses <package>/.wrangler/state).
export default defineWranglerConfig({
	// Match the previous `wrangler deploy` default (no source map upload).
	uploadSourceMaps: false,
});
