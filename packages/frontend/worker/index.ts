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

// Fetch the base index.html and inject <title> + OpenGraph/description meta so
// link-unfurlers (Slack, Discord, Twitter, iMessage) show a contextual preview
// instead of the static default. Returns null if the index asset is missing so
// the caller can fall through to normal asset serving.
async function renderIndexWithMeta(
  env: Env,
  request: Request,
  meta: { pageTitle: string; description: string | null; ogImage: string | null },
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);

      // Stripe webhook — forwarded to the auth worker via service binding
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

      // Inject OG metadata for share links
      const shareMatch = url.pathname.match(/^\/s\/([^/]+)\/([^/]+)$/);
      if (shareMatch) {
        const [, projectSlug, docId] = shareMatch;
        try {
          const cache = caches.default;
          const cacheKey = new Request(`https://share-meta.internal/${projectSlug}/${docId}`);
          const cached = await cache.match(cacheKey);
          if (cached) return cached;

          const metaRes = await env.API.fetch(
            new Request(`https://api/public/docs/${projectSlug}/${docId}`, { method: "GET" }),
          );
          if (metaRes.ok) {
            const json = await metaRes.json<{
              ok: boolean;
              data?: {
                doc: {
                  title: string;
                  display_title: string | null;
                  description: string | null;
                  image: string | null;
                  content: string;
                };
                project: { id: string; name: string };
              };
            }>();
            if (json.ok && json.data) {
              const { doc, project } = json.data;
              const docTitle = doc.display_title ?? doc.title;
              const pageTitle = `${docTitle} - ${project.name}`;
              const description = doc.description ?? extractFirstParagraph(doc.content);
              const ogImage = doc.image ? resolveImageUrl(doc.image, url, project.id) : null;

              const response = await renderIndexWithMeta(env, request, { pageTitle, description, ogImage });
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
