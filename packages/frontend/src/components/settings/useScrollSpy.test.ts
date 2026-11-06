import { describe, it, expect } from "vitest";
import { pickActiveSection, readingLine } from "./useScrollSpy";
import { resolveOutline, type SettingsGroupDef, type SettingsSectionDef } from "./SettingsShell";

describe("pickActiveSection", () => {
  const ids = ["account", "favourites", "billing", "sessions", "danger"];
  // 1000px viewport -> reading line at min(20%, 160px) = 160px.
  const geo = (tops: Record<string, number>, scrollTop: number, maxScroll = 3000) => ({
    tops: new Map(Object.entries(tops)),
    viewportHeight: 1000,
    maxScroll,
    scrollTop,
  });

  it("puts the reading line near the top, capped for tall viewports", () => {
    expect(readingLine(600)).toBe(120);
    expect(readingLine(1000)).toBe(160);
    expect(readingLine(2000)).toBe(160);
  });

  it("returns the last section whose top has crossed the reading line", () => {
    expect(pickActiveSection(ids, geo({ account: -800, favourites: -100, billing: 150, sessions: 900, danger: 1300 }, 900))).toBe("billing");
    expect(pickActiveSection(ids, geo({ account: -800, favourites: -100, billing: 200, sessions: 900, danger: 1300 }, 900))).toBe("favourites");
  });

  it("keeps a short section at the top active while the next one is in view below it", () => {
    // Round-3 bug: Favourites scrolled to the top, Billing ~200px below it.
    expect(pickActiveSection(ids, geo({ account: -900, favourites: 24, billing: 210, sessions: 1400, danger: 1800 }, 900))).toBe("favourites");
  });

  it("falls back to the first present section before anything crosses the line", () => {
    expect(pickActiveSection(ids, geo({ account: 500, favourites: 1200 }, 0))).toBe("account");
  });

  it("respects the supplied id order and skips missing ids", () => {
    expect(pickActiveSection(["billing", "account"], geo({ account: 0 }, 0))).toBe("account");
  });

  it("doesn't hand the highlight to a trailing section just because the page is clamped at the bottom", () => {
    // Round-3 bug: API keys / Sessions at the top, Danger zone in the lower
    // half of the viewport, scrolled all the way down -> Danger was selected.
    expect(pickActiveSection(ids, geo({ account: -2400, favourites: -1600, billing: -900, sessions: 24, danger: 620 }, 3000))).toBe("sessions");
  });

  it("lets the last section win at the bottom only once it's in the upper half", () => {
    expect(pickActiveSection(ids, geo({ account: -2400, favourites: -1600, billing: -900, sessions: -200, danger: 400 }, 3000))).toBe("danger");
    // Same geometry but not at the bottom yet: the line rule applies.
    expect(pickActiveSection(ids, geo({ account: -2400, favourites: -1600, billing: -900, sessions: -200, danger: 400 }, 2500))).toBe("sessions");
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

  it("keeps single-section groups as labelled groups and separates an all-danger group", () => {
    const sections: SettingsSectionDef[] = [
      { id: "general", label: "General", group: "site" },
      { id: "members", label: "Members", group: "people" },
      { id: "danger", label: "Danger Zone", group: "danger", danger: true },
    ];
    const resolved = resolveOutline(groups, sections);
    expect(resolved.map(g => [g.label, g.sections.map(s => s.id)])).toEqual([
      ["Site", ["general"]],
      ["People", ["members"]],
      ["Danger Zone", ["danger"]],
    ]);
    expect(resolved.map(g => g.separated)).toEqual([false, false, true]);
  });

  it("lets a group opt out of (or into) separation explicitly", () => {
    const sections: SettingsSectionDef[] = [
      { id: "general", label: "General", group: "site" },
      { id: "danger", label: "Danger Zone", group: "danger", danger: true },
    ];
    const resolved = resolveOutline(
      [{ id: "site", label: "Site", separated: true }, { id: "danger", label: "Danger Zone", separated: false }],
      sections,
    );
    expect(resolved.map(g => g.separated)).toEqual([true, false]);
  });
});
