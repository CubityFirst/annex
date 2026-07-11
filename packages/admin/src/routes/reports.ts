import { Hono } from "hono";
import type { Context } from "hono";
import { writeAdminAudit } from "../audit";
import { type KeysetCursor, encodeCursor, decodeCursor, keysetClause } from "../lib/cursor";
import type { AppEnv, Env } from "../index";

const reportsRouter = new Hono<AppEnv>();

const REPORT_PAGE_SIZE = 25;

export const REPORT_STATUSES = ["open", "acknowledged", "resolved", "dismissed"] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export interface SiteReportRow {
  id: string;
  project_id: string;
  project_name: string | null;
  reporter_user_id: string | null;
  reporter_ip: string | null;
  doc_id: string | null;
  doc_title: string | null;
  note: string;
  status: string;
  created_at: string;
  status_changed_at: string | null;
  status_changed_by: string | null;
}

export interface UserReportRow {
  id: string;
  reported_user_id: string;
  reporter_user_id: string;
  reporter_ip: string | null;
  note: string;
  status: string;
  created_at: string;
  status_changed_at: string | null;
  status_changed_by: string | null;
}

// User identities live in the auth DB (cross-DB, so no JOIN): batch-resolve
// email/name for the ids on a page. Missing users (deleted accounts) simply
// stay unresolved and render as the bare id.
async function resolveUserIdentities(
  env: Env,
  ids: Array<string | null>,
): Promise<Record<string, { email: string | null; name: string | null }>> {
  const unique = [...new Set(ids.filter((v): v is string => v !== null))];
  const out: Record<string, { email: string | null; name: string | null }> = {};
  for (let i = 0; i < unique.length; i += 50) {
    const chunk = unique.slice(i, i + 50);
    const ph = chunk.map(() => "?").join(",");
    const users = await env.AUTH_DB.prepare(
      `SELECT id, email, name FROM users WHERE id IN (${ph})`,
    ).bind(...chunk).all<{ id: string; email: string | null; name: string | null }>();
    for (const u of users.results) out[u.id] = { email: u.email, name: u.name };
  }
  return out;
}

// Shared list-query scaffolding for both report kinds: status filter
// ("current" = the open+acknowledged triage queue), keyset cursor, and the
// hasMore/nextCursor page split. Returns a Response on a bad filter/cursor.
function buildListFilters(c: Context<AppEnv>): { where: string[]; binds: unknown[] } | Response {
  const status = c.req.query("status") ?? "current";
  const rawCursor = c.req.query("cursor");
  let cursor: KeysetCursor | null = null;
  if (rawCursor) {
    cursor = decodeCursor(rawCursor);
    if (!cursor) return c.json({ ok: false, error: "Invalid cursor" }, 400);
  }
  const keyset = keysetClause(cursor, "r.created_at", "r.id");

  const where: string[] = [];
  const binds: unknown[] = [];
  if (status === "current") {
    where.push("r.status IN ('open', 'acknowledged')");
  } else if (status !== "all") {
    if (!(REPORT_STATUSES as readonly string[]).includes(status)) {
      return c.json({ ok: false, error: "Invalid status filter" }, 400);
    }
    where.push("r.status = ?");
    binds.push(status);
  }
  if (keyset.sql) {
    where.push(keyset.sql);
    binds.push(...keyset.binds);
  }
  return { where, binds };
}

function splitPage<T extends { created_at: string; id: string }>(rows: T[]) {
  const hasMore = rows.length > REPORT_PAGE_SIZE;
  const page = hasMore ? rows.slice(0, REPORT_PAGE_SIZE) : rows;
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? encodeCursor({ ts: last.created_at, id: last.id }) : null;
  return { page, nextCursor };
}

