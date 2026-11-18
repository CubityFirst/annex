// scripts/lib/auth-import.mjs: the one-time cubedocs-auth -> cubedocs-main
// copy. Builds a source DB from the frozen cubedocs-auth schema, runs the
// generated statements against the real, fully migrated main schema, and
// checks what lands.
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
// @ts-expect-error - plain .mjs script module, no type declarations
import { buildImportStatements, sqlValue, standingFromModeration } from "../../../../scripts/lib/auth-import.mjs";

const AUTH_SCHEMA = fileURLToPath(new URL("../../../../scripts/fixtures/cubedocs-auth-schema.sql", import.meta.url));
const MAIN_MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

const NOW = Date.UTC(2026, 10, 18, 12, 0, 0);
const NOW_S = Math.floor(NOW / 1000);

function authDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(AUTH_SCHEMA, "utf8"));
  const user = db.prepare(
    "INSERT INTO users (id, email, name, password_hash, created_at, moderation, is_admin, email_verified) VALUES (?, ?, ?, 'x', ?, ?, ?, ?)",
  );
  user.run("u-active", "a@example.com", "Ann O'Neil", "2025-01-02T03:04:05.000Z", 0, 1, 1);
  user.run("u-disabled", "d@example.com", "Dee", "2025-02-01T00:00:00.000Z", -1, 0, 0);
  user.run("u-suspended", "s@example.com", "Sue", "2025-03-01T00:00:00.000Z", NOW_S + 3600, 0, 1);
  user.run("u-expired", "e@example.com", "Ed", "2025-04-01T00:00:00.000Z", NOW_S - 3600, 0, 1);
  db.prepare(
    "INSERT INTO user_billing (user_id, stripe_customer_id, stripe_subscription_id, personal_plan, personal_plan_status, personal_plan_started_at) VALUES (?, ?, ?, 'ink', 'active', ?)",
  ).run("u-active", "cus_1", "sub_1", NOW - 1000);
  db.prepare(
    "INSERT INTO user_preferences (user_id, reading_font, badges, bio, handle, handle_locked, theme_mode) VALUES (?, 'serif', 5, ?, 'ann', 1, 'light')",
  ).run("u-active", "it's me");
  db.prepare(
    "INSERT INTO user_deletions (user_id, id, requested_by, requested_by_email, execute_after, confirm_site_ids, previous_moderation) VALUES ('u-disabled', 'del-1', 'u-active', 'a@example.com', ?, '[\"p1\"]', 0)",
  ).run(NOW_S + 86400);
  db.prepare(
    "INSERT INTO user_moderation_events (id, user_id, action, moderation_value) VALUES ('m1', 'u-disabled', 'disable', -1)",
  ).run();
  db.prepare(
    "INSERT INTO admin_audit_log (id, actor_user_id, actor_email, action, target_type, target_id) VALUES ('a1', 'u-gone', 'gone@example.com', 'grant_ink', 'user', 'u-active')",
  ).run();
  db.prepare("INSERT INTO webhook_events (event_id, type, processed_at) VALUES ('evt_1', 'invoice.paid', ?)").run(NOW);
  return db;
}

function mainDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  for (const f of readdirSync(MAIN_MIGRATIONS).filter(f => f.endsWith(".sql")).sort()) {
    db.exec(readFileSync(`${MAIN_MIGRATIONS}/${f}`, "utf8"));
  }
  return db;
}

