import { useEffect, useState } from "react";
import { Routes, Route } from "react-router-dom";
import { PublicDocPage } from "./pages/PublicDocPage";
import { NotFound404 } from "./pages/NotFound404";
import { SiteRouteContext } from "@/lib/siteUrl";
import { devForcedSite } from "@/lib/siteUrl";
import { Toaster } from "@/components/ui/sonner";

// The app rendered when a visitor lands on a mapped custom domain (Cloudflare
// for SaaS - see the API worker's routes/customDomains.ts). It resolves the
// current host → project once, then serves ONLY that site's public pages at
// clean root URLs. No auth/app routes exist here; the custom domain is a
// read-only front door to one published site.

type Resolution =
  | { state: "loading" }
  | { state: "ready"; slug: string }
  | { state: "notfound" };

export function CustomDomainApp() {
  const [res, setRes] = useState<Resolution>({ state: "loading" });

  useEffect(() => {
    // Dev escape hatch: ?__site=<idOrSlug> renders host mode for that project
    // without a real custom domain (no host lookup needed).
    const forced = devForcedSite();
    if (forced) {
      setRes({ state: "ready", slug: forced });
      return;
    }
    let cancelled = false;
    fetch(`/api/public/site-by-host?host=${encodeURIComponent(window.location.hostname)}`)
      .then(r => (r.ok ? r.json() : null))
      .then((json: { ok: boolean; data?: { projectId: string; vanitySlug: string | null } } | null) => {
        if (cancelled) return;
        if (json?.ok && json.data) {
          setRes({ state: "ready", slug: json.data.vanitySlug ?? json.data.projectId });
        } else {
          setRes({ state: "notfound" });
        }
      })
      .catch(() => { if (!cancelled) setRes({ state: "notfound" }); });
    return () => { cancelled = true; };
  }, []);

  if (res.state === "loading") {
    return (
      <div className="flex h-screen items-center justify-center bg-background text-foreground">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    );
  }

  if (res.state === "notfound") {
    return (
      <NotFound404
        subtitle="No site is published at this domain. If you just set it up, DNS and the SSL certificate can take a few minutes to go live."
        primaryLabel="Refresh"
        primaryHref="/"
      />
    );
  }

  return (
    <SiteRouteContext.Provider value={{ hostMode: true, slug: res.slug }}>
      <Routes>
        <Route path="/" element={<PublicDocPage />} />
        <Route path="/:docId" element={<PublicDocPage />} />
        <Route
          path="*"
          element={
            <NotFound404
              subtitle="No published document exists at this location."
              primaryLabel="Go home"
              primaryHref="/"
            />
          }
        />
      </Routes>
      <Toaster />
    </SiteRouteContext.Provider>
  );
}
