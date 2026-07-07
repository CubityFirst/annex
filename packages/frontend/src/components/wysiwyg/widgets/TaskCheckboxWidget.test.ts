import { describe, it, expect, afterEach } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { decorationField } from "../decorations";
import { rendererCtxFacet } from "../context/RendererContext";

// End-to-end widget test through a REAL EditorView: the decoration walker
// places the checkbox widget, and toggling it dispatches a doc change.

// CM's DOMObserver does `new ResizeObserver(...)`; the arrow-function mock in
// src/test/setup.ts is not constructible, so install a real class here.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;

let view: EditorView | undefined;

afterEach(() => {
  view?.destroy();
  view = undefined;
});

function makeView(doc: string, revealOnCursor: boolean): EditorView {
  const state = EditorState.create({
    doc,
    extensions: [
      markdown({ base: markdownLanguage }),
      rendererCtxFacet.of({ isPublic: false, revealOnCursor }),
      decorationField,
    ],
  });
  // Force a full parse (background parsing is idle-scheduled), then dispatch a
  // selection transaction so the decoration field rebuilds against the
  // now-complete tree.
  ensureSyntaxTree(state, doc.length, 5000);
  const v = new EditorView({ state, parent: document.body });
  v.dispatch({ selection: { anchor: 0 } });
  return v;
}

function checkbox(v: EditorView): HTMLInputElement {
  const input = v.dom.querySelector<HTMLInputElement>("input.cm-task-checkbox");
  expect(input).not.toBeNull();
  return input!;
}

const flushMicrotasks = () => new Promise<void>((r) => setTimeout(r, 0));

describe("TaskCheckboxWidget - toggle dispatch via a real EditorView", () => {
  it("checking an unchecked task rewrites [ ] to [x]", () => {
    view = makeView("intro\n\n- [ ] buy milk", true);
    const input = checkbox(view);
    expect(input.checked).toBe(false);
    expect(input.disabled).toBe(false);

    input.checked = true;
    input.dispatchEvent(new Event("change"));

    expect(view.state.doc.toString()).toBe("intro\n\n- [x] buy milk");
  });

  it("unchecking a checked task rewrites [x] to [ ]", () => {
    view = makeView("intro\n\n- [x] done thing", true);
    const input = checkbox(view);
    expect(input.checked).toBe(true);

    input.checked = false;
    input.dispatchEvent(new Event("change"));

    expect(view.state.doc.toString()).toBe("intro\n\n- [ ] done thing");
  });

  it("the toggle targets the checkbox's own line when there are several tasks", () => {
    view = makeView("intro\n\n- [ ] first\n- [ ] second", true);
    const inputs = view.dom.querySelectorAll<HTMLInputElement>("input.cm-task-checkbox");
    expect(inputs.length).toBe(2);

    inputs[1]!.checked = true;
    inputs[1]!.dispatchEvent(new Event("change"));

    expect(view.state.doc.toString()).toBe("intro\n\n- [ ] first\n- [x] second");
  });

  it("reading mode renders the checkbox disabled (no toggle dispatch wired)", () => {
    view = makeView("- [ ] read only", false);
    const input = checkbox(view);
    expect(input.disabled).toBe(true);

    input.dispatchEvent(new Event("change"));
    expect(view.state.doc.toString()).toBe("- [ ] read only");
  });
});

describe("TaskCheckboxWidget - accessible name (W-L1)", () => {
  it("uses the task's own text as aria-label", async () => {
    view = makeView("intro\n\n- [ ] buy milk", true);
    const input = checkbox(view);
    // The label resolves on a microtask after the widget is attached.
    await flushMicrotasks();
    expect(input.getAttribute("aria-label")).toBe("buy milk");
  });

  it("falls back to a generic label for an empty task text", async () => {
    // "intro" keeps the cursor (at 0) off the task line so the widget renders.
    view = makeView("intro\n\n- [ ] ", true);
    const input = checkbox(view);
    await flushMicrotasks();
    expect(input.getAttribute("aria-label")).toBe("Task");
  });
});
