import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";
import path from "path";
import { buildLandingCard, componentEmbedScript, validateComponentEmbed } from "./worker/componentEmbed";

// Bake the site-wide Discord component-embed card (see worker/componentEmbed.ts)
// into index.html's default-meta block. Discord never runs JS, so the tag has to
// be in the served HTML; the worker strips it along with the other defaults
// when it injects a published doc's own card. An invalid card fails the build
// rather than shipping a payload Discord would silently ignore.
function discordComponentEmbed(origin: string): Plugin {
  return {
    name: "annex:discord-component-embed",
    transformIndexHtml(html) {
      const card = buildLandingCard(origin);
      const script = componentEmbedScript(card);
      if (!script) throw new Error(`Invalid landing component embed: ${validateComponentEmbed(card).join("; ")}`);
      return html.replace("<!-- discord:component-embed -->", () => script);
    },
  };
}

export default defineConfig(({ mode }) => {
  const isDev = mode === "development";

  return {
    plugins: [
      react(),
      tailwindcss(),
      discordComponentEmbed("https://docs.cubityfir.st"),
      VitePWA({
        registerType: "prompt",
        injectRegister: null,
        manifest: {
          name: isDev ? "Annex (Dev)" : "Annex",
          short_name: isDev ? "Annex Dev" : "Annex",
          description: "A place to keep anything.",
          start_url: "/dashboard",
          display: "standalone",
          background_color: "#09090b",
          theme_color: "#09090b",
          icons: isDev
            ? [
                { src: "/icon-192-dev.png", sizes: "192x192", type: "image/png" },
                { src: "/icon-512-dev.png", sizes: "512x512", type: "image/png" },
                { src: "/icon-512-dev.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
              ]
            : [
                { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
                { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
                { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
              ],
        },
        workbox: {
          globPatterns: ["**/*.{js,css,html,ico,png,svg,woff2}"],
          // Link-unfurl card for crawlers only - no reason to precache it.
          globIgnores: ["og-image.png"],
          navigateFallback: "/index.html",
          navigateFallbackDenylist: [/^\/api\//],
          maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
          cleanupOutdatedCaches: true,
        },
        devOptions: {
          enabled: true,
        },
      }),
    ],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
    server: {
      port: 5173,
      proxy: {
        "/api": {
          target: "http://localhost:8787",
          rewrite: path => path.replace(/^\/api/, ""),
          ws: true,
          // A proxied WebSocket (collab) whose client vanishes mid-write
          // raises ECONNABORTED on the raw socket; unhandled, that error
          // cascade fail-fasts the whole dev server on Windows (exit
          // 0xC0000409). Swallow the error and drop the socket instead.
          configure(proxy) {
            const drop = (sock: unknown) => {
              try { (sock as { destroy?: () => void })?.destroy?.(); } catch { /* already gone */ }
            };
            proxy.on("error", (_err, _req, res) => drop(res));
            proxy.on("proxyReqWs", (_proxyReq, _req, socket) => {
              socket.on("error", () => drop(socket));
            });
            // Vite's bundled http-proxy types don't declare the "open" event's
            // socket arg, so take it via rest args to satisfy the () => void
            // overload without losing the runtime socket.
            proxy.on("open", (...args: unknown[]) => {
              const proxySocket = args[0] as { on?: (ev: string, cb: () => void) => void } | undefined;
              proxySocket?.on?.("error", () => drop(proxySocket));
            });
          },
        },
      },
    },
    build: {
      outDir: "dist",
    },
    define: {
      // @excalidraw/excalidraw reads process.env.IS_PREACT at runtime; a Vite/React
      // bundle has no `process` global, so without this the chunk throws
      // "process is not defined" the moment the editor loads.
      "process.env.IS_PREACT": JSON.stringify("false"),
    },
  };
});