// PATCH handler shared by both kinds - move a report through triage
// (acknowledge / resolve / dismiss, or back to open). Records who changed it
// and writes an audit row with the report kind.
function makePatchHandler(table: "site_reports" | "user_reports", kind: "site" | "user") {
  // What the report targets, for the audit trail: the site or the user.
  const targetCol = kind === "site" ? "project_id" : "reported_user_id";
  return async (c: Context<AppEnv>) => {
    const session = c.get("session");
    // The handler is built outside a typed .patch(":id") call, so Hono can't
    // prove the param exists - guard rather than assert.
    const id = c.req.param("id");
    if (!id) return c.json({ ok: false, error: "Not found" }, 404);
    const body = await c.req.json<{ status?: string }>().catch(() => ({} as { status?: string }));
    const status = body.status;
    if (!status || !(REPORT_STATUSES as readonly string[]).includes(status)) {
      return c.json({ ok: false, error: "Invalid status" }, 400);
    }

    // Existence check so a stale id 404s instead of ok:true + phantom audit row.
    const report = await c.env.DB.prepare(`SELECT id, status, ${targetCol} AS target FROM ${table} WHERE id = ?`)
      .bind(id).first<{ id: string; status: string; target: string }>();
    if (!report) return c.json({ ok: false, error: "Not found" }, 404);

    await c.env.DB.prepare(
      `UPDATE ${table} SET status = ?, status_changed_at = datetime('now'), status_changed_by = ? WHERE id = ?`,
    ).bind(status, session.userId, id).run();

    await writeAdminAudit(c.env, session, "report.status.update", "report", id, {
      kind,
      target: report.target,
      from: report.status,
      to: status,
    });
    return c.json({ ok: true });
  };
}

// GET /api/reports/sites?status=&projectId=&cursor=
//
// status: "current" (default), "all", or one concrete status. projectId
// narrows to a single site (the per-site "Reports" view in the Projects
// page). Newest first, keyset-paged.
reportsRouter.get("/sites", async (c) => {
  const filters = buildListFilters(c);
  if (filters instanceof Response) return filters;
  const { where, binds } = filters;

  const projectId = c.req.query("projectId");
  if (projectId) {
    where.push("r.project_id = ?");
    binds.push(projectId);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  // LEFT JOINs: reports survive as long as their project does (CASCADE), and
  // doc_id goes NULL when the reported page is deleted - keep the report
  // either way rather than dropping it.
  const rows = await c.env.DB.prepare(
    `SELECT r.id, r.project_id, p.name AS project_name, r.reporter_user_id, r.reporter_ip,
            r.doc_id, d.title AS doc_title,
            r.note, r.status, r.created_at, r.status_changed_at, r.status_changed_by
       FROM site_reports r
       LEFT JOIN projects p ON p.id = r.project_id
       LEFT JOIN docs d ON d.id = r.doc_id
       ${whereSql}
       ORDER BY r.created_at DESC, r.id DESC LIMIT ?`,
  ).bind(...binds, REPORT_PAGE_SIZE + 1).all<SiteReportRow>();

  const { page, nextCursor } = splitPage(rows.results);
  const identities = await resolveUserIdentities(c.env, page.map(r => r.reporter_user_id));
  const reports = page.map(r => ({
    ...r,
    reporter: r.reporter_user_id ? (identities[r.reporter_user_id] ?? null) : null,
  }));

  return c.json({ ok: true, data: { reports, nextCursor } });
});

reportsRouter.patch("/sites/:id", makePatchHandler("site_reports", "site"));

// GET /api/reports/users?status=&userId=&cursor=
//
// Same shape as /sites; userId narrows to reports filed against one user.
reportsRouter.get("/users", async (c) => {
  const filters = buildListFilters(c);
  if (filters instanceof Response) return filters;
  const { where, binds } = filters;

  const userId = c.req.query("userId");
  if (userId) {
    where.push("r.reported_user_id = ?");
    binds.push(userId);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const rows = await c.env.DB.prepare(
    `SELECT r.id, r.reported_user_id, r.reporter_user_id, r.reporter_ip,
            r.note, r.status, r.created_at, r.status_changed_at, r.status_changed_by
       FROM user_reports r
       ${whereSql}
       ORDER BY r.created_at DESC, r.id DESC LIMIT ?`,
  ).bind(...binds, REPORT_PAGE_SIZE + 1).all<UserReportRow>();

  const { page, nextCursor } = splitPage(rows.results);
  const identities = await resolveUserIdentities(
    c.env,
    page.flatMap(r => [r.reported_user_id, r.reporter_user_id]),
  );
  const reports = page.map(r => ({
    ...r,
    reported: identities[r.reported_user_id] ?? null,
    reporter: identities[r.reporter_user_id] ?? null,
  }));

  return c.json({ ok: true, data: { reports, nextCursor } });
});

reportsRouter.patch("/users/:id", makePatchHandler("user_reports", "user"));

export { reportsRouter };
