// One-time copy of Annex-owned data from the retired cubedocs-auth database
// into cubedocs-main (api migration 0065_add_identity_mirror.sql).
//
// Identity itself (password hashes, TOTP, passkeys, OAuth clients) is NOT
// copied here: that went to the identity service's own database. What comes
// across is what Annex keeps: the users mirror (id/email/name/admin/standing),
// billing, preferences, Stripe webhook markers, scheduled deletions,
// moderation history and the admin audit log.
//
// Every statement is INSERT OR IGNORE, so a second run never overwrites rows
// Annex has written since. Run it once, at cutover, before Annex serves
// traffic from the new code (see memories/Identity-Client.md).

/** @param {unknown} v */
export function sqlValue(v) {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number" || typeof v === "bigint") {
    if (typeof v === "number" && !Number.isFinite(v)) throw new Error(`non-finite number: ${v}`);
    return String(v);
  }
  if (typeof v === "boolean") return v ? "1" : "0";
  if (typeof v === "string") return `'${v.replace(/'/g, "''")}'`;
  throw new Error(`unsupported SQL value: ${typeof v}`);
}

/**
 * @param {string} table
 * @param {string[]} cols
 * @param {Array<Record<string, unknown>>} rows
 */
function inserts(table, cols, rows) {
  return rows.map(
    (r) => `INSERT OR IGNORE INTO ${table} (${cols.join(", ")}) VALUES (${cols.map((c) => sqlValue(r[c])).join(", ")});`,
  );
}

// users.moderation on cubedocs-auth: 0 = active, -1 = disabled, >0 = suspended
// until that unix-seconds instant (an expired suspension reads as active).
export function standingFromModeration(moderation, nowMs) {
  if (moderation === -1) return { status: "disabled", suspendedUntil: null };
  if (moderation > 0 && Math.floor(nowMs / 1000) < moderation) return { status: "suspended", suspendedUntil: moderation };
  return { status: "active", suspendedUntil: null };
}

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

/**
 * Builds the import statements from an opened copy of cubedocs-auth.
 *
 * @param {{ prepare(sql: string): { all(...a: unknown[]): any[]; get(...a: unknown[]): any } }} db
 *   node:sqlite DatabaseSync (or anything with the same prepare/all/get shape)
 * @param {number} nowMs
 * @returns {{ statements: string[]; counts: Record<string, number> }}
 */
export function buildImportStatements(db, nowMs = Date.now()) {
  const statements = [];
  const counts = {};

  const users = db
    .prepare("SELECT id, email, name, email_verified, is_admin, moderation, created_at FROM users ORDER BY created_at, id")
    .all()
    .map((u) => {
      const standing = standingFromModeration(Number(u.moderation ?? 0), nowMs);
      const createdMs = Date.parse(u.created_at);
      return {
        id: u.id,
        email: u.email,
        name: u.name,
        email_verified: u.email_verified ? 1 : 0,
        is_admin: u.is_admin ? 1 : 0,
        status: standing.status,
        suspended_until: standing.suspendedUntil,
        created_at: u.created_at,
        first_seen_at: Number.isFinite(createdMs) ? createdMs : nowMs,
        last_login_at: null,
        synced_at: nowMs,
      };
    });
  statements.push(
    ...inserts(
      "users",
      ["id", "email", "name", "email_verified", "is_admin", "status", "suspended_until", "created_at", "first_seen_at", "last_login_at", "synced_at"],
      users,
    ),
  );
  counts.users = users.length;

  // Satellites, copied column-for-column. Parents first (FKs are enforced).
  const copies = [
    ["user_billing", [
      "user_id", "stripe_customer_id", "stripe_subscription_id", "personal_period_end",
      "personal_plan", "personal_plan_status", "personal_plan_started_at", "personal_plan_cancel_at",
      "granted_plan", "granted_plan_expires_at", "granted_plan_started_at", "granted_plan_reason",
    ]],
    ["user_preferences", [
      "user_id", "reading_font", "editing_font", "ui_font",
      "personal_plan_style", "personal_presence_color", "personal_crit_sparkles",
      "timezone", "bio", "badges", "theme_mode", "theme_custom_color", "handle", "handle_locked",
    ]],
    // previous_moderation is dropped: cancelling a deletion no longer touches
    // account standing (that lives on the identity service now).
    ["user_deletions", [
      "user_id", "id", "requested_by", "requested_by_email", "requested_at", "execute_after",
      "confirm_site_ids", "confirm_org_ids", "lease_until", "started_at", "last_error", "last_attempt_at",
    ]],
    ["user_moderation_events", [
      "id", "user_id", "action", "moderation_value", "reason", "created_at", "actor_user_id", "actor_email",
    ]],
    ["admin_audit_log", [
      "id", "actor_user_id", "actor_email", "action", "target_type", "target_id", "detail", "created_at",
    ]],
    ["webhook_events", ["event_id", "type", "processed_at"]],
  ];

  const userIds = new Set(users.map((u) => u.id));
  for (const [table, cols] of copies) {
    if (!tableExists(db, table)) {
      counts[table] = 0;
      continue;
    }
    let rows = db.prepare(`SELECT ${cols.join(", ")} FROM ${table}`).all();
    // Belt and braces: a satellite row for a user that isn't being copied
    // would fail the FK and abort the whole import.
    if (cols[0] === "user_id" || table === "user_moderation_events") {
      rows = rows.filter((r) => userIds.has(r.user_id));
    }
    statements.push(...inserts(table, cols, rows));
    counts[table] = rows.length;
  }

  return { statements, counts };
}
