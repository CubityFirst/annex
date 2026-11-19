import { describe, it, expect } from "vitest";
import {
  getModerationState,
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

describe("latestModerationSummary vs datetime('now') strings (AF-C1)", () => {
  const base: AdminUser = {
    id: "u-1",
    email: "a@x.com",
    name: "A",
    created_at: "2026-01-01T00:00:00.000Z",
    moderation: -1,
    force_password_change: 0,
    email_verified: 1,
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
