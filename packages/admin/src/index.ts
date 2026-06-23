import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { requireAdminSession, verifySession, type AdminSession } from "./auth";
import { usersRouter } from "./routes/users";
import { projectsRouter } from "./routes/projects";
import { auditRouter } from "./routes/audit";
import { oauthRouter } from "./routes/oauth";

export interface Env {
  DB: D1Database;
  AUTH_DB: D1Database;
  ASSETS: R2Bucket;
  SITE_ASSETS: Fetcher;
  AUTH: Fetcher;
  // Same value as the auth worker's JWT_SECRET. The admin worker verifies
  // sessions inline against AUTH_DB (see src/auth.ts) instead of calling
  // the auth worker's /verify route, so it needs the signing secret. A
  // schema change to users/sessions/user_billing/user_preferences columns
  // read by loadCurrentSession requires redeploying auth + api + admin.
  JWT_SECRET: string;
  // IP-keyed rate limiters (Cloudflare unsafe bindings — see wrangler.toml).
  // RATE_LIMITER_ADMIN gates every authenticated admin API route;
  // RATE_LIMITER_ADMIN_HANDOFF gates the unauthenticated exchange proxy.
  RATE_LIMITER_ADMIN: { limit(opts: { key: string }): Promise<{ success: boolean }> };
  RATE_LIMITER_ADMIN_HANDOFF: { limit(opts: { key: string }): Promise<{ success: boolean }> };
  // Used only for admin-driven Stripe operations (cancel-on-grant). The
  // auth worker still owns the rest of the Stripe lifecycle (Checkout,
  // Customer Portal, webhook); admin reaches the Stripe API directly
  // here to keep the cancel-on-grant path on a single worker.
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

  const session = await requireAdminSession(c.req.raw, c.env);
  if (session instanceof Response) return session;
  c.set("session", session);
  await next();
};

app.post("/api/auth/handoff/exchange", async (c) => {
  const ip = c.req.raw.headers.get("CF-Connecting-IP") ?? "unknown";
  const { success } = await c.env.RATE_LIMITER_ADMIN_HANDOFF.limit({ key: ip });
  if (!success) return c.json({ ok: false, error: "rate_limited" }, 429);

  const body = await c.req.json();
  return c.env.AUTH.fetch("https://auth/admin/handoff/exchange", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
});

app.get("/api/verify", async (c) => {
  const session = await verifySession(c.req.raw, c.env);

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
  const { success } = await c.env.RATE_LIMITER_ADMIN.limit({ key: `avatar:${ip}` });
  if (!success) return c.json({ ok: false, error: "rate_limited" }, 429);

  const userId = c.req.param("userId");
  // Admin only ever shows the dark variant. Read-only: fall back to a legacy
  // object but do NOT migrate/delete here — the API worker owns that.
  const obj = (await c.env.ASSETS.get(`avatars/${userId}-dark`))
    ?? (await c.env.ASSETS.get(`avatars/${userId}`));
  if (!obj) return new Response(null, { status: 404 });
  const contentType = obj.httpMetadata?.contentType ?? "application/octet-stream";
  return new Response(await obj.arrayBuffer(), {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=300",
    },
  });
});

app.use("/api/users", enforceAdmin);
app.use("/api/users/*", enforceAdmin);
app.use("/api/projects", enforceAdmin);
app.use("/api/projects/*", enforceAdmin);
app.use("/api/audit", enforceAdmin);
app.use("/api/audit/*", enforceAdmin);
app.use("/api/oauth-clients", enforceAdmin);
app.use("/api/oauth-clients/*", enforceAdmin);

app.route("/api/users", usersRouter);
app.route("/api/projects", projectsRouter);
app.route("/api/audit", auditRouter);
app.route("/api/oauth-clients", oauthRouter);

app.all("*", (c) => c.env.SITE_ASSETS.fetch(c.req.raw));

export default app;
