import { describe, it, expect } from "vitest";
import { EditorState, EditorSelection } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { CalloutIconWidget } from "../widgets/CalloutIconWidget";
import { rendererCtxFacet } from "../context/RendererContext";
import { calloutFoldField, toggleCalloutFold } from "./calloutFold";
import { stateFor, widgetsForDoc, widgetsFor, lineClassesFor, visibleTextFor } from "./testSupport";

function icons(doc: string): CalloutIconWidget[] {
  return widgetsForDoc(doc).filter((w): w is CalloutIconWidget => w instanceof CalloutIconWidget);
}

describe("tryVisitCallout - open callouts", () => {
  it("renders the icon widget and hides the header prefix + quote markers", () => {
    const state = stateFor("> [!tip] Title\n> body");
    expect(widgetsFor(state).some((w) => w instanceof CalloutIconWidget)).toBe(true);
    expect(visibleTextFor(state)).toBe("Title\nbody");
  });

  it("stamps header/body/last line classes with the type's tone", () => {
    const classes = lineClassesFor(stateFor("> [!tip] Title\n> mid\n> end"));
    expect(classes.get(1)).toContain("cm-callout-header-line");
    expect(classes.get(1)).toContain("cm-callout-tone-teal");
    expect(classes.get(2)).toContain("cm-callout-body");
    expect(classes.get(3)).toContain("cm-callout-body--last");
  });

  it("a prefix with no title/space is hidden entirely", () => {
    expect(visibleTextFor(stateFor("> [!tip]"))).toBe("");
  });

  it("aliases resolve to the canonical tone", () => {
    const classes = lineClassesFor(stateFor("> [!hint] T"));
    expect(classes.get(1)).toContain("cm-callout-tone-teal"); // hint -> tip
  });

  it("an unknown type renders as a plain blockquote, not a callout", () => {
    const state = stateFor("> [!bogus] T");
    expect(widgetsFor(state).some((w) => w instanceof CalloutIconWidget)).toBe(false);
    expect(lineClassesFor(state).get(1)).toContain("cm-blockquote");
  });
});

describe("tryVisitCallout - collapsed callouts", () => {
  it("`-` collapses by default: body hidden, header text kept", () => {
    const state = stateFor("> [!warning]- Title\n> hidden body");
    expect(visibleTextFor(state)).toBe("Title\n");
    expect(widgetsFor(state).some((w) => w instanceof CalloutIconWidget)).toBe(true);
  });

  it("`+` defaults to open", () => {
    expect(visibleTextFor(stateFor("> [!tip]+ T\n> b"))).toBe("T\nb");
  });

  it("a fold toggle effect overrides the marker default in the rendered output", () => {
    const doc = "> [!warning]- T\n> body";
    let state = EditorState.create({
      doc,
      selection: EditorSelection.cursor(0),
      extensions: [
        markdown({ base: markdownLanguage }),
        rendererCtxFacet.of({ isPublic: false, revealOnCursor: false }),
        calloutFoldField,
      ],
    });
    ensureSyntaxTree(state, doc.length, 5000);
    expect(visibleTextFor(state)).toBe("T\n"); // `-` default: collapsed

    state = state.update({ effects: toggleCalloutFold.of({ from: 0, collapsed: false }) }).state;
    expect(visibleTextFor(state)).toBe("T\nbody"); // user expanded it
  });

  it("the cursor inside a `-` callout keeps it open and raw in editing mode", () => {
    const state = stateFor("> [!warning]- T\n> body", {
      ctx: { revealOnCursor: true },
      cursor: 20, // inside the body
    });
    expect(widgetsFor(state).some((w) => w instanceof CalloutIconWidget)).toBe(false);
    expect(visibleTextFor(state)).toBe("> [!warning]- T\n> body");
  });
});

describe("tryVisitCallout - nesting and indentation (D4/D5/D6/D21)", () => {
  it("a callout nested in a callout renders as its own callout", () => {
    const doc = "> [!note] outer\n> > [!tip] inner\n> body";
    expect(icons(doc)).toHaveLength(2);
    const state = stateFor(doc);
    expect(visibleTextFor(state)).toBe("outer\ninner\nbody");

    const classes = lineClassesFor(state);
    expect(classes.get(1)).toContain("cm-callout-tone-zinc"); // note
    expect(classes.get(2)).toContain("cm-callout-tone-teal"); // tip
    // The inner callout's lines are NOT double-stamped with the outer tone.
    expect(classes.get(2)).not.toContain("cm-callout-tone-zinc");
  });

  it("a callout inside a list item is recognized (indented markers)", () => {
    const doc = "- item:\n  > [!tip] hi\n  > body";
    expect(icons(doc)).toHaveLength(1);
    expect(visibleTextFor(stateFor(doc))).toBe("item:\n  hi\n  body");
  });

  it("nested plain quotes hide every `>` marker", () => {
    expect(visibleTextFor(stateFor("> outer\n> > inner"))).toBe("outer\ninner");
  });

  it("an indented (1-3 space) blockquote hides its marker too", () => {
    expect(visibleTextFor(stateFor("  > indented quote"))).toBe("  indented quote");
  });
});

describe("visitBlockquote - line class dedup (D21)", () => {
  it("nested quotes stamp one cm-blockquote per line", () => {
    const classes = lineClassesFor(stateFor("> outer\n> > inner"));
    expect(classes.get(1)).toEqual(["cm-blockquote"]);
    expect(classes.get(2)).toEqual(["cm-blockquote"]);
  });
});
