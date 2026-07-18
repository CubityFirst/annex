import {
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type LazyExoticComponent,
  type ComponentType,
} from "react";
import { LandingPage } from "../LandingPage";
import "./AnimationsTestPage.css";

// /test/animations — dev-only playground for landing-page background
// animations. Renders the REAL LandingPage (background made transparent via
// AnimationsTestPage.css) above a swappable animation layer. The layer can
// cover the entire page or be confined to one landing section (hero / ink):
// scoped areas render inside a clipped, transformed wrapper glued over the
// live section, which becomes the containing block for the variants'
// position:fixed layers. Variant + area are kept in the URL hash so a
// specific idea can be linked/bookmarked, e.g. /test/animations#flow-field
// or /test/animations#constellation@hero

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

type Scope = {
  id: string;
  name: string;
  /** Landing-page section the layer is confined to; null = entire page. */
  selector: string | null;
};

const SCOPES: Scope[] = [
  { id: "page", name: "page", selector: null },
  { id: "hero", name: "hero", selector: ".l-hero" },
  { id: "ink", name: "ink", selector: ".l-ink" },
];

// Hash format: #<variant>[@<area>], e.g. #constellation@hero
function parseHash(): { variant: string; scope: string } {
  const [variant, scope] = window.location.hash.replace(/^#/, "").split("@");
  return {
    variant: VARIANTS.some((v) => v.id === variant) ? variant : "off",
    scope: SCOPES.some((s) => s.id === scope) ? scope : "page",
  };
}

function writeHash(variant: string, scope: string) {
  const hash =
    variant === "off" && scope === "page"
      ? "#"
      : scope === "page"
        ? `#${variant}`
        : `#${variant}@${scope}`;
  history.replaceState(null, "", hash);
}

export function AnimationsTestPage() {
  const [activeId, setActiveId] = useState(() => parseHash().variant);
  const [scopeId, setScopeId] = useState(() => parseHash().scope);
  const [open, setOpen] = useState(true);
  const rootRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ top: number; height: number } | null>(null);

  useEffect(() => {
    const onHashChange = () => {
      const { variant, scope } = parseHash();
      setActiveId(variant);
      setScopeId(scope);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const scope = SCOPES.find((s) => s.id === scopeId) ?? SCOPES[0];

  // Keep the scoped wrapper glued to its section (top/height relative to the
  // page root). Observing the root too catches reflows above the section.
  useLayoutEffect(() => {
    const root = rootRef.current;
    const section = scope.selector ? root?.querySelector(scope.selector) : null;
    if (!root || !section) {
      setBox(null);
      return;
    }
    const measure = () => {
      const rootTop = root.getBoundingClientRect().top;
      const rect = section.getBoundingClientRect();
      setBox({ top: rect.top - rootTop, height: rect.height });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(section);
    ro.observe(root);
    return () => ro.disconnect();
  }, [scope]);

  const select = (id: string) => {
    setActiveId(id);
    writeHash(id, scopeId);
  };
  const selectScope = (id: string) => {
    setScopeId(id);
    writeHash(activeId, id);
  };

  const active = VARIANTS.find((v) => v.id === activeId) ?? VARIANTS[0];

  return (
    <div className="anim-test" ref={rootRef}>
      {active.Component && (
        <Suspense fallback={null}>
          {scope.selector === null ? (
            <active.Component key={active.id} />
          ) : box ? (
            <div className="at-scope" style={{ top: box.top, height: box.height }}>
              <active.Component key={`${active.id}@${scope.id}`} />
            </div>
          ) : null}
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
            <div className="at-scopes">
              <span className="at-scopes-label">area</span>
              {SCOPES.map((s) => (
                <button
                  key={s.id}
                  className={`at-scope-btn ${s.id === scopeId ? "at-scope-btn-active" : ""}`}
                  onClick={() => selectScope(s.id)}
                >
                  {s.name}
                </button>
              ))}
            </div>
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
