import { createContext, useContext } from "react";

// ── Custom-domain serving ────────────────────────────────────────────────────
//
// A published site can be mapped to its owner's own domain (Cloudflare for SaaS;
// see the API worker's routes/customDomains.ts). When a visitor lands on such a
// host, the whole app runs in "host mode": it resolves the host → project once
// and serves ONLY that site's public pages, at clean root URLs
// (docs.acme.com/, docs.acme.com/getting-started). On our own app hosts the
// public site keeps its path-based URLs (/s/<slug>/<docId>).
//
// `SiteRouteContext` carries which mode we're in so PublicDocPage and its
// sub-trees build the right links without threading props everywhere.

export interface SiteRoute {
  /** True when serving a single site at the domain root (custom domain). */
  hostMode: boolean;
  /** The resolved project id-or-slug, when in host mode. */
  slug?: string;
}

// Default (no provider) = our own app host, path-based public site.
export const SiteRouteContext = createContext<SiteRoute>({ hostMode: false });

export function useSiteRoute(): SiteRoute {
  return useContext(SiteRouteContext);
}

// Hosts that are "us" (the app), not a customer's custom domain. Anything not
// matching is treated as a mapped custom domain. Suffix checks cover prod
// (docs.cubityfir.st), preview/dev (*.cubityfir.st, *.workers.dev, *.pages.dev)
// and local dev (localhost / 127.0.0.1 / *.local).
function isAppHost(host: string): boolean {
  if (host === "localhost" || host === "127.0.0.1") return true;
  if (host.endsWith(".local")) return true;
  if (host === "cubityfir.st" || host.endsWith(".cubityfir.st")) return true;
  if (host.endsWith(".workers.dev") || host.endsWith(".pages.dev")) return true;
  return false;
}

// In dev you can exercise the host-mode code path without a real custom domain
// by appending ?__site=<projectIdOrSlug> to the URL - it forces host mode for
// that project. Ignored outside dev.
export function devForcedSite(): string | null {
  if (!import.meta.env.DEV) return null;
  try {
    return new URLSearchParams(window.location.search).get("__site");
  } catch {
    return null;
  }
}

export function isCustomDomain(): boolean {
  if (devForcedSite()) return true;
  return !isAppHost(window.location.hostname);
}

// Build a link to a doc within the current site. In host mode the site lives at
// the root (/<docId>); otherwise under /s/<slug>/<docId>.
export function siteHref(
  route: SiteRoute,
  slug: string,
  docId: string,
  anchor?: string,
): string {
  const base = route.hostMode ? `/${docId}` : `/s/${slug}/${docId}`;
  return anchor ? `${base}#${anchor}` : base;
}
