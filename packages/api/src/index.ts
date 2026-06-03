import { errorResponse, Errors, ProjectFeatures, ROLE_RANK, Session } from "./lib";
import { authenticate } from "./auth";
import { handleProjects } from "./routes/projects";
import { handleDocs } from "./routes/docs";
import { handleFolders } from "./routes/folders";
import { handleMembers } from "./routes/members";
import { handlePublic } from "./routes/public";
import { handleFiles } from "./routes/files";
import { handleAi } from "./routes/ai";
import { handleInviteLinks, handleInvitePublic } from "./routes/inviteLinks";
import { handleDocShares } from "./routes/docShares";
import { handlePendingInvites } from "./routes/pendingInvites";
import { handleGraph, handlePublicGraph, handleGraphReindex } from "./routes/graph";
import { handleProjectExport } from "./routes/export";
import { handleSearch, handlePublicSearch } from "./routes/search";
import { handlePublicApi } from "./routes/v1";
import { handleApiKeys } from "./routes/apiKeys";
import { DocCollabRoom } from "./collab/DocCollabRoom";
import { resolvePersonalPlan } from "../../auth/src/plan";
import { resolveAvatar, parseVariant, avatarKey, deleteAllAvatarVariants } from "./avatar";

export { DocCollabRoom };

export interface Env {
  DB: D1Database;
  AUTH_DB: D1Database; // Read-only: users + sessions, used for inline JWT verify
  ASSETS: R2Bucket;
  AUTH: Fetcher; // Service binding to cubedocs-auth (mutating routes only)
  DOC_COLLAB?: DurableObjectNamespace;
  JWT_SECRET: string;
  OPENAI_API_KEY?: string;
  RATE_LIMITER_INVITE_LOOKUP: { limit(opts: { key: string }): Promise<{ success: boolean }> };
  // Per-API-key limiter for the public /v1 surface (keyed by `apikey:<id>`).
  RATE_LIMITER_API?: { limit(opts: { key: string }): Promise<{ success: boolean }> };
  FLAGS?: { getBooleanValue(flag: string, defaultValue: boolean, ctx?: Record<string, string>): Promise<boolean> };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // WebSocket upgrade for real-time collab — must be handled before addCorsHeaders
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

      // Proxy auth routes to the auth worker
      if (
        url.pathname === "/register" ||
        url.pathname === "/login" ||
        url.pathname === "/force-change-password" ||
        url.pathname === "/verify-email" ||
        url.pathname === "/verify-email/resend" ||
        url.pathname === "/admin/handoff/start" ||
        url.pathname === "/dev/quick-login"
      ) {
        return env.AUTH.fetch(new Request(`https://auth${url.pathname}`, request));
      }

