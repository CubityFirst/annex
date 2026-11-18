import { errorResponse, Errors, ProjectFeatures, ROLE_RANK, Session } from "./lib";
import { authenticate } from "./auth";
import { handleProjects } from "./routes/projects";
import { handleDocs } from "./routes/docs";
import { handleFolders } from "./routes/folders";
import { handleMembers } from "./routes/members";
import { handlePublic, handlePublicReport } from "./routes/public";
import { handleUserReport } from "./routes/reports";
import { handleFiles } from "./routes/files";
import { handleAi } from "./routes/ai";
import { handleInviteLinks, handleInvitePublic } from "./routes/inviteLinks";
import { handleDocShares } from "./routes/docShares";
import { handlePendingInvites } from "./routes/pendingInvites";
import { handleGraph, handlePublicGraph, handleGraphReindex, reindexStaleGraphs } from "./routes/graph";
import { handleProjectExport } from "./routes/export";
import { handleSearch, handlePublicSearch } from "./routes/search";
import { handlePublicApi } from "./routes/v1";
import { handleApiKeys } from "./routes/apiKeys";
import { handleOrganizations } from "./routes/organizations";
import { handleCustomDomain } from "./routes/customDomains";
import { handleTrash } from "./routes/trash";
import { handleUserByHandle } from "./routes/userHandles";
import { pruneDocRevisions } from "./lib/docOps";
import { purgeExpiredTrash } from "./lib/trash";
import { DocCollabRoom } from "./collab/DocCollabRoom";
import { resolveAvatar, parseVariant, avatarKey, deleteAllAvatarVariants } from "./avatar";
import { resolveAccess } from "./lib/access";
import type { IdentityService } from "./account/identity";
import { sweepSessions } from "./account/session";
import { syncIdentityDeletions } from "./lib/identityDeletions";

// Must match the hourly trigger in cloudflare.config.ts.
export const DELETION_SYNC_CRON = "23 * * * *";
import { handleAuthCallback, handleAuthExchange, handleAuthLogin, handleAuthLogout, handleDevQuickLogin } from "./routes/auth";
import { handleBillingCheckout, handleBillingPortal } from "./routes/billing";
import { handleStripeWebhook } from "./routes/stripeWebhook";
import { handleGetMe, handlePatchMe, handleUserProfile } from "./routes/me/me";
import { handleUpdateInkPrefs } from "./routes/me/update-ink-prefs";
import { handleUpdateReadingFont } from "./routes/me/update-reading-font";
import { handleUpdateTheme } from "./routes/me/update-theme";
import { handleUpdateBio } from "./routes/me/update-bio";
import { handleUpdateHandle } from "./routes/me/update-handle";

export { DocCollabRoom };

export interface Env {
  DB: D1Database;
  ASSETS: R2Bucket;
  DOC_COLLAB?: DurableObjectNamespace;
  // Annex-only HS256 secret for Annex's own session JWTs (no longer shared
  // with the identity service).
  JWT_SECRET: string;
  // Identity service (auth.cubityfir.st) RPC: account lookups, standing and
  // deletions. Optional so unit tests and a local stack without the identity
  // worker fall back to the users mirror.
  IDENTITY?: IdentityService;
  // The identity worker's HTTP surface (cubityfirst-auth default export) for
  // server-side OIDC requests. Required in production: a fetch() to
  // auth.cubityfir.st from a Worker on the same zone never reaches it.
  IDENTITY_OIDC?: Fetcher;
  // OIDC client settings (see routes/auth.ts). OIDC_CLIENT_SECRET is a secret;
  // the rest are vars. Redirect URIs default to APP_ORIGIN/api/auth/callback
  // and APP_ORIGIN (no trailing slash).
  OIDC_ISSUER?: string;
  OIDC_CLIENT_ID?: string;
  OIDC_CLIENT_SECRET?: string;
  OIDC_REDIRECT_URI?: string;
  OIDC_POST_LOGOUT_REDIRECT_URI?: string;
  APP_ORIGIN?: string;
  // "true" (with a localhost APP_ORIGIN) enables POST /dev/quick-login.
  DEV_QUICK_LOGIN?: string;
  // Annex Ink billing (routes/billing.ts, routes/stripeWebhook.ts). The keys
  // are secrets; STRIPE_INK_PRICE_ID is a var.
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_INK_PRICE_ID?: string;
  OPENAI_API_KEY?: string;
  // Cloudflare-for-SaaS custom domains (see routes/customDomains.ts). Optional:
  // when unset, the custom-domain endpoints report "not configured" instead of
  // calling Cloudflare. CF_API_TOKEN is a secret; the others are vars.
  CF_API_TOKEN?: string;
  CF_ZONE_ID?: string;
  CUSTOM_DOMAIN_CNAME_TARGET?: string;
  // R2 S3-API credentials for presigning direct video stream URLs (see
  // lib/r2Presign.ts). Optional: when unset, video falls back to the in-Worker
  // token streaming route. ACCESS_KEY_ID + SECRET_ACCESS_KEY are secrets;
  // ACCOUNT_ID + BUCKET_NAME are vars.
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_ACCOUNT_ID?: string;
  R2_BUCKET_NAME?: string;
  RATE_LIMITER_INVITE_LOOKUP: { limit(opts: { key: string }): Promise<{ success: boolean }> };
  // Per-API-key limiter for the public /v1 surface (keyed by `apikey:<id>`).
  RATE_LIMITER_API?: { limit(opts: { key: string }): Promise<{ success: boolean }> };
  // Per-IP limiter for the public site "Report Site" endpoint. Optional so
  // local dev / unit tests without the binding fail open.
  RATE_LIMITER_REPORT?: { limit(opts: { key: string }): Promise<{ success: boolean }> };
  FLAGS?: { getBooleanValue(flag: string, defaultValue: boolean, ctx?: Record<string, string>): Promise<boolean> };
}

