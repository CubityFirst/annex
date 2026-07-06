import { describe, it, expect } from "vitest";
import { encodeCursor, decodeCursor, buildAuditListQuery } from "./audit";

const CURSOR = { ts: "2026-05-17 12:34:56", id: "a1b2-c3d4" };

describe("audit cursor", () => {
  it("round-trips a (ts, id) position", () => {
    const cursor = { ts: "2026-05-17 12:34:56", id: "a1b2-c3d4" };
    const decoded = decodeCursor(encodeCursor(cursor));
    expect(decoded).toEqual(cursor);
  });

  it("produces a url-safe token (no +, /, or =)", () => {
    const token = encodeCursor({ ts: "2026-05-17 00:00:00", id: "????>>>>" });
    expect(token).not.toMatch(/[+/=]/);
  });

  it("returns null for a malformed cursor", () => {
    expect(decodeCursor("not-base64-$$$")).toBeNull();
  });

  it("returns null when the shape is wrong", () => {
    const bad = btoa(JSON.stringify({ ts: 123 })).replace(/=+$/, "");
    expect(decodeCursor(bad)).toBeNull();
  });
});

const NO_FILTERS = { actions: [] as string[], q: null };

describe("buildAuditListQuery", () => {
  it("has no WHERE and no binds for the first unfiltered page", () => {
    const { sql, binds } = buildAuditListQuery(null, NO_FILTERS);
    expect(sql).not.toContain("WHERE");
    expect(binds).toEqual([]);
    expect(sql).toContain("ORDER BY created_at DESC, id DESC");
  });

  it("emits the keyset predicate and binds for a cursor", () => {
    const { sql, binds } = buildAuditListQuery(CURSOR, NO_FILTERS);
    expect(sql).toContain("created_at < ? OR (created_at = ? AND id < ?)");
    expect(sql).not.toContain("action IN");
    expect(binds).toEqual([CURSOR.ts, CURSOR.ts, CURSOR.id]);
  });

  it("emits a single-element IN list for one action", () => {
    const { sql, binds } = buildAuditListQuery(null, { actions: ["user.ink.grant"], q: null });
    expect(sql).toContain("WHERE action IN (?)");
    expect(binds).toEqual(["user.ink.grant"]);
  });

  it("emits one placeholder per action for a mixed selection", () => {
    const { sql, binds } = buildAuditListQuery(null, {
      actions: ["user.ink.grant", "project.delete", "oauth_client.create"],
      q: null,
    });
    expect(sql).toContain("action IN (?, ?, ?)");
    expect(binds).toEqual(["user.ink.grant", "project.delete", "oauth_client.create"]);
  });

  it("emits a user-scope search across actor + target with one bind each", () => {
    const { sql, binds } = buildAuditListQuery(null, { actions: [], q: "alice@example.com" });
    expect(sql).toContain(
      "(actor_email LIKE ? ESCAPE '\\' OR actor_user_id LIKE ? ESCAPE '\\' OR target_id LIKE ? ESCAPE '\\')",
    );
    expect(binds).toEqual([
      "%alice@example.com%",
      "%alice@example.com%",
      "%alice@example.com%",
    ]);
  });

  it("escapes LIKE wildcards in the user-scope search", () => {
    const { binds } = buildAuditListQuery(null, { actions: [], q: "50%_x" });
    expect(binds).toEqual(["%50\\%\\_x%", "%50\\%\\_x%", "%50\\%\\_x%"]);
  });

  it("AND-combines cursor + actions + search with binds in SQL order", () => {
    const { sql, binds } = buildAuditListQuery(CURSOR, {
      actions: ["project.delete"],
      q: "bob",
    });
    expect(sql).toContain(
      "(created_at < ? OR (created_at = ? AND id < ?)) AND action IN (?) AND (actor_email LIKE ? ESCAPE '\\' OR actor_user_id LIKE ? ESCAPE '\\' OR target_id LIKE ? ESCAPE '\\')",
    );
    expect(binds).toEqual([
      CURSOR.ts,
      CURSOR.ts,
      CURSOR.id,
      "project.delete",
      "%bob%",
      "%bob%",
      "%bob%",
    ]);
  });
});
