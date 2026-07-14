import { lazy, Suspense, useEffect, useState, type LazyExoticComponent, type ComponentType } from "react";
import { LandingPage } from "../LandingPage";
import "./AnimationsTestPage.css";

// /test/animations — dev-only playground for landing-page background
// animations. Renders the REAL LandingPage (background made transparent via
// AnimationsTestPage.css) above a swappable full-viewport animation layer.
// The active variant is kept in the URL hash so a specific idea can be
// linked/bookmarked, e.g. /test/animations#constellation

type Variant = {
  id: string;
  name: string;
  description: string;
  Component: LazyExoticComponent<ComponentType> | null;
};

const VARIANTS: Variant[] = [
  {
    id: "off",
    name: "Off (current page)",
    description: "No background animation — the landing page as it ships today.",
    Component: null,
  },
  {
    id: "ink-particles",
    name: "Ink Particles",
    description: "Sparse ink motes drifting slowly through the dark, with depth variance.",
    Component: lazy(() => import("./animations/InkParticles")),
  },
  {
    id: "constellation",
    name: "Constellation",
    description: "A faint doc-graph: drifting nodes with distance-faded linking lines.",
    Component: lazy(() => import("./animations/Constellation")),
  },
  {
    id: "flow-field",
    name: "Flow Field",
    description: "Streamlines slowly drawing themselves and fading, like ink in a current.",
    Component: lazy(() => import("./animations/FlowField")),
  },
  {
    id: "aurora-blobs",
    name: "Aurora Blobs",
    description: "Huge blurred gradient blobs morphing very slowly (Ink-gradient tinted).",
    Component: lazy(() => import("./animations/AuroraBlobs")),
  },
  {
    id: "beam-sweep",
    name: "Beam Sweep",
    description: "A soft diagonal light beam sweeping across the page every ~12s.",
    Component: lazy(() => import("./animations/BeamSweep")),
  },
  {
    id: "paper-grain",
    name: "Paper Grain",
    description: "Barely-perceptible film-grain shimmer plus a slow breathing vignette.",
    Component: lazy(() => import("./animations/PaperGrain")),
  },
  {
    id: "dot-grid-pulse",
    name: "Dot Grid Pulse",
    description: "Faint graph-paper dots with a slow luminous wave travelling across.",
    Component: lazy(() => import("./animations/DotGridPulse")),
  },
  {
    id: "cursor-spotlight",
    name: "Cursor Spotlight",
    description: "A lagging radial glow following the mouse, revealing a faint dot grid.",
    Component: lazy(() => import("./animations/CursorSpotlight")),
  },
  {
    id: "starfield",
    name: "Starfield Dust",
    description: "Parallax layers of dust specks drifting sideways, occasional twinkle.",
    Component: lazy(() => import("./animations/Starfield")),
  },
  {
    id: "floating-glyphs",
    name: "Floating Glyphs",
    description: "Faint markdown glyphs (#, *, >, `) drifting upward and fading.",
    Component: lazy(() => import("./animations/FloatingGlyphs")),
  },
  {
    id: "ink-ripples",
    name: "Ink Ripples",
    description: "Occasional expanding rings, like ink drops landing in still water.",
    Component: lazy(() => import("./animations/InkRipples")),
  },
  {
    id: "topo-lines",
    name: "Topographic Lines",
    description: "Faint contour lines slowly undulating, like a living map.",
    Component: lazy(() => import("./animations/TopoLines")),
  },
];

function variantFromHash(): string {
  const hash = window.location.hash.replace(/^#/, "");
  return VARIANTS.some((v) => v.id === hash) ? hash : "off";
}

export function AnimationsTestPage() {
  const [activeId, setActiveId] = useState(variantFromHash);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    const onHashChange = () => setActiveId(variantFromHash());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const select = (id: string) => {
    setActiveId(id);
    history.replaceState(null, "", id === "off" ? "#" : `#${id}`);
  };

  const active = VARIANTS.find((v) => v.id === activeId) ?? VARIANTS[0];

  return (
    <div className="anim-test">
      {active.Component && (
        <Suspense fallback={null}>
          <active.Component key={active.id} />
        </Suspense>
      )}
      <LandingPage />
      <div className="at-panel">
        <div className="at-panel-head">
          <span className="at-panel-title">bg animations</span>
          <button className="at-panel-toggle" onClick={() => setOpen((o) => !o)}>
            {open ? "hide" : "show"}
          </button>
        </div>
        {open && (
          <>
            <div className="at-list">
              {VARIANTS.map((v) => (
                <button
                  key={v.id}
                  className={`at-item ${v.id === activeId ? "at-item-active" : ""}`}
                  onClick={() => select(v.id)}
                >
                  {v.name}
                </button>
              ))}
            </div>
            <div className="at-desc">{active.description}</div>
          </>
        )}
      </div>
    </div>
  );
}
