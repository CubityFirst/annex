import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { buildDecorations } from "./walker";
import { rendererCtxFacet } from "../context/RendererContext";
import { ExcalidrawEmbedWidget } from "../widgets/ExcalidrawEmbedWidget";
import { FileEmbedWidget } from "../widgets/FileEmbedWidget";
import { CodeFenceWidget } from "../widgets/CodeFenceWidget";
import { MermaidWidget } from "../widgets/MermaidWidget";

// Build a fully-parsed editor state for `doc` and return every block/inline
// widget the decoration walker emits. revealOnCursor:false forces decorations to
// apply regardless of cursor position so we test the rendered (not raw) output.
function widgetsFor(doc: string): unknown[] {
  const state = EditorState.create({
    doc,
    extensions: [
      markdown({ base: markdownLanguage }),
      rendererCtxFacet.of({ isPublic: false, revealOnCursor: false }),
    ],
  });
  // Force a complete parse so FencedCode nodes exist (the background parser is
  // viewport-limited otherwise).
  ensureSyntaxTree(state, doc.length, 5000);
  const decos = buildDecorations(state);
  const out: unknown[] = [];
  decos.between(0, doc.length, (_from, _to, deco) => {
    if (deco.spec.widget) out.push(deco.spec.widget);
  });
  return out;
}

describe("visitCodeFence - ```excalidraw embed", () => {
  it("a fence with a file id renders an ExcalidrawEmbedWidget", () => {
    const widgets = widgetsFor("```excalidraw\nfile-abc123\n```");
    expect(widgets.some((w) => w instanceof ExcalidrawEmbedWidget)).toBe(true);
    expect(widgets.some((w) => w instanceof CodeFenceWidget)).toBe(false);
  });

  it("the embedded id round-trips via widget equality", () => {
    const widgets = widgetsFor("```excalidraw\nfile-abc123\n```");
    const embed = widgets.find((w) => w instanceof ExcalidrawEmbedWidget) as ExcalidrawEmbedWidget;
    expect(embed).toBeDefined();
    expect(embed.eq(new ExcalidrawEmbedWidget("file-abc123"))).toBe(true);
    expect(embed.eq(new ExcalidrawEmbedWidget("other"))).toBe(false);
  });

  it("an empty excalidraw fence falls through to a code block", () => {
    const widgets = widgetsFor("```excalidraw\n\n```");
    expect(widgets.some((w) => w instanceof ExcalidrawEmbedWidget)).toBe(false);
    expect(widgets.some((w) => w instanceof CodeFenceWidget)).toBe(true);
  });

  it("a mermaid fence is unaffected", () => {
    const widgets = widgetsFor("```mermaid\ngraph TD; A-->B;\n```");
    expect(widgets.some((w) => w instanceof MermaidWidget)).toBe(true);
    expect(widgets.some((w) => w instanceof ExcalidrawEmbedWidget)).toBe(false);
  });
});

describe("visitCodeFence - ```file embed", () => {
  it("a fence with a file id renders a FileEmbedWidget", () => {
    const widgets = widgetsFor("```file\nfile-abc123\n```");
    expect(widgets.some((w) => w instanceof FileEmbedWidget)).toBe(true);
    expect(widgets.some((w) => w instanceof CodeFenceWidget)).toBe(false);
  });

  it("the embedded id round-trips via widget equality", () => {
    const widgets = widgetsFor("```file\nfile-abc123\n```");
    const embed = widgets.find((w) => w instanceof FileEmbedWidget) as FileEmbedWidget;
    expect(embed).toBeDefined();
    expect(embed.eq(new FileEmbedWidget("file-abc123"))).toBe(true);
    expect(embed.eq(new FileEmbedWidget("other"))).toBe(false);
  });

  it("an empty file fence falls through to a code block", () => {
    const widgets = widgetsFor("```file\n\n```");
    expect(widgets.some((w) => w instanceof FileEmbedWidget)).toBe(false);
    expect(widgets.some((w) => w instanceof CodeFenceWidget)).toBe(true);
  });

  it("an excalidraw fence is unaffected", () => {
    const widgets = widgetsFor("```excalidraw\nfile-abc123\n```");
    expect(widgets.some((w) => w instanceof ExcalidrawEmbedWidget)).toBe(true);
    expect(widgets.some((w) => w instanceof FileEmbedWidget)).toBe(false);
  });
});
