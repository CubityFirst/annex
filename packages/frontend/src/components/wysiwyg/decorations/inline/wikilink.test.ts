import { describe, it, expect } from "vitest";
import { LinkWidget } from "../../widgets/LinkWidget";
import { WikilinkWidget } from "../../widgets/WikilinkWidget";
import { stateFor, entriesFor, widgetsForDoc } from "../testSupport";

describe("visitWikilink - [[#anchor]] same-doc links (D17)", () => {
  const ctx = {
    currentDocId: "doc-1",
    buildUrl: (id: string, anchor?: string) => `/p/x/docs/${id}${anchor ? "#" + anchor : ""}`,
  };

  it("renders a link to the current doc's anchor", () => {
    const widgets = widgetsForDoc("[[#section-two]]", { ctx });
    const link = widgets.find((w) => w instanceof LinkWidget) as LinkWidget;
    expect(link).toBeDefined();
    expect(link.eq(new LinkWidget({ text: "#section-two", href: "/p/x/docs/doc-1#section-two" }))).toBe(true);
  });

  it("without a current doc it falls back to source styling", () => {
    const state = stateFor("[[#section-two]]");
    const widgets = widgetsForDoc("[[#section-two]]");
    expect(widgets.some((w) => w instanceof LinkWidget)).toBe(false);
    expect(widgets.some((w) => w instanceof WikilinkWidget)).toBe(false);
    expect(
      entriesFor(state).some((e) => e.deco.spec.class === "cm-wikilink-source"),
    ).toBe(true);
  });

  it("normal titled wikilinks still render the WikilinkWidget", () => {
    expect(widgetsForDoc("[[Some Doc]]", { ctx }).some((w) => w instanceof WikilinkWidget)).toBe(true);
    expect(widgetsForDoc("[[Doc#sec|Alias]]", { ctx }).some((w) => w instanceof WikilinkWidget)).toBe(true);
  });
});