export default {
  // Daily cron (see cloudflare.config.ts triggers): revision retention. Keeps each
  // doc's newest revision unconditionally; see pruneDocRevisions.
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // Hourly: accounts deleted on auth.cubityfir.st (lib/identityDeletions.ts).
    if (controller.cron === DELETION_SYNC_CRON) {
      ctx.waitUntil(
        syncIdentityDeletions(env)
          .then(r => { if (r.recorded || r.processed || r.failed) console.log(`[deletion-sync] recorded ${r.recorded}, processed ${r.processed}, failed ${r.failed}`); })
          .catch(err => console.error("[deletion-sync] run failed:", err)),
      );
      return;
    }
    ctx.waitUntil(
      pruneDocRevisions(env)
        .then(n => { if (n > 0) console.log(`[retention] pruned ${n} doc revisions`); })
        .catch(err => console.error("[retention] prune failed:", err)),
    );
    // Recycle-bin retention: entries older than TRASH_RETENTION_DAYS.
    ctx.waitUntil(
      purgeExpiredTrash(env)
        .then(n => { if (n > 0) console.log(`[retention] purged ${n} recycle bin entries`); })
        .catch(err => console.error("[retention] trash purge failed:", err)),
    );
    // Rebuild stale doc-link graphs (bounded) - public graph views never do.
    ctx.waitUntil(
      reindexStaleGraphs(env)
        .then(n => { if (n > 0) console.log(`[graph] reindexed ${n} stale site graphs`); })
        .catch(err => console.error("[graph] stale reindex failed:", err)),
    );
    // Dead Annex sessions, abandoned sign-in handoffs, old webhook markers.
    ctx.waitUntil(
      sweepSessions(env.DB).catch(err => console.error("[sessions] sweep failed:", err)),
    );
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // WebSocket upgrade for real-time collab - must be handled before addCorsHeaders
    // because wrapping a 101 response loses the webSocket property.
    const collabMatch = url.pathname.match(/^\/docs\/([^/]+)\/collab$/);
    if (collabMatch && request.headers.get("Upgrade") === "websocket") {
      return handleCollabUpgrade(request, url, env, collabMatch[1]);
    }

    let response: Response;

    try {
      // Public, API-key-authenticated surface. Handled first and in isolation:
      // it uses its OWN key-only auth (never the shared JWT authenticate()), so
      // a scoped key can never fall through to any other route below.
      if (url.pathname === "/v1" || url.pathname.startsWith("/v1/")) {
        return addCorsHeaders(await handlePublicApi(request, env, url));
      }

      // Sign in with auth.cubityfir.st (routes/auth.ts). login/callback are
      // top-level browser navigations (redirects, no CORS); exchange/logout
      // are called by the SPA.
      if (url.pathname === "/auth/login" && request.method === "GET") return await handleAuthLogin(request, env, url);
      if (url.pathname === "/auth/callback" && request.method === "GET") return await handleAuthCallback(request, env, url);
      if (url.pathname === "/auth/exchange" && request.method === "POST") return addCorsHeaders(await handleAuthExchange(request, env));
      if (url.pathname === "/auth/logout" && request.method === "POST") return addCorsHeaders(await handleAuthLogout(request, env));
      if (url.pathname === "/dev/quick-login" && request.method === "POST") return addCorsHeaders(await handleDevQuickLogin(request, env));

      // Stripe webhook - public, signature-verified (routes/stripeWebhook.ts).
      // The frontend worker forwards docs.cubityfir.st/stripe/webhook here
      // verbatim; the raw body must reach the handler untouched.
      if (url.pathname === "/stripe/webhook" && request.method === "POST") {
        return await handleStripeWebhook(request, env);
      }

      // /billing/* - Stripe Checkout and Customer Portal sessions.
      if (url.pathname === "/billing/checkout" && request.method === "POST") {
        const session = await getSession(request, env);
        if (session instanceof Response) return session;
        return addCorsHeaders(await handleBillingCheckout(env, session));
      }
      if (url.pathname === "/billing/portal" && request.method === "POST") {
        const session = await getSession(request, env);
        if (session instanceof Response) return session;
        return addCorsHeaders(await handleBillingPortal(env, session));
      }

      // GET /me - the signed-in user: identity facts from the users mirror,
      // Annex prefs/plan from the session (routes/me/me.ts).
      if (url.pathname === "/me" && request.method === "GET") {
        const session = await getSession(request, env);
        if (session instanceof Response) return session;
        return addCorsHeaders(await handleGetMe(env, session));
      }

      // PATCH /me - timezone. The name is managed on auth.cubityfir.st.
      if (url.pathname === "/me" && request.method === "PATCH") {
        const session = await getSession(request, env);
        if (session instanceof Response) return session;
        return addCorsHeaders(await handlePatchMe(request, env, session));
      }

      // Annex preferences (routes/me/*). Each handler authenticates itself.
      if (request.method === "PATCH") {
        if (url.pathname === "/me/ink-prefs") return addCorsHeaders(await handleUpdateInkPrefs(request, env));
        if (url.pathname === "/me/reading-font") return addCorsHeaders(await handleUpdateReadingFont(request, env));
        if (url.pathname === "/me/bio") return addCorsHeaders(await handleUpdateBio(request, env));
        if (url.pathname === "/me/handle") return addCorsHeaders(await handleUpdateHandle(request, env));
        // Site theme: admins always; other users need the custom-theming flag.
        if (url.pathname === "/me/theme") {
          const session = await getSession(request, env);
          if (session instanceof Response) return session;
          if (!session.isAdmin) {
            const flagEnabled = env.FLAGS
              ? await env.FLAGS.getBooleanValue("custom-theming", false, { userId: session.userId })
              : true;
            if (!flagEnabled) return addCorsHeaders(errorResponse(Errors.FORBIDDEN));
          }
          return addCorsHeaders(await handleUpdateTheme(request, env));
        }
      }

      // GET /me/favourite-sites/search?q= - find published sites by name for
      // the picker in user settings. Excludes ones the user has already
      // favourited so the list shows what's *addable*. Capped to 20 results.
      if (url.pathname === "/me/favourite-sites/search" && request.method === "GET") {
        const session = await getSession(request, env);
        if (session instanceof Response) return session;
        const q = (url.searchParams.get("q") ?? "").trim();
        if (q.length < 1) return addCorsHeaders(Response.json({ ok: true, data: [] }));
        const like = `%${q.replace(/[\\%_]/g, ch => "\\" + ch)}%`;
        const rows = await env.DB.prepare(
          `SELECT p.id, p.name, p.vanity_slug, p.logo_square_updated_at, p.logo_wide_updated_at
           FROM projects p
           WHERE p.published_at IS NOT NULL
             AND LOWER(p.name) LIKE LOWER(?) ESCAPE '\\'
             AND NOT EXISTS (
               SELECT 1 FROM user_favourite_projects ufp
               WHERE ufp.user_id = ? AND ufp.project_id = p.id
             )
           ORDER BY p.name ASC
           LIMIT 20`,
        ).bind(like, session.userId).all<{ id: string; name: string; vanity_slug: string | null; logo_square_updated_at: string | null; logo_wide_updated_at: string | null }>();
        return addCorsHeaders(Response.json({
          ok: true,
          data: rows.results.map(r => ({
            id: r.id,
            name: r.name,
            vanitySlug: r.vanity_slug,
            logoSquareUpdatedAt: r.logo_square_updated_at,
            logoWideUpdatedAt: r.logo_wide_updated_at,
          })),
        }));
      }

      // GET /me/favourite-sites - list current user's favourited published projects
      if (url.pathname === "/me/favourite-sites" && request.method === "GET") {
        const session = await getSession(request, env);
        if (session instanceof Response) return session;
        const rows = await env.DB.prepare(
          `SELECT p.id, p.name, p.vanity_slug, p.logo_square_updated_at, p.logo_wide_updated_at, ufp.note, ufp.created_at
           FROM user_favourite_projects ufp
           JOIN projects p ON p.id = ufp.project_id
           WHERE ufp.user_id = ? AND p.published_at IS NOT NULL
           ORDER BY ufp.created_at DESC`,
        ).bind(session.userId).all<{ id: string; name: string; vanity_slug: string | null; logo_square_updated_at: string | null; logo_wide_updated_at: string | null; note: string | null; created_at: number }>();
        return addCorsHeaders(Response.json({
          ok: true,
          data: rows.results.map(r => ({
            id: r.id,
            name: r.name,
            vanitySlug: r.vanity_slug,
            logoSquareUpdatedAt: r.logo_square_updated_at,
            logoWideUpdatedAt: r.logo_wide_updated_at,
            note: r.note,
          })),
        }));
      }

      // POST /me/favourite-sites/:projectId - add a favourite (idempotent)
      // DELETE /me/favourite-sites/:projectId - remove
      const favSiteMatch = url.pathname.match(/^\/me\/favourite-sites\/([^/]+)$/);
      if (favSiteMatch) {
        const session = await getSession(request, env);
        if (session instanceof Response) return session;
        const projectId = favSiteMatch[1];
        if (request.method === "POST") {
          const project = await env.DB.prepare(
            "SELECT id FROM projects WHERE id = ? AND published_at IS NOT NULL",
          ).bind(projectId).first<{ id: string }>();
          if (!project) return addCorsHeaders(errorResponse(Errors.NOT_FOUND));
          // Cap at 3. Count first; reject only if the user is at the cap AND
          // this project isn't already in their list (so re-POST of an existing
          // favourite stays idempotent).
          const countRow = await env.DB.prepare(
            // Count only what GET /me/favourite-sites lists (existing, published
            // sites) so orphaned/unpublished rows the user can't see or remove
            // don't hold them at the cap.
            `SELECT COUNT(*) as n, SUM(CASE WHEN ufp.project_id = ? THEN 1 ELSE 0 END) as has
             FROM user_favourite_projects ufp
             JOIN projects p ON p.id = ufp.project_id
             WHERE ufp.user_id = ? AND p.published_at IS NOT NULL`,
          ).bind(projectId, session.userId).first<{ n: number; has: number }>();
          if (countRow && countRow.has === 0 && countRow.n >= 3) {
            return addCorsHeaders(errorResponse(Errors.CONFLICT));
          }
          await env.DB.prepare(
            "INSERT OR IGNORE INTO user_favourite_projects (user_id, project_id, created_at) VALUES (?, ?, ?)",
          ).bind(session.userId, projectId, Date.now()).run();
          return addCorsHeaders(Response.json({ ok: true, data: { favourited: true } }));
        }
        if (request.method === "DELETE") {
          await env.DB.prepare(
            "DELETE FROM user_favourite_projects WHERE user_id = ? AND project_id = ?",
          ).bind(session.userId, projectId).run();
          return addCorsHeaders(Response.json({ ok: true, data: { favourited: false } }));
        }
        // PATCH - update the per-favourite note. Empty/missing string clears it.
        // 140-char cap to keep it a short justification, not a bio.
        if (request.method === "PATCH") {
          const body = await request.json<{ note?: string | null }>().catch(() => ({} as { note?: string | null }));
          const raw = typeof body.note === "string" ? body.note.trim() : "";
          if (raw.length > 140) return addCorsHeaders(errorResponse(Errors.BAD_REQUEST));
          const note = raw.length === 0 ? null : raw;
          const res = await env.DB.prepare(
            "UPDATE user_favourite_projects SET note = ? WHERE user_id = ? AND project_id = ?",
          ).bind(note, session.userId, projectId).run();
          if (!res.meta.changes) return addCorsHeaders(errorResponse(Errors.NOT_FOUND));
          return addCorsHeaders(Response.json({ ok: true, data: { note } }));
        }
      }

      // GET /avatar/:userId - public, serve avatar from R2.
      // ?variant=light|dark (default dark). light falls back to dark; a legacy
      // avatars/{id} object is migrated to -dark on first fetch (see avatar.ts).
      if (url.pathname.startsWith("/avatar/") && request.method === "GET") {
        const userId = url.pathname.slice("/avatar/".length);
        if (!userId) return addCorsHeaders(errorResponse(Errors.NOT_FOUND));
        const variant = parseVariant(url.searchParams.get("variant"));
        const resolved = await resolveAvatar(env.ASSETS, userId, variant);
        if (!resolved) return new Response(null, { status: 404 });
        return new Response(resolved.body, {
          status: 200,
          headers: {
            "Content-Type": resolved.contentType,
            "Cache-Control": "public, max-age=300",
            "X-Content-Type-Options": "nosniff",
            ...corsHeaders(),
          },
        });
      }

      // POST /avatar - authenticated, upload avatar image
      if (url.pathname === "/avatar" && request.method === "POST") {
        const session = await getSession(request, env);
        if (session instanceof Response) return session;
        const contentType = request.headers.get("Content-Type") ?? "";
        if (!contentType.includes("multipart/form-data")) return addCorsHeaders(errorResponse(Errors.BAD_REQUEST));
        const form = await request.formData();
        const file = form.get("file") as File | null;
        if (!file) return addCorsHeaders(errorResponse(Errors.BAD_REQUEST));
        const allowed = ["image/jpeg", "image/png", "image/webp", "image/gif"];
        if (!allowed.includes(file.type)) {
          return addCorsHeaders(Response.json({ ok: false, error: "Invalid file type. Allowed: JPEG, PNG, WebP, GIF." }, { status: 400 }));
        }
        if (file.size > 5 * 1024 * 1024) {
          return addCorsHeaders(Response.json({ ok: false, error: "File too large. Maximum size is 5MB." }, { status: 400 }));
        }
        const variant = parseVariant(url.searchParams.get("variant"));
        await env.ASSETS.put(avatarKey(session.userId, variant), await file.arrayBuffer(), {
          httpMetadata: { contentType: file.type },
        });
        // Drop any never-fetched legacy object so it can't be orphaned now that
        // the user has a variant-keyed avatar.
        await env.ASSETS.delete(`avatars/${session.userId}`);
        return addCorsHeaders(Response.json({ ok: true }));
      }

      // DELETE /avatar - authenticated. ?variant=light|dark removes only that
      // slot; no variant removes every avatar object for the user.
      if (url.pathname === "/avatar" && request.method === "DELETE") {
        const session = await getSession(request, env);
        if (session instanceof Response) return session;
        const rawVariant = url.searchParams.get("variant");
        if (rawVariant === "light" || rawVariant === "dark") {
          await env.ASSETS.delete(avatarKey(session.userId, rawVariant));
        } else {
          await deleteAllAvatarVariants(env.ASSETS, session.userId);
        }
        return addCorsHeaders(Response.json({ ok: true }));
      }

      // GET /users/by-handle/:handle - authenticated, resolves a /@<handle>
      // profile link to a user id (routes/userHandles.ts).
      const userHandleMatch = url.pathname.match(/^\/users\/by-handle\/([^/]+)$/);
      if (userHandleMatch && request.method === "GET") {
        const session = await getSession(request, env);
        if (session instanceof Response) return session;
        return addCorsHeaders(await handleUserByHandle(env, userHandleMatch[1]));
      }

      // POST /users/:userId/report - authenticated abuse report from the
      // profile card (routes/reports.ts).
      const userReportMatch = url.pathname.match(/^\/users\/([^/]+)\/report$/);
      if (userReportMatch && request.method === "POST") {
        const session = await getSession(request, env);
        if (session instanceof Response) return session;
        return addCorsHeaders(await handleUserReport(request, env, session, decodeURIComponent(userReportMatch[1])));
      }

      // GET /users/:userId - authenticated, returns user profile + shared projects
      const userProfileMatch = url.pathname.match(/^\/users\/([^/]+)$/);
      if (userProfileMatch && request.method === "GET") {
        const session = await getSession(request, env);
        if (session instanceof Response) return session;
        return addCorsHeaders(await handleUserProfile(env, session, decodeURIComponent(userProfileMatch[1])));
      }

      // Pending invites
      if (url.pathname.startsWith("/pending-invites")) {
        const session = await getSession(request, env);
        if (session instanceof Response) return session;
        response = await handlePendingInvites(request, env, session, url);
      } else if (/^\/public\/projects\/[^/]+\/graph$/.test(url.pathname)) {
        response = await handlePublicGraph(env, url);
      } else if (url.pathname === "/public/search") {
        response = await handlePublicSearch(request, env, url);
      } else if (request.method === "POST" && /^\/public\/projects\/[^/]+\/report$/.test(url.pathname)) {
        // The rest of /public is GET-only (handlePublic rejects non-GET);
        // report filing is its own POST handler with its own rate limiter.
        response = await handlePublicReport(request, env, url);
      } else if (url.pathname.startsWith("/public")) {
        response = await handlePublic(request, env, url);
      } else if (url.pathname.startsWith("/invites/")) {
        response = await handleInvitePublic(request, env, url);
      } else if (url.pathname.startsWith("/organizations")) {
        const session = await getSession(request, env);
        if (session instanceof Response) return session;
        response = await handleOrganizations(request, env, session, url);
      } else if (/^\/projects\/[^/]+\/members/.test(url.pathname)) {
        const session = await getSession(request, env);
        if (session instanceof Response) return session;
        response = await handleMembers(request, env, session, url);
      } else if (/^\/projects\/[^/]+\/api-keys/.test(url.pathname)) {
        const session = await getSession(request, env);
        if (session instanceof Response) return session;
        response = await handleApiKeys(request, env, session, url);
      } else if (/^\/projects\/[^/]+\/domain(\/refresh)?$/.test(url.pathname)) {
        const session = await getSession(request, env);
        if (session instanceof Response) return session;
        response = await handleCustomDomain(request, env, session, url);
      } else if (/^\/projects\/[^/]+\/invite-links/.test(url.pathname)) {
        const session = await getSession(request, env);
        if (session instanceof Response) return session;
        response = await handleInviteLinks(request, env, session, url);
      } else if (/^\/projects\/[^/]+\/folder-shares/.test(url.pathname)) {
        const session = await getSession(request, env);
        if (session instanceof Response) return session;
        response = await handleDocShares(request, env, session, url);
      } else if (/^\/projects\/[^/]+\/trash(\/|$)/.test(url.pathname)) {
        const session = await getSession(request, env);
        if (session instanceof Response) return session;
        response = await handleTrash(request, env, session, url);
      } else if (/^\/projects\/[^/]+\/export$/.test(url.pathname)) {
        const session = await getSession(request, env);
        if (session instanceof Response) return session;
        response = await handleProjectExport(request, env, session, url);
      } else if (/^\/projects\/[^/]+\/graph\/reindex$/.test(url.pathname)) {
        const session = await getSession(request, env);
        if (session instanceof Response) return session;
        response = await handleGraphReindex(request, env, session, url);
      } else if (/^\/projects\/[^/]+\/graph$/.test(url.pathname)) {
        const session = await getSession(request, env);
        if (session instanceof Response) return session;
        response = await handleGraph(request, env, session, url);
      } else if (url.pathname.startsWith("/projects")) {
        const session = await getSession(request, env);
        if (session instanceof Response) return session;
        response = await handleProjects(request, env, session, url);
      } else if (/^\/docs\/[^/]+\/shares/.test(url.pathname)) {
        const session = await getSession(request, env);
        if (session instanceof Response) return session;
        response = await handleDocShares(request, env, session, url);
      } else if (url.pathname.startsWith("/docs")) {
        const session = await getSession(request, env);
        if (session instanceof Response) return session;
        response = await handleDocs(request, env, session, url);
      } else if (url.pathname.startsWith("/folders")) {
        const session = await getSession(request, env);
        if (session instanceof Response) return session;
        response = await handleFolders(request, env, session, url);
      } else if (url.pathname.startsWith("/files")) {
        const result = await authenticate(request, env);
        // /files allows anonymous access for public files (`result === null`).
        // A 403 from the auth worker (disabled/suspended account) must still
        // propagate so the client gets the real reason instead of public access.
        if (result instanceof Response) {
          response = result;
        } else {
          response = await handleFiles(request, env, result, url);
        }
      } else if (url.pathname === "/search") {
        const session = await getSession(request, env);
        if (session instanceof Response) return session;
        response = await handleSearch(request, env, session, url);
      } else if (url.pathname.startsWith("/ai")) {
        const session = await getSession(request, env);
        if (session instanceof Response) return session;
        response = await handleAi(request, env, session, url);
      } else {
        response = errorResponse(Errors.NOT_FOUND);
      }
    } catch (err) {
      console.error(err);
      response = errorResponse(Errors.INTERNAL);
    }

    return addCorsHeaders(response);
  },
};