describe("auth-import", () => {
  it("copies the users mirror with standing derived from moderation", () => {
    const { statements, counts } = buildImportStatements(authDb(), NOW);
    const main = mainDb();
    for (const s of statements) main.exec(s);

    expect(counts.users).toBe(4);
    const rows = main.prepare("SELECT id, email, name, is_admin, email_verified, status, suspended_until, first_seen_at, synced_at FROM users ORDER BY id").all();
    expect(rows).toEqual([
      { id: "u-active", email: "a@example.com", name: "Ann O'Neil", is_admin: 1, email_verified: 1, status: "active", suspended_until: null, first_seen_at: Date.parse("2025-01-02T03:04:05.000Z"), synced_at: NOW },
      { id: "u-disabled", email: "d@example.com", name: "Dee", is_admin: 0, email_verified: 0, status: "disabled", suspended_until: null, first_seen_at: Date.parse("2025-02-01T00:00:00.000Z"), synced_at: NOW },
      { id: "u-expired", email: "e@example.com", name: "Ed", is_admin: 0, email_verified: 1, status: "active", suspended_until: null, first_seen_at: Date.parse("2025-04-01T00:00:00.000Z"), synced_at: NOW },
      { id: "u-suspended", email: "s@example.com", name: "Sue", is_admin: 0, email_verified: 1, status: "suspended", suspended_until: NOW_S + 3600, first_seen_at: Date.parse("2025-03-01T00:00:00.000Z"), synced_at: NOW },
    ]);
  });

  it("copies billing, preferences, deletions, history, audit and webhook markers", () => {
    const { statements, counts } = buildImportStatements(authDb(), NOW);
    const main = mainDb();
    for (const s of statements) main.exec(s);

    expect(counts).toMatchObject({ user_billing: 1, user_preferences: 1, user_deletions: 1, user_moderation_events: 1, admin_audit_log: 1, webhook_events: 1 });
    expect(main.prepare("SELECT stripe_customer_id, personal_plan FROM user_billing WHERE user_id = 'u-active'").get())
      .toEqual({ stripe_customer_id: "cus_1", personal_plan: "ink" });
    expect(main.prepare("SELECT reading_font, badges, bio, handle, handle_locked, theme_mode FROM user_preferences WHERE user_id = 'u-active'").get())
      .toEqual({ reading_font: "serif", badges: 5, bio: "it's me", handle: "ann", handle_locked: 1, theme_mode: "light" });
    expect(main.prepare("SELECT id, confirm_site_ids, completed_at FROM user_deletions WHERE user_id = 'u-disabled'").get())
      .toEqual({ id: "del-1", confirm_site_ids: "[\"p1\"]", completed_at: null });
    // Audit rows keep actors that no longer exist (no FK).
    expect(main.prepare("SELECT actor_email FROM admin_audit_log WHERE id = 'a1'").get()).toEqual({ actor_email: "gone@example.com" });
    expect(main.prepare("SELECT type FROM webhook_events WHERE event_id = 'evt_1'").get()).toEqual({ type: "invoice.paid" });
  });

  it("is safe to re-run and never overwrites rows Annex wrote since", () => {
    const { statements } = buildImportStatements(authDb(), NOW);
    const main = mainDb();
    for (const s of statements) main.exec(s);
    main.prepare("UPDATE user_preferences SET reading_font = 'mono' WHERE user_id = 'u-active'").run();
    for (const s of statements) main.exec(s);
    expect(main.prepare("SELECT reading_font FROM user_preferences WHERE user_id = 'u-active'").get()).toEqual({ reading_font: "mono" });
    expect(main.prepare("SELECT COUNT(*) AS n FROM users").get()).toEqual({ n: 4 });
  });

  it("quotes values safely", () => {
    expect(sqlValue(null)).toBe("NULL");
    expect(sqlValue(42)).toBe("42");
    expect(sqlValue("a'b")).toBe("'a''b'");
    expect(() => sqlValue(Number.NaN)).toThrow();
    expect(() => sqlValue({})).toThrow();
  });

  it("maps moderation values to standing", () => {
    expect(standingFromModeration(0, NOW)).toEqual({ status: "active", suspendedUntil: null });
    expect(standingFromModeration(-1, NOW)).toEqual({ status: "disabled", suspendedUntil: null });
    expect(standingFromModeration(NOW_S + 1, NOW)).toEqual({ status: "suspended", suspendedUntil: NOW_S + 1 });
    expect(standingFromModeration(NOW_S - 1, NOW)).toEqual({ status: "active", suspendedUntil: null });
  });
});
