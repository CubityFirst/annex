import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { adminAuthFlow, requireAdminSession, verifySession, type AdminSession } from "./auth";
import { handleCallback, handleDevQuickLogin, handleExchange, handleLogin, handleLogout } from "../../api/src/routes/auth";
import type { IdentityService } from "../../api/src/account/identity";
import { usersRouter } from "./routes/users";
import { projectsRouter } from "./routes/projects";
import { auditRouter } from "./routes/audit";
import { reportsRouter } from "./routes/reports";
import { runDueUserDeletions } from "./lib/userDeletion";

export interface Env {
  // cubedocs-main: sites, Annex's users mirror, sessions (incl. this panel's
  // 'admin' sessions), billing/preferences, deletions and the audit log.
  DB: D1Database;
  ASSETS: R2Bucket;
  SITE_ASSETS: Fetcher;
  // Annex-only secret for Annex session JWTs (the admin panel signs its own
  // 'admin' sessions; nothing is shared with the identity service).
  JWT_SECRET: string;
  // Identity service (auth.cubityfir.st): IdentityService RPC for live account
  // standing / admin role, and its HTTP surface (default export) for
  // server-side OIDC requests - a same-zone fetch() to auth.cubityfir.st would
  // reach the origin, not the identity worker.
  IDENTITY?: IdentityService;
  IDENTITY_OIDC?: Fetcher;
  // This panel's OIDC client (vars; OIDC_CLIENT_SECRET is a secret). The
  // redirect URIs default to APP_ORIGIN/api/auth/callback and APP_ORIGIN/.
  OIDC_ISSUER?: string;
  OIDC_CLIENT_ID?: string;
  OIDC_CLIENT_SECRET?: string;
  OIDC_REDIRECT_URI?: string;
  OIDC_POST_LOGOUT_REDIRECT_URI?: string;
  APP_ORIGIN?: string;
  // Local dev only: POST /api/dev/quick-login mints an admin dev session
  // (needs "true" AND a localhost APP_ORIGIN; the e2e admin suite uses it).
  DEV_QUICK_LOGIN?: string;
  // IP-keyed rate limiters (Cloudflare ratelimit bindings - see cloudflare.config.ts).
  // RATE_LIMITER_ADMIN gates every authenticated admin API route and the
  // sign-in endpoints; RATE_LIMITER_AVATAR gates the public avatar route on
  // its own budget so dashboard avatar fan-out (25 per page) can't starve the
  // operator's API-route budget or vice versa.
  RATE_LIMITER_ADMIN: { limit(opts: { key: string }): Promise<{ success: boolean }> };
  RATE_LIMITER_AVATAR: { limit(opts: { key: string }): Promise<{ success: boolean }> };
  // Used for admin-driven Stripe operations (cancel-on-grant, gift month,
  // cancel subscription). Same key as the API worker.
  STRIPE_SECRET_KEY: string;
  // Cloudflare-for-SaaS custom domains (see api/src/lib/customDomains.ts).
  // Used only to release a site's custom hostname when an admin deletes the
  // site. Optional: when unset, releaseCustomDomain() is a no-op (the owner
  // can still remove the domain from Site Settings before deletion). Must
  // match the api worker's values to actually deregister on admin delete.
  CF_API_TOKEN?: string;
  CF_ZONE_ID?: string;
  CUSTOM_DOMAIN_CNAME_TARGET?: string;
}

// Shared Hono env for the app and the sub-routers. The admin session is
// resolved once in `enforceAdmin` and stashed on the context so handlers
// read `c.get("session")` instead of each re-verifying (which was both
// duplicated boilerplate and the only thing enforcing auth on routes that
// remembered to call it).
export type AppEnv = { Bindings: Env; Variables: { session: AdminSession } };

const app = new Hono<AppEnv>();

const enforceAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const ip = c.req.raw.headers.get("CF-Connecting-IP") ?? "unknown";
  const { success } = await c.env.RATE_LIMITER_ADMIN.limit({ key: ip });
  if (!success) return c.json({ ok: false, error: "rate_limited" }, 429);

  // executionCtx lets the session loader refresh last_used_at after the
  // response - without it, admin sessions never update and the "Active
  // sessions" view can't spot a stolen admin token in use.
  const session = await requireAdminSession(c.req.raw, c.env, c.executionCtx);
  if (session instanceof Response) return session;
  c.set("session", session);
  await next();
};

// Sign in with auth.cubityfir.st (this panel's own OIDC client; see
// src/auth.ts). login/callback are top-level browser navigations; exchange
// and logout are called by the SPA. All share the admin IP limiter.
async function limited(c: { env: Env; req: { raw: Request } }): Promise<Response | null> {
  const ip = c.req.raw.headers.get("CF-Connecting-IP") ?? "unknown";
  const { success } = await c.env.RATE_LIMITER_ADMIN.limit({ key: ip });
  return success ? null : Response.json({ ok: false, error: "rate_limited" }, { status: 429 });
}

