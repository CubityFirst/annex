import { describe, it, expect } from "vitest";
import { formatDateTime, initials, parseDbDate } from "./format";

describe("parseDbDate", () => {
  it("treats SQLite datetime('now') strings as UTC (AF-C1)", () => {
    // "2026-07-05 14:30:00" carries no zone; parsed as UTC it must equal the
    // same instant as the explicit-Z ISO form.
    const sqlite = parseDbDate("2026-07-05 14:30:00");
    const iso = new Date("2026-07-05T14:30:00Z");
    expect(sqlite.getTime()).toBe(iso.getTime());
  });

  it("leaves ISO strings (with zone) alone", () => {
    const d = parseDbDate("2026-07-05T14:30:00.000Z");
    expect(d.getTime()).toBe(Date.parse("2026-07-05T14:30:00.000Z"));
  });
});

describe("formatDateTime", () => {
  it("renders the SAME instant for the SQLite and ISO forms of one timestamp", () => {
    // This is the visible symptom the fix closes: the optimistic
    // post-mutation value (ISO) and the refetched one (SQLite form) used to
    // render hours apart for any non-UTC operator.
    expect(formatDateTime("2026-07-05 14:30:00")).toBe(formatDateTime("2026-07-05T14:30:00.000Z"));
  });

  it("falls back to the raw string for garbage", () => {
    expect(formatDateTime("not a date")).toBe("not a date");
  });
});

describe("initials", () => {
  it("uses first + last word", () => {
    expect(initials("Ada Lovelace King")).toBe("AK");
  });
  it("single word -> single letter", () => {
    expect(initials("Ada")).toBe("A");
  });
  it("empty -> placeholder", () => {
    expect(initials("  ")).toBe("?");
  });
});
