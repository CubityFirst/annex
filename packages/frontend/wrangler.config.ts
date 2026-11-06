import { defineWranglerConfig } from "wrangler/experimental-config";

// Wrangler build settings for the Worker in worker/index.ts (Worker config and
// bindings live in cloudflare.config.ts).
//
// This package also depends on Vite (for the SPA), so `cf build` / `cf dev`
// would detect it as a Vite framework project and run `vite` instead of
// Wrangler. Build the Worker with `pnpm build:worker` (`cf-wrangler build`)
// and deploy that Build Output with `cf deploy --prebuilt` - see the `deploy`
// script in package.json.
export default defineWranglerConfig({
	// Built by `pnpm build` (tsc -b && vite build).
	assetsDirectory: "./dist",
	// Match the previous `wrangler deploy` default (no source map upload).
	uploadSourceMaps: false,
});
