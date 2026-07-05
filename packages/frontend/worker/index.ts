export interface Env {
  API: Fetcher;
  AUTH: Fetcher;
  ASSETS: Fetcher;
}

function extractFirstParagraph(content: string, maxLength = 160): string {
  const lines = content.split("\n");
  let inFrontmatter = false;
  let frontmatterDone = false;
  let inCodeBlock = false;
  const paragraphLines: string[] = [];
  let inParagraph = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (i === 0 && line.trimEnd() === "---") { inFrontmatter = true; continue; }
    if (inFrontmatter && !frontmatterDone) {
      if (line.trimEnd() === "---") { inFrontmatter = false; frontmatterDone = true; }
      continue;
    }

    const trimmed = line.trim();

    if (trimmed.startsWith("```")) { inCodeBlock = !inCodeBlock; continue; }
    if (inCodeBlock) continue;
    if (trimmed.startsWith("#")) continue;
    if (/^[-*=]{3,}$/.test(trimmed)) continue;
    if (trimmed.startsWith(">") || trimmed.startsWith("- ") || trimmed.startsWith("* ") || /^\d+\. /.test(trimmed)) continue;

    if (trimmed === "") {
      if (inParagraph) break;
      continue;
    }

    inParagraph = true;
    paragraphLines.push(trimmed);
  }

  if (paragraphLines.length === 0) return "";

  let text = paragraphLines.join(" ");
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  text = text.replace(/\[\[([^\]|]+)\|?[^\]]*\]\]/g, "$1");
  text = text.replace(/\*\*(.+?)\*\*/g, "$1");
  text = text.replace(/__(.+?)__/g, "$1");
  text = text.replace(/\*(.+?)\*/g, "$1");
  text = text.replace(/_(.+?)_/g, "$1");
  text = text.replace(/`(.+?)`/g, "$1");
  text = text.trim();

  if (text.length > maxLength) text = text.slice(0, maxLength - 1) + "…";
  return text;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const META_CACHE_TTL = 43200; // 12h

// Hosts that are "us" (the app / previews / local dev) rather than a customer's
// mapped custom domain. MUST stay in sync with isAppHost in
// packages/frontend/src/lib/siteUrl.ts - the SPA uses its copy to decide
// whether to boot CustomDomainApp, this one decides whether to inject
// site-scoped meta / robots / sitemap at the edge.
export function isAppHost(host: string): boolean {
  if (host === "localhost" || host === "127.0.0.1") return true;
  if (host.endsWith(".local")) return true;
  if (host === "cubityfir.st" || host.endsWith(".cubityfir.st")) return true;
  if (host.endsWith(".workers.dev") || host.endsWith(".pages.dev")) return true;
  return false;
}

