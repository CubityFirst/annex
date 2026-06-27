import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { CustomDomainApp } from "./CustomDomainApp";
import { isCustomDomain } from "@/lib/siteUrl";
import { TooltipProvider } from "@/components/ui/tooltip";
import { applyFontVarsToRoot, readFontPrefsCookie } from "@/lib/fonts";
import { applyThemeToRoot, readThemePrefsCookie, pathUsesUserTheme, DEFAULT_THEME_PREFS } from "@/lib/theme";
import { isDemoMode } from "@/lib/demo";
import "./pwa";

// Apply the user's saved font choices before React mounts so PublicDocPage and
// the pre-/api/me boot phase of authenticated pages render in the right font
// instead of flashing the default sans stack. Cookie is written by DocsLayout
// whenever font state changes.
applyFontVarsToRoot(readFontPrefsCookie());

// Same rationale for the theme - but the saved theme is in-app only. The
// landing/auth routes always boot to the default (dark) brand look; App keeps
// them there across client-side navigation. index.html hard-codes
// class="dark" so the default case still has zero flash.
applyThemeToRoot(
  pathUsesUserTheme(window.location.pathname) ? readThemePrefsCookie() : DEFAULT_THEME_PREFS,
);

if (import.meta.env.DEV) {
  document.documentElement.setAttribute("data-dev", "true");
}

if (import.meta.env.VITE_BRANCH === "dev") {
  document.title = "Annex (dev)";
}

// On a customer's mapped custom domain we serve a single published site at the
// root (host mode); on our own app hosts we run the full app.
const Root = isCustomDomain() ? CustomDomainApp : App;

async function boot() {
  // Demo mode answers every /api call from an in-memory dataset. The patch
  // must be in place before React mounts (pages fetch in their first effects),
  // and the module is dynamically imported so the demo dataset stays out of
  // the normal boot path.
  if (isDemoMode()) {
    const { installDemoServer } = await import("@/lib/demoServer");
    installDemoServer();
  }

  createRoot(document.getElementById("app")!).render(
    <StrictMode>
      <BrowserRouter>
        <TooltipProvider>
          <Root />
        </TooltipProvider>
      </BrowserRouter>
    </StrictMode>,
  );
}

void boot();
