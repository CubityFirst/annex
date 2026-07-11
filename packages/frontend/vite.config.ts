import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";
import path from "path";

export default defineConfig(({ mode }) => {
  const isDev = mode === "development";

  return {
    plugins: [
      react(),
      tailwindcss(),
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