      // TOTP management routes — authenticated, proxied to auth worker with userId injected
      if (url.pathname.startsWith("/me/totp")) {
        const session = await getSession(request, env);
        if (session instanceof Response) return session;
        const totpPath = url.pathname.replace("/me/totp", "/totp");
        const body = request.method !== "GET" ? await request.json<Record<string, unknown>>() : {};
        const authHeader = request.headers.get("Authorization");
        const authRes = await env.AUTH.fetch(`https://auth${totpPath}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(authHeader ? { Authorization: authHeader } : {}) },
          body: JSON.stringify(body),
        });
        return addCorsHeaders(authRes);
      }

      // WebAuthn management routes — authenticated, proxied to auth worker with userId injected
      if (url.pathname.startsWith("/me/webauthn")) {
        const session = await getSession(request, env);
        if (session instanceof Response) return session;
        const webauthnPath = url.pathname.replace("/me/webauthn", "/webauthn");
        const body = await request.json<Record<string, unknown>>();
        const authHeader = request.headers.get("Authorization");
        const authRes = await env.AUTH.fetch(`https://auth${webauthnPath}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(authHeader ? { Authorization: authHeader } : {}) },
          body: JSON.stringify({ ...body, userId: session.userId }),
        });
        return addCorsHeaders(authRes);
      }

      // WebAuthn login ceremony — unauthenticated, forwarded directly
      if (url.pathname.startsWith("/webauthn/auth")) {
        return addCorsHeaders(
          await env.AUTH.fetch(new Request(`https://auth${url.pathname}`, request)),
        );
      }

      // /me/sessions/* — authenticated, proxied to auth worker.
      // GET   /me/sessions          → list user's active sessions
      // POST  /me/sessions/revoke   → revoke a specific session by id
      // POST  /me/sessions/revoke-others → revoke all but the current
      // POST  /me/sessions/logout   → revoke the current session (proper logout)
      if (url.pathname === "/me/sessions" && request.method === "GET") {
        const session = await getSession(request, env);
        if (session instanceof Response) return session;
        const authHeader = request.headers.get("Authorization");
        const authRes = await env.AUTH.fetch("https://auth/sessions/list", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(authHeader ? { Authorization: authHeader } : {}) },
          body: "{}",
        });
        return addCorsHeaders(authRes);
      }
      if (url.pathname === "/me/sessions/revoke" && request.method === "POST") {
        const session = await getSession(request, env);
        if (session instanceof Response) return session;
        const body = await request.json<Record<string, unknown>>();
        const authHeader = request.headers.get("Authorization");
        const authRes = await env.AUTH.fetch("https://auth/sessions/revoke", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(authHeader ? { Authorization: authHeader } : {}) },
          body: JSON.stringify(body),
        });
        return addCorsHeaders(authRes);
      }
      if (url.pathname === "/me/sessions/revoke-others" && request.method === "POST") {
        const session = await getSession(request, env);
        if (session instanceof Response) return session;
        const authHeader = request.headers.get("Authorization");
        const authRes = await env.AUTH.fetch("https://auth/sessions/revoke-others", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(authHeader ? { Authorization: authHeader } : {}) },
          body: "{}",
        });
        return addCorsHeaders(authRes);
      }
      if (url.pathname === "/me/sessions/logout" && request.method === "POST") {
        const session = await getSession(request, env);
        if (session instanceof Response) return session;
        const authHeader = request.headers.get("Authorization");
        const authRes = await env.AUTH.fetch("https://auth/sessions/logout", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(authHeader ? { Authorization: authHeader } : {}) },
          body: "{}",
        });
        return addCorsHeaders(authRes);
      }

      // /billing/* — authenticated, proxied to auth worker (Stripe Checkout
      // and Customer Portal session creation). Public Stripe webhook is
      // hit directly on the auth worker, not through here.
      if (url.pathname === "/billing/checkout" && request.method === "POST") {
        const session = await getSession(request, env);
        if (session instanceof Response) return session;
        const authHeader = request.headers.get("Authorization");
        const authRes = await env.AUTH.fetch("https://auth/billing/checkout", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(authHeader ? { Authorization: authHeader } : {}) },
          body: "{}",
        });
        return addCorsHeaders(authRes);
      }
      if (url.pathname === "/billing/portal" && request.method === "POST") {
        const session = await getSession(request, env);
        if (session instanceof Response) return session;
        const authHeader = request.headers.get("Authorization");
        const authRes = await env.AUTH.fetch("https://auth/billing/portal", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(authHeader ? { Authorization: authHeader } : {}) },
          body: "{}",
        });
        return addCorsHeaders(authRes);
      }

      // PATCH /me/password — change password
      if (url.pathname === "/me/password" && request.method === "PATCH") {
        const session = await getSession(request, env);
        if (session instanceof Response) return session;
        const body = await request.json<Record<string, unknown>>();
        const authHeader = request.headers.get("Authorization");
        const authRes = await env.AUTH.fetch("https://auth/change-password", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(authHeader ? { Authorization: authHeader } : {}) },
          body: JSON.stringify(body),
        });
        return addCorsHeaders(authRes);
      }

      // GET /me — returns authenticated user's name and email
      if (url.pathname === "/me" && request.method === "GET") {
        const session = await getSession(request, env);
        if (session instanceof Response) return session;
        const authHeader = request.headers.get("Authorization");
        const [lookupRes, customThemingEnabled] = await Promise.all([
          env.AUTH.fetch("https://auth/lookup-by-id", {
            method: "POST",
            headers: { "Content-Type": "application/json", ...(authHeader ? { Authorization: authHeader } : {}) },
            body: JSON.stringify({ userId: session.userId }),
          }),
          env.FLAGS
            ? env.FLAGS.getBooleanValue("custom-theming", false, { userId: session.userId })
            : Promise.resolve(true),
        ]);
        if (!lookupRes.ok) return addCorsHeaders(errorResponse(Errors.INTERNAL));
        const data = await lookupRes.json<{ ok: boolean; data?: { name: string; email: string; emailVerified: boolean; emailVerificationEnabled: boolean; timezone: string | null; bio: string | null } }>();
        if (!data.ok || !data.data) return addCorsHeaders(errorResponse(Errors.INTERNAL));
        return addCorsHeaders(Response.json({
          ok: true,
          data: {
            name: data.data.name,
            email: data.data.email,
            emailVerified: data.data.emailVerified,
            emailVerificationEnabled: data.data.emailVerificationEnabled,
            userId: session.userId,
            timezone: data.data.timezone,
            bio: data.data.bio,
            personalPlan: session.personalPlan ?? "free",
            personalPlanSince: session.personalPlanSince ?? null,
            personalPlanStatus: session.personalPlanStatus ?? null,
            personalPlanCancelAt: session.personalPlanCancelAt ?? null,
            personalPlanStyle: session.personalPlanStyle ?? null,
            personalPresenceColor: session.personalPresenceColor ?? null,
            personalCritSparkles: session.personalCritSparkles ?? true,
            readingFont: session.readingFont ?? null,
            editingFont: session.editingFont ?? null,
            uiFont: session.uiFont ?? null,
            isAdmin: session.isAdmin ?? false,
            themeMode: session.themeMode ?? null,
            themeCustomColor: session.themeCustomColor ?? null,
            customThemingEnabled,
          },
        }));
      }

      // PATCH /me — update authenticated user's name and/or timezone
      if (url.pathname === "/me" && request.method === "PATCH") {
        const session = await getSession(request, env);
        if (session instanceof Response) return session;
        const body = await request.json<{ name?: string; timezone?: string | null }>();
        const authHeader = request.headers.get("Authorization");
        const responseData: { name?: string; timezone?: string | null } = {};

        if (body.name !== undefined) {
          if (!body.name?.trim()) return addCorsHeaders(errorResponse(Errors.BAD_REQUEST));
          const updateRes = await env.AUTH.fetch("https://auth/update-name", {
            method: "POST",
            headers: { "Content-Type": "application/json", ...(authHeader ? { Authorization: authHeader } : {}) },
            body: JSON.stringify({ name: body.name.trim() }),
          });
          if (!updateRes.ok) return addCorsHeaders(errorResponse(Errors.INTERNAL));
          const trimmedName = body.name.trim();
          await env.DB.prepare("UPDATE project_members SET name = ? WHERE user_id = ?")
            .bind(trimmedName, session.userId).run();
          responseData.name = trimmedName;
        }

        if ("timezone" in body) {
          const updateRes = await env.AUTH.fetch("https://auth/update-timezone", {
            method: "POST",
            headers: { "Content-Type": "application/json", ...(authHeader ? { Authorization: authHeader } : {}) },
            body: JSON.stringify({ timezone: body.timezone ?? null }),
          });
          if (!updateRes.ok) return addCorsHeaders(updateRes.status === 400 ? errorResponse(Errors.BAD_REQUEST) : errorResponse(Errors.INTERNAL));
          responseData.timezone = body.timezone ?? null;
        }

        if (!responseData.name && !("timezone" in body)) return addCorsHeaders(errorResponse(Errors.BAD_REQUEST));
        return addCorsHeaders(Response.json({ ok: true, data: responseData }));
      }

      // PATCH /me/ink-prefs — update Ink supporter cosmetic prefs (ring style + presence colour)
      if (url.pathname === "/me/ink-prefs" && request.method === "PATCH") {
        const session = await getSession(request, env);
        if (session instanceof Response) return session;
        const body = await request.json<unknown>();
        const authHeader = request.headers.get("Authorization");
        const updateRes = await env.AUTH.fetch("https://auth/update-ink-prefs", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(authHeader ? { Authorization: authHeader } : {}) },
          body: JSON.stringify(body),
        });
        return addCorsHeaders(updateRes);
      }

      // PATCH /me/reading-font — update user's reading/editing prose-font choices
      if (url.pathname === "/me/reading-font" && request.method === "PATCH") {
        const session = await getSession(request, env);
        if (session instanceof Response) return session;
        const body = await request.json<unknown>();
        const authHeader = request.headers.get("Authorization");
        const updateRes = await env.AUTH.fetch("https://auth/update-reading-font", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(authHeader ? { Authorization: authHeader } : {}) },
          body: JSON.stringify(body),
        });
        return addCorsHeaders(updateRes);
      }

      // PATCH /me/theme — set site theme (dark/light/custom). Admins always
      // have access; other users require the custom-theming Flagship flag.
      if (url.pathname === "/me/theme" && request.method === "PATCH") {
        const session = await getSession(request, env);
        if (session instanceof Response) return session;
        if (!session.isAdmin) {
          const flagEnabled = env.FLAGS
            ? await env.FLAGS.getBooleanValue("custom-theming", false, { userId: session.userId })
            : true;
          if (!flagEnabled) return addCorsHeaders(errorResponse(Errors.FORBIDDEN));
        }
        const body = await request.json<unknown>();
        const authHeader = request.headers.get("Authorization");
        const updateRes = await env.AUTH.fetch("https://auth/update-theme", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(authHeader ? { Authorization: authHeader } : {}) },
          body: JSON.stringify(body),
        });
        return addCorsHeaders(updateRes);
      }

      // PATCH /me/bio — Ink-only supporter bio. Proxied so the auth worker
      // can plan-gate against the live row (avoids JWT-staleness writes).
      if (url.pathname === "/me/bio" && request.method === "PATCH") {
        const session = await getSession(request, env);
        if (session instanceof Response) return session;
        const body = await request.json<unknown>();
        const authHeader = request.headers.get("Authorization");
        const updateRes = await env.AUTH.fetch("https://auth/update-bio", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(authHeader ? { Authorization: authHeader } : {}) },
          body: JSON.stringify(body),
        });
        return addCorsHeaders(updateRes);
      }

      // GET /me/favourite-sites/search?q= — find published sites by name for
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

      // GET /me/favourite-sites — list current user's favourited published projects
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

      // POST /me/favourite-sites/:projectId — add a favourite (idempotent)
      // DELETE /me/favourite-sites/:projectId — remove
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
            "SELECT COUNT(*) as n, SUM(CASE WHEN project_id = ? THEN 1 ELSE 0 END) as has FROM user_favourite_projects WHERE user_id = ?",
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
        // PATCH — update the per-favourite note. Empty/missing string clears it.
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

      // GET /avatar/:userId — public, serve avatar from R2.
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
            ...corsHeaders(),
          },
        });
      }

      // POST /avatar — authenticated, upload avatar image
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

      // DELETE /avatar — authenticated. ?variant=light|dark removes only that
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

      // DELETE /me — delete the authenticated user's account
      if (url.pathname === "/me" && request.method === "DELETE") {
        const session = await getSession(request, env);
        if (session instanceof Response) return session;

        const ownedCount = await env.DB.prepare(
          "SELECT COUNT(*) as count FROM projects WHERE owner_id = ?",
        ).bind(session.userId).first<{ count: number }>();
        if (ownedCount && ownedCount.count > 0) {
          return addCorsHeaders(Response.json({ ok: false, error: "owns_projects" }, { status: 400 }));
        }

        const body = await request.json<Record<string, unknown>>();
        const authHeader = request.headers.get("Authorization");
        const authRes = await env.AUTH.fetch("https://auth/delete-account", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(authHeader ? { Authorization: authHeader } : {}) },
          body: JSON.stringify(body),
        });
        const authJson = await authRes.json<{ ok: boolean; error?: string }>();
        if (!authJson.ok) return addCorsHeaders(Response.json(authJson, { status: authRes.status }));

        // Delete projects the user owns (cascades to docs, members, etc.)
        const ownedProjects = await env.DB.prepare(
          "SELECT id FROM projects WHERE owner_id = ?",
        ).bind(session.userId).all<{ id: string }>();
        for (const proj of ownedProjects.results) {
          await env.DB.prepare("DELETE FROM projects WHERE id = ?").bind(proj.id).run();
        }

        // Remove user from any remaining project memberships
        await env.DB.prepare("DELETE FROM project_members WHERE user_id = ?").bind(session.userId).run();

        // Delete avatar (both variants + any legacy object)
        await deleteAllAvatarVariants(env.ASSETS, session.userId);

        return addCorsHeaders(Response.json({ ok: true }));
      }

      // GET /users/:userId — authenticated, returns user profile + shared projects
      const userProfileMatch = url.pathname.match(/^\/users\/([^/]+)$/);
      if (userProfileMatch && request.method === "GET") {
        const session = await getSession(request, env);
        if (session instanceof Response) return session;
        const targetUserId = userProfileMatch[1];

        const lookupRes = await env.AUTH.fetch("https://auth/lookup-by-id", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId: targetUserId }),
        });
        if (!lookupRes.ok) {
          return addCorsHeaders(lookupRes.status === 404 ? errorResponse(Errors.NOT_FOUND) : errorResponse(Errors.INTERNAL));
        }
        const lookupData = await lookupRes.json<{ ok: boolean; data?: { userId: string; name: string; email: string; createdAt: string; timezone: string | null; badges?: number; bio?: string | null } }>();
        if (!lookupData.ok || !lookupData.data) return addCorsHeaders(errorResponse(Errors.NOT_FOUND));

        const sharedRows = await env.DB.prepare(
          `SELECT p.id, p.name, target.role as their_role
           FROM projects p
           JOIN project_members caller ON caller.project_id = p.id AND caller.user_id = ? AND caller.accepted = 1
           JOIN project_members target ON target.project_id = p.id AND target.user_id = ? AND target.accepted = 1
           ORDER BY p.name ASC`,
        ).bind(session.userId, targetUserId).all<{ id: string; name: string; their_role: string }>();

        const favouriteRows = await env.DB.prepare(
          `SELECT p.id, p.name, p.vanity_slug, p.logo_square_updated_at, p.logo_wide_updated_at, ufp.note
           FROM user_favourite_projects ufp
           JOIN projects p ON p.id = ufp.project_id
           WHERE ufp.user_id = ? AND p.published_at IS NOT NULL
           ORDER BY ufp.created_at DESC`,
        ).bind(targetUserId).all<{ id: string; name: string; vanity_slug: string | null; logo_square_updated_at: string | null; logo_wide_updated_at: string | null; note: string | null }>();

        const planRow = await env.AUTH_DB.prepare(
          `SELECT p.personal_plan_style, p.personal_presence_color, p.personal_crit_sparkles,
                  b.personal_plan, b.personal_plan_status, b.personal_plan_started_at,
                  b.personal_plan_cancel_at,
                  b.granted_plan, b.granted_plan_expires_at, b.granted_plan_started_at
           FROM users u
           LEFT JOIN user_billing b ON b.user_id = u.id
           LEFT JOIN user_preferences p ON p.user_id = u.id
           WHERE u.id = ?`,
        ).bind(targetUserId).first<{
          personal_plan: string | null;
          personal_plan_status: string | null;
          personal_plan_started_at: number | null;
          personal_plan_cancel_at: number | null;
          personal_plan_style: string | null;
          personal_presence_color: string | null;
          personal_crit_sparkles: number | null;
          granted_plan: string | null;
          granted_plan_expires_at: number | null;
          granted_plan_started_at: number | null;
        }>();
        const resolvedPlan = planRow ? resolvePersonalPlan(planRow) : { plan: "free" as const, since: null, style: null, presenceColor: null };

        const profileData: Record<string, unknown> = {
          userId: lookupData.data.userId,
          name: lookupData.data.name,
          createdAt: lookupData.data.createdAt,
          sharedProjects: sharedRows.results.map(r => ({ id: r.id, name: r.name, theirRole: r.their_role })),
          favouriteSites: favouriteRows.results.map(r => ({
            id: r.id,
            name: r.name,
            vanitySlug: r.vanity_slug,
            logoSquareUpdatedAt: r.logo_square_updated_at,
            logoWideUpdatedAt: r.logo_wide_updated_at,
            note: r.note,
          })),
          personalPlan: resolvedPlan.plan,
          personalPlanSince: resolvedPlan.since,
          personalPlanStyle: resolvedPlan.style,
          badges: lookupData.data.badges ?? 0,
        };
        if (lookupData.data.timezone) profileData.timezone = lookupData.data.timezone;
        // Bio is supporter-gated on display: only render if the target user
        // currently holds Ink. The column persists across cancel/resub cycles
        // so a user gets their bio back if they re-subscribe.
        if (resolvedPlan.plan === "ink" && lookupData.data.bio) profileData.bio = lookupData.data.bio;

        return addCorsHeaders(Response.json({ ok: true, data: profileData }));
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
      } else if (url.pathname.startsWith("/public")) {
        response = await handlePublic(request, env, url);
      } else if (url.pathname.startsWith("/invites/")) {
        response = await handleInvitePublic(request, env, url);
      } else if (/^\/projects\/[^/]+\/members/.test(url.pathname)) {
        const session = await getSession(request, env);
        if (session instanceof Response) return session;
        response = await handleMembers(request, env, session, url);
      } else if (/^\/projects\/[^/]+\/api-keys/.test(url.pathname)) {
        const session = await getSession(request, env);
        if (session instanceof Response) return session;
        response = await handleApiKeys(request, env, session, url);
      } else if (/^\/projects\/[^/]+\/invite-links/.test(url.pathname)) {
        const session = await getSession(request, env);
        if (session instanceof Response) return session;
        response = await handleInviteLinks(request, env, session, url);
      } else if (/^\/projects\/[^/]+\/folder-shares/.test(url.pathname)) {
        const session = await getSession(request, env);
        if (session instanceof Response) return session;
        response = await handleDocShares(request, env, session, url);
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

  // Token arrives as a query param (browsers can't set headers on WS).
  // Re-wrap it as a Bearer header so authenticate() / the AUTH service binding handles it
  // the same way every other route does — works in local dev without JWT_SECRET.
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

  const caller = await env.DB.prepare("SELECT role, name FROM project_members WHERE project_id = ? AND user_id = ?")
    .bind(docRow.project_id, session.userId).first<{ role: string; name: string }>();
  if (!caller || ROLE_RANK[caller.role as keyof typeof ROLE_RANK] < ROLE_RANK["editor"]) {
    return new Response("Forbidden", { status: 403 });
  }

  const id = env.DOC_COLLAB.idFromName(`${docRow.project_id}:${docId}`);
  const stub = env.DOC_COLLAB.get(id);

  const upstream = new Request(request.url, {
    method: request.method,
    headers: new Headers({
      ...Object.fromEntries(request.headers),
      "X-User-Id": session.userId,
      "X-User-Name": caller.name,
      "X-Project-Id": docRow.project_id,
      "X-Doc-Id": docId,
    }),
  });
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
