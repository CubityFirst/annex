import { describe, it, expect } from "vitest";
import { pickActiveSection } from "./useScrollSpy";
import { resolveOutline, type SettingsGroupDef, type SettingsSectionDef } from "./SettingsShell";

describe("pickActiveSection", () => {
  const ids = ["account", "favourites", "billing", "sessions", "danger"];
  // 1000px viewport -> reading line at 350px; sweep zone is the last 650px.
  const geo = (tops: Record<string, number>, scrollTop: number, maxScroll = 3000) => ({
    tops: new Map(Object.entries(tops)),
    viewportHeight: 1000,
    maxScroll,
    scrollTop,
  });

  it("returns the last section whose top has crossed the reading line", () => {
    expect(pickActiveSection(ids, geo({ account: -800, favourites: -100, billing: 300, sessions: 900, danger: 1300 }, 900))).toBe("billing");
    expect(pickActiveSection(ids, geo({ account: -800, favourites: -100, billing: 400, sessions: 900, danger: 1300 }, 900))).toBe("favourites");
  });

  it("falls back to the first present section before anything crosses the line", () => {
    expect(pickActiveSection(ids, geo({ account: 500, favourites: 1200 }, 0))).toBe("account");
  });

  it("respects the supplied id order and skips missing ids", () => {
    expect(pickActiveSection(["billing", "account"], geo({ account: 0 }, 0))).toBe("account");
  });

  it("pins the last section when the container is clamped at the bottom", () => {
    // Danger zone's top never reaches the line - it's short and the page ends.
    expect(pickActiveSection(ids, geo({ account: -2400, favourites: -1600, billing: -900, sessions: 200, danger: 700 }, 3000))).toBe("danger");
  });

  it("sweeps the line down near the end so short trailing sections activate in order", () => {
    // 300px of scroll left: line = 350 + (650 - 300) = 700. Sessions (top 500)
    // has crossed it, Danger (top 1000) hasn't.
    expect(pickActiveSection(ids, geo({ account: -2100, favourites: -1300, billing: -600, sessions: 500, danger: 1000 }, 2700))).toBe("sessions");
  });

  it("keeps the fixed line (first section) when the container doesn't scroll", () => {
    expect(pickActiveSection(ids, geo({ account: 0, favourites: 400, billing: 700 }, 0, 0))).toBe("account");
  });

  it("returns null for an empty id list", () => {
    expect(pickActiveSection([], geo({}, 0))).toBeNull();
  });
});

describe("resolveOutline", () => {
  const groups: SettingsGroupDef[] = [
    { id: "site", label: "Site" },
    { id: "features", label: "Features" },
    { id: "people", label: "People" },
    { id: "danger", label: "Danger Zone" },
  ];

  it("attaches sections to groups preserving declared order", () => {
    const sections: SettingsSectionDef[] = [
      { id: "general", label: "General", group: "site" },
      { id: "publishing", label: "Publishing", group: "site" },
      { id: "features", label: "Features", group: "features" },
      { id: "members", label: "Members", group: "people" },
      { id: "danger", label: "Danger Zone", group: "danger", danger: true },
    ];
    const resolved = resolveOutline(groups, sections);
    expect(resolved.map(g => g.id)).toEqual(["site", "features", "people", "danger"]);
    expect(resolved[0].sections.map(s => s.id)).toEqual(["general", "publishing"]);
  });

  it("drops sections with visible: false", () => {
    const sections: SettingsSectionDef[] = [
      { id: "general", label: "General", group: "site" },
      { id: "publishing", label: "Publishing", group: "site", visible: false },
    ];
    const resolved = resolveOutline(groups, sections);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].sections.map(s => s.id)).toEqual(["general"]);
  });

  it("drops groups left with no visible sections (e.g. admin-only groups for a viewer)", () => {
    const sections: SettingsSectionDef[] = [
      { id: "general", label: "General", group: "site" },
      { id: "features", label: "Features", group: "features", visible: false },
      { id: "members", label: "Members", group: "people", visible: false },
      { id: "danger", label: "Danger Zone", group: "danger", danger: true, visible: true },
    ];
    const resolved = resolveOutline(groups, sections);
    expect(resolved.map(g => g.id)).toEqual(["site", "danger"]);
  });
});