// Fetch the base index.html and inject <title> + OpenGraph/description meta so
// link-unfurlers (Slack, Discord, Twitter, iMessage) show a contextual preview
// instead of the static default, plus an optional canonical URL so search
// engines pick one address for content reachable at several. Returns null if
// the index asset is missing so the caller can fall through to normal serving.
async function renderIndexWithMeta(
  env: Env,
  request: Request,
  meta: { pageTitle: string; description: string | null; ogImage: string | null; canonicalUrl?: string | null },
): Promise<Response | null> {
  const indexRes = await env.ASSETS.fetch(new Request(new URL("/", request.url).toString(), request));
  if (!indexRes.ok) return null;
  let html = await indexRes.text();
  html = html.replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(meta.pageTitle)}</title>`);
  const ogTags = [
    `<meta property="og:title" content="${escapeHtml(meta.pageTitle)}" />`,
    meta.description ? `<meta property="og:description" content="${escapeHtml(meta.description)}" />` : "",
    meta.description ? `<meta name="description" content="${escapeHtml(meta.description)}" />` : "",
    meta.ogImage ? `<meta property="og:image" content="${escapeHtml(meta.ogImage)}" />` : "",
    meta.canonicalUrl ? `<link rel="canonical" href="${escapeHtml(meta.canonicalUrl)}" />` : "",
    meta.canonicalUrl ? `<meta property="og:url" content="${escapeHtml(meta.canonicalUrl)}" />` : "",
  ].filter(Boolean).join("\n");
  html = html.replace(/<\/head>/, `${ogTags}\n</head>`);
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=UTF-8",
      "Cache-Control": `public, max-age=${META_CACHE_TTL}`,
    },
  });
}

const INVITE_ROLE_LABELS: Record<string, string> = {
  limited: "limited member",
  viewer: "viewer",
  editor: "editor",
  admin: "admin",
};

// Build the <title>/description for an invite-link preview from the public
// invite metadata. Pure so it can be unit-tested without a Worker env.
export function buildInviteMeta(data: { projectName: string; ownerName: string; role: string }): {
  pageTitle: string;
  description: string;
} {
  const roleLabel = INVITE_ROLE_LABELS[data.role] ?? "member";
  const article = /^[aeiou]/i.test(roleLabel) ? "an" : "a";
  return {
    pageTitle: `Join ${data.projectName} on Annex`,
    description: `${data.ownerName} invited you to collaborate on ${data.projectName} as ${article} ${roleLabel}.`,
  };
}

// Resolve a frontmatter `image:` value into an absolute URL safe for
// `<meta property="og:image">`. OG consumers (Slack, Twitter, Discord) only
// follow absolute URLs, so anything relative gets the request origin prepended.
// `/api/files/<id>` paths are rewritten to the public-files endpoint with the
// project context, mirroring AuthenticatedImage's client-side rewrite.
export function resolveImageUrl(raw: string, requestUrl: URL, projectId: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (trimmed.startsWith("/api/files/")) {
    let publicPath = trimmed.replace("/api/files/", "/api/public/files/");
    publicPath += (publicPath.includes("?") ? "&" : "?") + `projectId=${encodeURIComponent(projectId)}`;
    return `${requestUrl.origin}${publicPath}`;
  }
  if (trimmed.startsWith("/")) return `${requestUrl.origin}${trimmed}`;
  return null;
}

// ── Custom-domain (host-mode) edge serving ─────────────────────────────────
//
// Requests whose host isn't one of ours come in through the Cloudflare-for-SaaS
// zone and serve exactly one published site at root URLs (docs.acme.com/,
// docs.acme.com/<docId>). The SPA handles rendering; this worker's job is the
// parts a client-side app can't do: per-doc OG/title meta for link unfurlers,
// a canonical URL for search engines, and robots.txt / sitemap.xml.

interface ResolvedSite {
  projectId: string;
  vanitySlug: string | null;
  name: string;
  homeDocId: string | null;
}

const HOST_RESOLVE_TTL = 120; // seconds

// Resolve a custom host to its published site via the API, memoized in the
// edge cache so the per-request cost is a cache hit, not an API+D1 roundtrip.
// Unmapped hosts aren't cached (rare, and a just-activated domain should not
// have to wait out a negative cache).
async function resolveCustomHost(env: Env, host: string): Promise<ResolvedSite | null> {
  const cache = caches.default;
  const cacheKey = new Request(`https://host-resolve.internal/${host}`);
  const cached = await cache.match(cacheKey);
  if (cached) return await cached.json<ResolvedSite>();
  const res = await env.API.fetch(
    new Request(`https://api/public/site-by-host?host=${encodeURIComponent(host)}`),
  );
  if (!res.ok) return null;
  const json = await res.json<{ ok: boolean; data?: ResolvedSite }>();
  if (!json.ok || !json.data) return null;
  await cache.put(cacheKey, new Response(JSON.stringify(json.data), {
    headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${HOST_RESOLVE_TTL}` },
  }));
  return json.data;
}

// Minimal sitemap for a custom-domain site: the root (home doc) plus every
// doc's clean URL. The home doc is listed only as `/` so the same content
// doesn't appear under two URLs. Pure so it can be unit-tested.
export function buildSitemapXml(host: string, homeDocId: string | null, docIds: string[]): string {
  const urls = ["/", ...docIds.filter(id => id !== homeDocId).map(id => `/${id}`)];
  const entries = urls
    .map(path => `  <url><loc>${escapeHtml(`https://${host}${path}`)}</loc></url>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>\n`;
}

// The public doc payload bits the meta injectors need (shared by the /s/ share
// path and the custom-host path).
interface PublicDocMeta {
  doc: { title: string; display_title: string | null; description: string | null; image: string | null; content: string };
  project: { id: string; name: string; vanity_slug: string | null; custom_domain: string | null };
}

async function fetchPublicDocMeta(env: Env, projectIdOrSlug: string, docId: string): Promise<PublicDocMeta | null> {
  const res = await env.API.fetch(
    new Request(`https://api/public/docs/${projectIdOrSlug}/${docId}`, { method: "GET" }),
  );
  if (!res.ok) return null;
  const json = await res.json<{ ok: boolean; data?: PublicDocMeta }>();
  return json.ok && json.data ? json.data : null;
}

// Serve the custom-host-specific responses; null falls through to normal
// asset/SPA serving (which is what actually renders the site).
async function handleCustomHost(request: Request, env: Env, url: URL, host: string): Promise<Response | null> {
  if (request.method !== "GET") return null;

  // Only page URLs (/, /<docId>) and the two crawler files need host
  // resolution - bail before it for asset paths (/assets/*.js etc.) so they
  // don't pay a cache match / API roundtrip on every load.
  const isPagePath = url.pathname === "/" || /^\/[^/.]+$/.test(url.pathname);
  if (!isPagePath && url.pathname !== "/robots.txt" && url.pathname !== "/sitemap.xml") return null;

  const site = await resolveCustomHost(env, host);
  if (!site) return null; // unmapped/unpublished → SPA shows its "not live yet" page

  if (url.pathname === "/robots.txt") {
    return new Response(`User-agent: *\nAllow: /\nSitemap: https://${host}/sitemap.xml\n`, {
      headers: { "Content-Type": "text/plain; charset=UTF-8", "Cache-Control": "public, max-age=3600" },
    });
  }

  if (url.pathname === "/sitemap.xml") {
    const cache = caches.default;
    const cacheKey = new Request(`https://custom-host-meta.internal/${host}/sitemap.xml`);
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
    const res = await env.API.fetch(new Request(`https://api/public/projects/${site.projectId}`, { method: "GET" }));
    if (!res.ok) return null;
    const json = await res.json<{ ok: boolean; data?: { home_doc_id: string | null; docs: Array<{ id: string }> } }>();
    if (!json.ok || !json.data) return null;
    const response = new Response(buildSitemapXml(host, json.data.home_doc_id, json.data.docs.map(d => d.id)), {
      headers: { "Content-Type": "application/xml; charset=UTF-8", "Cache-Control": "public, max-age=3600" },
    });
    await cache.put(cacheKey, response.clone());
    return response;
  }

  // Doc pages: `/` (home doc) and `/<docId>`. Paths with dots (favicon.ico,
  // assets) and deeper paths fall through to normal asset serving.
  const docMatch = url.pathname === "/" ? null : url.pathname.match(/^\/([^/.]+)$/);
  const docId = docMatch ? docMatch[1] : url.pathname === "/" ? site.homeDocId : null;
  if (!docId) return null;

  try {
    const cache = caches.default;
    const cacheKey = new Request(`https://custom-host-meta.internal/${host}${url.pathname}`);
    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    const data = await fetchPublicDocMeta(env, site.projectId, docId);
    if (!data) return null; // not a doc (maybe a file id) → SPA decides
    const docTitle = data.doc.display_title ?? data.doc.title;
    const response = await renderIndexWithMeta(env, request, {
      pageTitle: `${docTitle} - ${data.project.name}`,
      description: data.doc.description ?? extractFirstParagraph(data.doc.content),
      ogImage: data.doc.image ? resolveImageUrl(data.doc.image, url, data.project.id) : null,
      canonicalUrl: url.pathname === "/" ? `https://${host}/` : `https://${host}/${docId}`,
    });
    if (!response) return null;
    await cache.put(cacheKey, response.clone());
    return response;
  } catch {
    return null; // fall through to normal asset serving
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);

      // Stripe webhook - forwarded to the auth worker via service binding
      // verbatim. The auth worker reads the raw body and verifies the
      // signature; we must not parse, alter, or strip headers along the
      // way or signature verification will fail.
      if (url.pathname === "/stripe/webhook") {
        return await env.AUTH.fetch(new Request("https://auth/stripe/webhook", request));
      }

      // Proxy /api/* to the API worker via Service Binding
      if (url.pathname.startsWith("/api/")) {
        const apiUrl = new URL(url.pathname.replace(/^\/api/, "") || "/", "https://api");
        apiUrl.search = url.search;
        const proxied = new Request(apiUrl.toString(), request);
        // Service-binding hops drop CF-Connecting-IP, so forward the
        // edge-observed client IP as X-Client-IP for downstream rate limiting
        // and session bookkeeping. Always overwrite: an inbound X-Client-IP is
        // client-controlled and must never survive the hop.
        const clientIp = request.headers.get("CF-Connecting-IP");
        if (clientIp) proxied.headers.set("X-Client-IP", clientIp);
        else proxied.headers.delete("X-Client-IP");
        return await env.API.fetch(proxied);
      }

      // A host that isn't ours is a mapped custom domain (Cloudflare for SaaS):
      // serve its doc meta / robots / sitemap; anything else falls through to
      // the normal asset/SPA serving below.
      const host = url.hostname.toLowerCase();
      if (!isAppHost(host)) {
        const customResponse = await handleCustomHost(request, env, url, host);
        if (customResponse) return customResponse;
      }

      // Inject OG metadata for share links
      const shareMatch = url.pathname.match(/^\/s\/([^/]+)\/([^/]+)$/);
      if (shareMatch) {
        const [, projectSlug, docId] = shareMatch;
        try {
          const cache = caches.default;
          const cacheKey = new Request(`https://share-meta.internal/${projectSlug}/${docId}`);
          const cached = await cache.match(cacheKey);
          if (cached) return cached;

          const data = await fetchPublicDocMeta(env, projectSlug, docId);
          if (data) {
            const { doc, project } = data;
            const docTitle = doc.display_title ?? doc.title;
            const pageTitle = `${docTitle} - ${project.name}`;
            const description = doc.description ?? extractFirstParagraph(doc.content);
            const ogImage = doc.image ? resolveImageUrl(doc.image, url, project.id) : null;
            // The custom domain (when active) is the canonical address for this
            // content; otherwise the vanity-slug path is (the same doc is also
            // reachable under the raw project id).
            const canonicalUrl = project.custom_domain
              ? `https://${project.custom_domain}/${docId}`
              : `${url.origin}/s/${project.vanity_slug ?? project.id}/${docId}`;

            const response = await renderIndexWithMeta(env, request, { pageTitle, description, ogImage, canonicalUrl });
            if (response) {
              await cache.put(cacheKey, response.clone());
              return response;
            }
          }
        } catch {
          // Fall through to normal asset serving
        }
      }

      // Inject OG metadata for invite links so a shared /invite/:token unfurls
      // as "Join <project> on Annex" instead of the generic app metadata.
      const inviteMatch = url.pathname.match(/^\/invite\/([^/]+)$/);
      if (inviteMatch) {
        const [, token] = inviteMatch;
        try {
          const cache = caches.default;
          const cacheKey = new Request(`https://invite-meta.internal/${token}`);
          const cached = await cache.match(cacheKey);
          if (cached) return cached;

          const metaRes = await env.API.fetch(
            new Request(`https://api/invites/${token}`, { method: "GET" }),
          );
          if (metaRes.ok) {
            const json = await metaRes.json<{
              ok: boolean;
              data?: { projectName: string; ownerName: string; role: string };
            }>();
            if (json.ok && json.data) {
              const { pageTitle, description } = buildInviteMeta(json.data);
              const response = await renderIndexWithMeta(env, request, { pageTitle, description, ogImage: null });
              if (response) {
                await cache.put(cacheKey, response.clone());
                return response;
              }
            }
          }
        } catch {
          // Fall through to normal asset serving
        }
      }

      // Serve static assets; fall through to index.html for SPA routing
      const assetResponse = await env.ASSETS.fetch(request);
      if (assetResponse.ok) return assetResponse;

      return await env.ASSETS.fetch(new Request(new URL("/", request.url).toString(), request));
    } catch {
      return new Response("404 Not Found", { status: 404, headers: { "Content-Type": "text/plain" } });
    }
  },
};
