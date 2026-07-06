import { describe, it, expect } from "vitest";
import {
  getModerationState,
  mergeDateAndTime,
  formatTimeInput,
  latestModerationSummary,
} from "./moderation";
import { formatDateTime } from "./format";
import type { AdminUser } from "./api";

describe("getModerationState boundaries", () => {
  const nowMs = 1_750_000_000_000;
  const nowSeconds = Math.floor(nowMs / 1000);

  it("0 is active", () => {
    expect(getModerationState(0, nowMs)).toEqual({ kind: "active" });
  });
  it("-1 is disabled", () => {
    expect(getModerationState(-1, nowMs)).toEqual({ kind: "disabled" });
  });
  it("a future timestamp is suspended", () => {
    expect(getModerationState(nowSeconds + 60, nowMs)).toEqual({ kind: "suspended", until: nowSeconds + 60 });
  });
  it("an elapsed timestamp is active again (boundary: exactly now)", () => {
    expect(getModerationState(nowSeconds, nowMs)).toEqual({ kind: "active" });
    expect(getModerationState(nowSeconds - 1, nowMs)).toEqual({ kind: "active" });
  });
});

describe("mergeDateAndTime", () => {
  it("applies the HH:MM onto the date, zeroing seconds", () => {
    const date = new Date(2026, 6, 5, 23, 59, 58, 999);
    const merged = mergeDateAndTime(date, "09:30");
    expect(merged.getFullYear()).toBe(2026);
    expect(merged.getMonth()).toBe(6);
    expect(merged.getDate()).toBe(5);
    expect(merged.getHours()).toBe(9);
    expect(merged.getMinutes()).toBe(30);
    expect(merged.getSeconds()).toBe(0);
  });

  it("treats unparsable time parts as 00:00", () => {
    const merged = mergeDateAndTime(new Date(2026, 0, 1), "junk");
    expect(merged.getHours()).toBe(0);
    expect(merged.getMinutes()).toBe(0);
  });

  it("round-trips through formatTimeInput", () => {
    const date = new Date(2026, 3, 2, 7, 5);
    expect(formatTimeInput(date)).toBe("07:05");
  });
});

describe("latestModerationSummary vs datetime('now') strings (AF-C1)", () => {
  const base: AdminUser = {
    id: "u-1",
    email: "a@x.com",
    name: "A",
    created_at: "2026-01-01T00:00:00.000Z",
    moderation: -1,
    force_password_change: 0,
    latest_moderation_action: "disabled",
    latest_moderation_reason: "spam",
    latest_moderation_created_at: "2026-07-05 14:30:00",
  };

  it("formats the SQLite timestamp as UTC, matching the ISO rendering", () => {
    const summary = latestModerationSummary(base)!;
    expect(summary).toContain("Disabled on ");
    expect(summary).toContain(formatDateTime("2026-07-05T14:30:00.000Z"));
  });

  it("is null without a recorded event", () => {
    expect(latestModerationSummary({ ...base, latest_moderation_action: null })).toBeNull();
  });
});
