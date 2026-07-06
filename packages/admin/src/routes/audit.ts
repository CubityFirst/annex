import { Hono } from "hono";
import type { AppEnv } from "../index";
import { type KeysetCursor, encodeCursor, decodeCursor, keysetClause } from "../lib/cursor";
import { escapeLike, LIKE_ESCAPE_CLAUSE } from "../lib/sql";

const PAGE_SIZE = 25;

// Re-exported so existing importers (and the test) keep their import path.
export { encodeCursor, decodeCursor };

interface AuditRow {
  id: string;
  actor_user_id: string;
  actor_email: string;
  action: string;
  target_type: string;
  target_id: string | null;
  detail: string | null;
  created_at: string;
}

const AUDIT_COLS =
  "id, actor_user_id, actor_email, action, target_type, target_id, detail, created_at";

export interface AuditFilters {
  // Match any of these action types (OR within the set). Empty = all actions.
  actions: string[];
  // Free-text user scope: substring-matched against the acting admin
  // (actor_email / actor_user_id) and the target id. null = everyone.
  q: string | null;
}

// Builds the keyset list query. The cursor, action set, and user-scope
// search each contribute an AND-ed WHERE clause; the ORDER BY is fixed so
// the created_at index keeps driving paging. `binds` are positional, in
// SQL order, and do NOT include the trailing LIMIT bind (caller appends it).
export function buildAuditListQuery(
  cursor: KeysetCursor | null,
  filters: AuditFilters,
): { sql: string; binds: unknown[] } {
  const where: string[] = [];
  const binds: unknown[] = [];
  const keyset = keysetClause(cursor, "created_at", "id");
  if (keyset.sql) {
    where.push(keyset.sql);
    binds.push(...keyset.binds);
  }
  if (filters.actions.length > 0) {
    const placeholders = filters.actions.map(() => "?").join(", ");
    where.push(`action IN (${placeholders})`);
    binds.push(...filters.actions);
  }
  if (filters.q) {
    where.push(
      `(actor_email LIKE ? ${LIKE_ESCAPE_CLAUSE} OR actor_user_id LIKE ? ${LIKE_ESCAPE_CLAUSE} OR target_id LIKE ? ${LIKE_ESCAPE_CLAUSE})`,
    );
    const like = `%${escapeLike(filters.q)}%`;
    binds.push(like, like, like);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const sql = `SELECT ${AUDIT_COLS} FROM admin_audit_log
     ${whereSql}
     ORDER BY created_at DESC, id DESC
     LIMIT ?`;
  return { sql, binds };
}

const auditRouter = new Hono<AppEnv>();

// GET /api/audit?cursor=<opaque>
//
// Newest-first, keyset-paginated by (created_at DESC, id DESC). Returns
// up to PAGE_SIZE rows plus a `nextCursor` (null when there are no older
// rows). Keyset rather than OFFSET so paging deep into history stays
// O(page) instead of O(offset) - the table only grows.
auditRouter.get("/", async (c) => {
  const rawCursor = c.req.query("cursor");
  let cursor: KeysetCursor | null = null;
  if (rawCursor) {
    cursor = decodeCursor(rawCursor);
    if (!cursor) return c.json({ ok: false, error: "Invalid cursor" }, 400);
  }

  // Optional filters; both compose with the keyset cursor as AND-ed WHERE
  // clauses, leaving the ORDER BY (and thus the created_at index) intact.
  // `action` is repeatable (action=a&action=b -> match any); `q` is a
  // user-scoped substring search. Parsed off the raw URL so repeated
  // params are handled regardless of Hono's query helper.
  const params = new URL(c.req.url).searchParams;
  const actions = params
    .getAll("action")
    .map((a) => a.trim())
    .filter(Boolean);
  const q = params.get("q")?.trim() || null;

  // One extra row tells us whether an older page exists without a count.
  const { sql, binds } = buildAuditListQuery(cursor, { actions, q });
  const stmt = c.env.AUTH_DB.prepare(sql).bind(...binds, PAGE_SIZE + 1);

  const rows = (await stmt.all<AuditRow>()).results;
  const hasMore = rows.length > PAGE_SIZE;
  const entries = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
  const last = entries[entries.length - 1];
  const nextCursor =
    hasMore && last ? encodeCursor({ ts: last.created_at, id: last.id }) : null;

  return c.json({ ok: true, data: { entries, nextCursor } });
});

// GET /api/audit/actions
//
// Distinct action values present in the log, sorted, for populating the
// filter dropdown. Cheap (small, slow-growing table) and re-derived on
// each load so newly introduced action types appear without code changes.
auditRouter.get("/actions", async (c) => {
  const rows = (
    await c.env.AUTH_DB.prepare(
      `SELECT DISTINCT action FROM admin_audit_log ORDER BY action ASC`,
    ).all<{ action: string }>()
  ).results;
  return c.json({ ok: true, data: { actions: rows.map((r) => r.action) } });
});

export { auditRouter };
