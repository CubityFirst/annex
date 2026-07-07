import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act, useEffect, type ReactElement } from "react";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, WidgetType } from "@codemirror/view";
import { ReactWidget } from "./ReactWidget";
import { rendererCtxFacet, useRendererCtx, type RendererCtx } from "../context/RendererContext";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// CM's DOMObserver does `new ResizeObserver(...)`; the arrow-function mock in
// src/test/setup.ts is not constructible, so install a real class here.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;

// --- test fixtures -------------------------------------------------------------

let mounts = 0;
let cleanups = 0;

function Probe({ label }: { label: string }) {
  const ctx = useRendererCtx();
  useEffect(() => {
    mounts++;
    return () => {
      cleanups++;
    };
  }, []);
  return (
    <span className="probe" data-project={ctx.projectId ?? "none"}>
      {label}
    </span>
  );
}

class TestWidget extends ReactWidget {
  protected tag: "span" = "span";

  constructor(
    private readonly label: string,
    private readonly reveal = false,
  ) {
    super();
  }

  protected render(): ReactElement {
    return <Probe label={this.label} />;
  }

  protected revealOnClick(): boolean {
    return this.reveal;
  }

  eq(other: WidgetType): boolean {
    return other instanceof TestWidget && other.label === this.label && other.reveal === this.reveal;
  }
}

class DivTestWidget extends ReactWidget {
  protected tag: "div" = "div";
  protected render(): ReactElement {
    return <Probe label="div" />;
  }
  eq(other: WidgetType): boolean {
    return other instanceof DivTestWidget;
  }
}

const ctxComp = new Compartment();
let view: EditorView;

function makeView(ctx: RendererCtx): EditorView {
  return new EditorView({
    state: EditorState.create({
      doc: "",
      extensions: [ctxComp.of(rendererCtxFacet.of(ctx))],
    }),
    parent: document.body,
  });
}

beforeEach(() => {
  mounts = 0;
  cleanups = 0;
  view = makeView({ isPublic: false, projectId: "p1" });
});

afterEach(() => {
  view.destroy();
});

// --- W-H1: DOM-keyed roots ------------------------------------------------------

describe("ReactWidget lifecycle - DOM-keyed roots (W-H1)", () => {
  it("destroy() via a different eq()-equal instance still unmounts the root", async () => {
    const a = new TestWidget("same");
    let dom!: HTMLElement;
    await act(async () => {
      dom = a.toDOM(view);
    });
    expect(mounts).toBe(1);
    expect(dom.querySelector(".probe")).not.toBeNull();

    // CM 6.42's findWidget adopts a reused tile's DOM onto a NEW eq()-equal
    // instance; destroy() is later called on that new instance. The root must
    // still be found (keyed by DOM, not stored on the instance).
    const b = new TestWidget("same");
    expect(b.eq(a)).toBe(true);
    await act(async () => {
      b.destroy(dom);
    });
    expect(cleanups).toBe(1);
  });

  it("destroy on a DOM element the family never mounted is a no-op", () => {
    const w = new TestWidget("x");
    expect(() => w.destroy(document.createElement("span"))).not.toThrow();
    expect(cleanups).toBe(0);
  });

  it("double destroy unmounts exactly once", async () => {
    const a = new TestWidget("once");
    let dom!: HTMLElement;
    await act(async () => {
      dom = a.toDOM(view);
    });
    await act(async () => {
      a.destroy(dom);
      a.destroy(dom);
    });
    expect(cleanups).toBe(1);
  });
});

// --- W-M2: real updateDOM --------------------------------------------------------

describe("ReactWidget lifecycle - updateDOM re-renders in place (W-M2)", () => {
  it("a non-eq instance of the same class adopts the DOM and re-renders without remounting", async () => {
    const a = new TestWidget("one");
    let dom!: HTMLElement;
    await act(async () => {
      dom = a.toDOM(view);
    });
    expect(dom.textContent).toBe("one");
    expect(mounts).toBe(1);

    const b = new TestWidget("two");
    let adopted!: boolean;
    await act(async () => {
      adopted = b.updateDOM(dom, view, a);
    });
    expect(adopted).toBe(true);
    expect(dom.textContent).toBe("two");
    // Same component position/type -> React updated, did not remount.
    expect(mounts).toBe(1);
    expect(cleanups).toBe(0);

    // The adopted instance's destroy still finds the root.
    await act(async () => {
      b.destroy(dom);
    });
    expect(cleanups).toBe(1);
  });

  it("declines when the tag differs", async () => {
    const a = new TestWidget("span-widget");
    let dom!: HTMLElement;
    await act(async () => {
      dom = a.toDOM(view);
    });
    const div = new DivTestWidget();
    expect(div.updateDOM(dom, view, a)).toBe(false);
    await act(async () => a.destroy(dom));
  });

  it("declines when revealOnClick differs from the previous instance", async () => {
    const a = new TestWidget("x", false);
    let dom!: HTMLElement;
    await act(async () => {
      dom = a.toDOM(view);
    });
    const b = new TestWidget("y", true);
    expect(b.updateDOM(dom, view, a)).toBe(false);
    await act(async () => a.destroy(dom));
  });

  it("declines on DOM it does not own", () => {
    const w = new TestWidget("x");
    expect(w.updateDOM(document.createElement("span"), view)).toBe(false);
  });
});

// --- W-H3: live ctx delivery ------------------------------------------------------

describe("ReactWidget lifecycle - live RendererCtx (W-H3)", () => {
  it("a ctx facet change reaches an already-mounted widget root", async () => {
    const w = new TestWidget("ctx");
    let dom!: HTMLElement;
    await act(async () => {
      dom = w.toDOM(view);
    });
    const probe = () => dom.querySelector<HTMLElement>(".probe")!;
    expect(probe().dataset.project).toBe("p1");

    // Reconfigure the facet - the facet-enabled ctxSyncPlugin must push the
    // new value into the per-view store, re-rendering the mounted root.
    await act(async () => {
      view.dispatch({
        effects: ctxComp.reconfigure(rendererCtxFacet.of({ isPublic: false, projectId: "p2" })),
      });
    });
    expect(probe().dataset.project).toBe("p2");

    await act(async () => w.destroy(dom));
  });

  it("ctx updates still arrive after the DOM was adopted by a new instance", async () => {
    const a = new TestWidget("adopt");
    let dom!: HTMLElement;
    await act(async () => {
      dom = a.toDOM(view);
    });
    const b = new TestWidget("adopted");
    await act(async () => {
      expect(b.updateDOM(dom, view, a)).toBe(true);
    });

    await act(async () => {
      view.dispatch({
        effects: ctxComp.reconfigure(rendererCtxFacet.of({ isPublic: false, projectId: "p3" })),
      });
    });
    expect(dom.querySelector<HTMLElement>(".probe")!.dataset.project).toBe("p3");

    await act(async () => b.destroy(dom));
  });
});
