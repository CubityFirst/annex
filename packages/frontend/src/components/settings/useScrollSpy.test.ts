import { describe, it, expect } from "vitest";
import { pickActiveSection } from "./useScrollSpy";
import { resolveOutline, type SettingsGroupDef, type SettingsSectionDef } from "./SettingsShell";

describe("pickActiveSection", () => {
  const ids = ["account", "favourites", "billing"];

  it("returns the topmost (first in order) intersecting section", () => {
    const ratios = new Map([
      ["account", 0],
      ["favourites", 0.4],
      ["billing", 0.9],
    ]);
    expect(pickActiveSection(ids, ratios)).toBe("favourites");
  });

  it("ignores order in the map and respects the supplied id order", () => {
    const ratios = new Map([
      ["billing", 1],
      ["account", 0.2],
    ]);
    expect(pickActiveSection(ids, ratios)).toBe("account");
  });

  it("treats missing ids as ratio 0", () => {
    const ratios = new Map([["billing", 0.5]]);
    expect(pickActiveSection(ids, ratios)).toBe("billing");
  });

  it("returns null when nothing is intersecting", () => {
    const ratios = new Map([
      ["account", 0],
      ["favourites", 0],
      ["billing", 0],
    ]);
    expect(pickActiveSection(ids, ratios)).toBeNull();
  });

  it("returns null for an empty id list", () => {
    expect(pickActiveSection([], new Map())).toBeNull();
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