app.get("/api/auth/login", async (c) => (await limited(c)) ?? handleLogin(adminAuthFlow(c.env), c.env, new URL(c.req.url)));
app.get("/api/auth/callback", async (c) => (await limited(c)) ?? handleCallback(adminAuthFlow(c.env), c.env, c.req.raw, new URL(c.req.url)));
app.post("/api/auth/exchange", async (c) => (await limited(c)) ?? handleExchange(adminAuthFlow(c.env), c.env, c.req.raw));

// POST /api/auth/logout - revoke the caller's own admin session and return
// the identity service's end-session URL. Deliberately NOT behind
// enforceAdmin: an operator whose admin role was just removed (or whose
// account was disabled) must still be able to kill the session.
app.post("/api/auth/logout", async (c) => (await limited(c)) ?? handleLogout(adminAuthFlow(c.env), c.env, c.req.raw));

// Local dev only (404 unless DEV_QUICK_LOGIN=true and APP_ORIGIN is localhost).
app.post("/api/dev/quick-login", async (c) => (await limited(c)) ?? handleDevQuickLogin(c.req.raw, c.env, "admin"));

app.get("/api/verify", async (c) => {
  // Same IP limiter as the authenticated routes: this is otherwise the one
  // unauthenticated endpoint where anyone holding an expired-but-signed JWT
  // could drive unlimited D1 batches.
  const ip = c.req.raw.headers.get("CF-Connecting-IP") ?? "unknown";
  const { success } = await c.env.RATE_LIMITER_ADMIN.limit({ key: ip });
  if (!success) return c.json({ ok: false, error: "rate_limited" }, 429);

  const session = await verifySession(c.req.raw, c.env, c.executionCtx);

  if (session === null) return c.json({ ok: false, error: "Unauthorized" }, 401);
  if (session instanceof Response) return session;
  if (!session.isAdmin) return c.json({ ok: false, error: "Forbidden" }, 403);

  return c.json({
    ok: true,
    data: {
      userId: session.userId,
      email: session.email,
      expiresAt: session.expiresAt,
      isAdmin: true,
    },
  });
});

app.get("/api/avatar/:userId", async (c) => {
  // Deliberately unauthenticated: rendered as a plain <img src> in the admin
  // UI (browsers can't attach a bearer token to an image request), and the
  // same bytes are already public via the API worker. But it reads R2, so
  // IP-rate-limit it to keep it from being an unmetered read surface. Missing
  // objects still 404 so the UI's initials fallback kicks in.
  const ip = c.req.raw.headers.get("CF-Connecting-IP") ?? "unknown";
  const { success } = await c.env.RATE_LIMITER_AVATAR.limit({ key: ip });
  if (!success) return c.json({ ok: false, error: "rate_limited" }, 429);

  const userId = c.req.param("userId");
  // Admin only ever shows the dark variant. Read-only: fall back to a legacy
  // object but do NOT migrate/delete here - the API worker owns that.
  const obj = (await c.env.ASSETS.get(`avatars/${userId}-dark`))
    ?? (await c.env.ASSETS.get(`avatars/${userId}`));
  if (!obj) return new Response(null, { status: 404 });
  const contentType = obj.httpMetadata?.contentType ?? "application/octet-stream";
  return new Response(await obj.arrayBuffer(), {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=300",
      "X-Content-Type-Options": "nosniff",
    },
  });
});

app.use("/api/users", enforceAdmin);
app.use("/api/users/*", enforceAdmin);
app.use("/api/projects", enforceAdmin);
app.use("/api/projects/*", enforceAdmin);
app.use("/api/audit", enforceAdmin);
app.use("/api/audit/*", enforceAdmin);
app.use("/api/reports", enforceAdmin);
app.use("/api/reports/*", enforceAdmin);

app.route("/api/users", usersRouter);
app.route("/api/projects", projectsRouter);
app.route("/api/audit", auditRouter);
app.route("/api/reports", reportsRouter);

// Unknown API paths must NOT fall through to the SPA shell: a JSON caller
// hitting a typo'd/removed endpoint should get a JSON 404, not 200 + HTML.
app.all("/api/*", (c) => c.json({ ok: false, error: "Not found" }, 404));

// Locked-down security headers for the served SPA. The admin panel is a
// high-privilege internal tool: no framing (clickjacking would ride the
// same-origin token attach), no external script/style/connect sources, so
// any future XSS has no CSP-sanctioned exfil or injection channel.
const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self'",
    // 'unsafe-inline' for styles only: Radix/shadcn set style attributes.
    "style-src 'self' 'unsafe-inline'",
    // blob: for site-logo object URLs; data: for inline icons.
    "img-src 'self' blob: data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; "),
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
};

app.all("*", async (c) => {
  const res = await c.env.SITE_ASSETS.fetch(c.req.raw);
  const secured = new Response(res.body, res);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    secured.headers.set(name, value);
  }
  return secured;
});

export { app };

export default {
  fetch: app.fetch,
  // Hourly cron (see cloudflare.config.ts triggers): performs account deletions
  // scheduled from the Users page once their grace window has passed.
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runDueUserDeletions(env)
        .then(({ deleted, failed }) => {
          if (deleted > 0 || failed > 0) console.log(`[user-deletion] deleted ${deleted}, failed ${failed}`);
        })
        .catch(err => console.error("[user-deletion] run failed:", err)),
    );
  },
} satisfies ExportedHandler<Env>;