async function handleCollabUpgrade(request: Request, url: URL, env: Env, docId: string): Promise<Response> {
  if (!env.DOC_COLLAB) return new Response("Not available", { status: 503 });

  // Global killswitch for realtime collab, on top of the per-project REALTIME
  // feature bit checked below. Lets ops stop new DocCollabRoom connections during
  // an incident (the DO holds live sockets + persists to R2) without a redeploy.
  // Checked before auth/DB work so a kill takes effect with zero load. Defaults
  // to enabled when the flag/binding is unavailable (local dev / flag outage).
  // Note: this refuses NEW upgrades only - already-open sockets stay until they
  // reconnect; use the /collab/reset endpoint to force-drop a specific room.
  const collabEnabled = env.FLAGS ? await env.FLAGS.getBooleanValue("realtime-collab", true) : true;
  if (!collabEnabled) return new Response("Realtime collaboration is temporarily disabled", { status: 503 });

  // Token arrives as a query param (browsers can't set headers on WS).
  // Re-wrap it as a Bearer header so authenticate() handles it the same way
  // every other route does.
  const token = url.searchParams.get("token");
  if (!token) return new Response("Unauthorized", { status: 401 });
  const authReq = new Request("https://placeholder/", {
    headers: { Authorization: `Bearer ${token}` },
  });
  const session = await authenticate(authReq, env);
  if (session === null) return new Response("Unauthorized", { status: 401 });
  if (session instanceof Response) return new Response("Forbidden", { status: 403 });

  const docRow = await env.DB.prepare("SELECT project_id FROM docs WHERE id = ?")
    .bind(docId).first<{ project_id: string }>();
  if (!docRow) return new Response("Not found", { status: 404 });

  const projectRow = await env.DB.prepare("SELECT features FROM projects WHERE id = ?")
    .bind(docRow.project_id).first<{ features: number }>();
  if (!projectRow || !(projectRow.features & ProjectFeatures.REALTIME)) {
    return new Response("Forbidden", { status: 403 });
  }

  // Effective role (direct OR via the site's org) gates realtime co-editing,
  // and - unlike the old query - requires an ACCEPTED membership.
  const caller = await resolveAccess(env.DB, docRow.project_id, session.userId);
  if (!caller || ROLE_RANK[caller.role] < ROLE_RANK["editor"]) {
    return new Response("Forbidden", { status: 403 });
  }

  const id = env.DOC_COLLAB.idFromName(`${docRow.project_id}:${docId}`);
  const stub = env.DOC_COLLAB.get(id);

  // The room trusts these identity headers, so they must REPLACE any
  // client-supplied copies: a record spread of request.headers yields
  // lowercase keys that the Headers constructor would append alongside ours
  // ("attacker, real"). The name is URI-encoded so non-Latin-1 names
  // (emoji, CJK) don't make Headers throw; the room decodes it.
  const headers = new Headers(request.headers);
  headers.set("X-User-Id", session.userId);
  headers.set("X-User-Name", encodeURIComponent(caller.name));
  headers.set("X-Project-Id", docRow.project_id);
  headers.set("X-Doc-Id", docId);
  if (session.sid) headers.set("X-Session-Id", session.sid);
  else headers.delete("X-Session-Id");
  const upstream = new Request(request.url, { method: request.method, headers });
  return stub.fetch(upstream);
}

async function getSession(request: Request, env: Env): Promise<Session | Response> {
  const result = await authenticate(request, env);
  if (result === null) return addCorsHeaders(errorResponse(Errors.UNAUTHORIZED));
  if (result instanceof Response) return addCorsHeaders(result);
  return result;
}

function corsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "https://docs.cubityfir.st",
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function addCorsHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(corsHeaders())) headers.set(k, v);
  return new Response(response.body, { status: response.status, headers });
}
