import { registerSW } from "virtual:pwa-register";
import { toast } from "sonner";

// Service worker registration. Skipped in dev so it doesn't fight Vite HMR
// (`vite preview` serves the production build, so DEV is false there and
// this still runs for local prod-ish testing).
if (!import.meta.env.DEV) {
  const updateSW = registerSW({
    onRegisteredSW(_swUrl, registration) {
      if (!registration) return;
      // _headers serves sw.js no-cache, so update() reliably sees a fresh
      // worker. The cold load already triggers a check via the SW lifecycle;
      // these two cover long-lived tabs.
      let lastCheck = Date.now();
      const STALE_MS = 60_000;
      const check = () => {
        lastCheck = Date.now();
        void registration.update();
      };
      // Poll only while the tab is foregrounded - background timers are
      // throttled/frozen anyway, and this avoids needless requests.
      setInterval(() => {
        if (document.visibilityState === "visible") check();
      }, STALE_MS);
      // Returning to a tab that's been idle/backgrounded for a while: the
      // interval was throttled, so check right away - but debounce so rapid
      // tab-switching doesn't fire a burst.
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible" && Date.now() - lastCheck > STALE_MS) {
          check();
        }
      });
    },
    onNeedRefresh() {
      // A surprise reload would lose in-progress WYSIWYG/collab editing
      // state, so prompt instead of auto-reloading. onNeedRefresh can fire
      // more than once for the same waiting worker (our 60s poll + the
      // browser's own update check); the stable id makes sonner reuse the
      // existing toast instead of stacking a duplicate.
      toast("A new version is available", {
        id: "sw-update",
        description: "Reload to get the latest update.",
        duration: Infinity,
        action: {
          label: "Reload",
          onClick: () => {
            void updateSW(true);
          },
        },
      });
    },
  });
}
