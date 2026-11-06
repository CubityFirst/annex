import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import ForceGraph2D, { type ForceGraphMethods, type NodeObject, type LinkObject } from "react-force-graph-2d";
import { Maximize2, Minus, Plus, X } from "lucide-react";
import { converter, formatHex } from "culori";
import { Button } from "@/components/ui/button";

export interface GraphData {
  nodes: { id: string; title: string; links: number; tags?: string[] }[];
  edges: { source: string; target: string }[];
  tagColors?: { tag: string; color: string }[];
}

interface GraphNode extends NodeObject {
  id: string;
  title: string;
  links: number;
  tags: string[];
  /** Graph-unit radius, scaled by link count (see NODE_MIN_PX/NODE_MAX_PX). */
  radius: number;
  tagColor: string | null;
}

// On-screen node radius range (px) at the capped zoom: the least-linked page
// gets NODE_MIN_PX, the most-linked NODE_MAX_PX, sqrt-scaled in between.
const NODE_MIN_PX = 5;
const NODE_MAX_PX = 11;
// Full-size views never zoom-to-fit past this; node sizes are specified here.
const FULL_VIEW_MAX_ZOOM = 2.4;
// Opacity of nodes/labels unrelated to the hovered node.
const FADED_ALPHA = 0.4;

function endpointId(end: GraphLink["source"]): string {
  return typeof end === "object" && end !== null ? String((end as GraphNode).id) : String(end);
}

type GraphLink = LinkObject<GraphNode>;

function readCssVar(name: string): string {
  if (typeof window === "undefined") return "";
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v;
}

// Canvas 2D may not parse oklch(); hand it a plain hex.
const toRgb = converter("rgb");
function toCanvasColor(css: string): string {
  if (!css) return "";
  const c = toRgb(css);
  return c ? formatHex(c) : css;
}

/** The colour actually painted behind `el`: its own or its nearest ancestor's
 *  opaque background, as hex (the label halo must match the surface the
 *  canvas sits on - the page, a card or a panel). Empty when none is found. */
function effectiveBackground(el: HTMLElement | null): string {
  if (typeof window === "undefined") return "";
  for (let cur = el; cur; cur = cur.parentElement) {
    const c = toRgb(getComputedStyle(cur).backgroundColor);
    if (c && (c.alpha ?? 1) > 0.5) return formatHex(c);
  }
  return "";
}

function useThemeTokens() {
  const [tokens, setTokens] = useState({ fg: "", muted: "", border: "", accent: "", uiFont: "", bg: "" });
  useEffect(() => {
    const update = () => setTokens({
      fg: readCssVar("--foreground"),
      muted: readCssVar("--muted-foreground"),
      border: readCssVar("--border"),
      accent: readCssVar("--primary"),
      uiFont: readCssVar("--ui-font"),
      bg: toCanvasColor(readCssVar("--background")),
    });
    update();
    // Watch class (theme) and style (font-var) on <html>; main.tsx/DocsLayout
    // rewrite the font-var inline when the user picks a new UI font.
    const obs = new MutationObserver(update);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] });
    return () => obs.disconnect();
  }, []);
  return tokens;
}

function useContainerSize<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    if (!ref.current) return;
    const el = ref.current;
    const ro = new ResizeObserver(entries => {
      for (const e of entries) {
        const cr = e.contentRect;
        setSize({ width: Math.floor(cr.width), height: Math.floor(cr.height) });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, ...size };
}

/** Centre of the nodes' bounding box (graph units), or null before layout. */
function boundingBoxCenter(nodes: GraphNode[]): { x: number; y: number } | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    if (n.x == null || n.y == null) continue;
    minX = Math.min(minX, n.x);
    maxX = Math.max(maxX, n.x);
    minY = Math.min(minY, n.y);
    maxY = Math.max(maxY, n.y);
  }
  if (!Number.isFinite(minX)) return null;
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
}

/** True when more of a node's edges arrive from below than from above, so
 *  its label should sit above the node instead of in the default slot below.
 *  Only steep edges count - a near-horizontal link never reaches the label. */
export function labelGoesAbove(
  node: { x?: number; y?: number },
  neighbours: Set<string> | undefined,
  byId: Map<string, { x?: number; y?: number }>,
): boolean {
  if (!neighbours || node.x == null || node.y == null) return false;
  let below = 0;
  let above = 0;
  for (const id of neighbours) {
    const other = byId.get(id);
    if (!other || other.x == null || other.y == null) continue;
    const dx = other.x - node.x;
    const dy = other.y - node.y;
    if (Math.abs(dy) < Math.abs(dx) * 0.5) continue;
    if (dy > 0) below++;
    else above++;
  }
  return below > above;
}

export interface GraphViewProps {
  data: GraphData;
  onNodeClick: (id: string) => void;
  /** Full-size views (graph page, expanded dialog): zoom/fit controls, labels always on. */
  showControls?: boolean;
  /** Built-in top-left tag-colour legend. The graph page turns it off and
   *  renders its own summary card (counts + legend) in that corner. */
  showLegend?: boolean;
}

export function GraphView({ data, onNodeClick, showControls = false, showLegend = true }: GraphViewProps) {
  const { ref, width, height } = useContainerSize<HTMLDivElement>();
  const tokens = useThemeTokens();
  // Label-halo colour: the surface the canvas actually sits on (re-read when
  // the theme tokens change), falling back to the page background token.
  const [surfaceBg, setSurfaceBg] = useState("");
  useEffect(() => { setSurfaceBg(effectiveBackground(ref.current)); }, [ref, tokens, width, height]);
  const haloColor = surfaceBg || tokens.bg;
  const fgRef = useRef<ForceGraphMethods<GraphNode, GraphLink> | undefined>(undefined);
  const [zoom, setZoom] = useState(1);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [coarse, setCoarse] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Coarse (touch) pointers get a two-step tap-to-preview-then-open flow and
  // enlarged hit targets; fine pointers keep the desktop immediate-navigate.
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(pointer: coarse)");
    const update = () => setCoarse(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  const listRef = useRef<HTMLUListElement | null>(null);

  const graph = useMemo(() => {
    const rules = data.tagColors ?? [];
    const maxLinks = data.nodes.reduce((max, n) => Math.max(max, n.links), 0);
    const nodes: GraphNode[] = data.nodes.map(n => {
      const tags = n.tags ?? [];
      let tagColor: string | null = null;
      for (const rule of rules) {
        if (rule.tag && tags.includes(rule.tag)) {
          tagColor = rule.color;
          break;
        }
      }
      return {
        id: n.id,
        title: n.title,
        links: n.links,
        tags,
        radius: (NODE_MIN_PX + (NODE_MAX_PX - NODE_MIN_PX) * (maxLinks > 0 ? Math.sqrt(n.links / maxLinks) : 0)) / FULL_VIEW_MAX_ZOOM,
        tagColor,
      };
    });
    const links: GraphLink[] = data.edges.map(e => ({ source: e.source, target: e.target }));
    return { nodes, links };
  }, [data]);

  // Adjacency for the keyboard-accessible text equivalent: each node's connected
  // document titles. Derived from the raw id-based edges (graph.links may hold
  // node objects after the simulation resolves them).
  const adjacency = useMemo(() => {
    const titleById = new Map(graph.nodes.map(n => [n.id, n.title] as const));
    const map = new Map<string, string[]>();
    for (const n of graph.nodes) map.set(n.id, []);
    for (const e of data.edges) {
      const s = String(e.source);
      const t = String(e.target);
      if (titleById.has(s) && titleById.has(t)) {
        map.get(s)?.push(titleById.get(t)!);
        map.get(t)?.push(titleById.get(s)!);
      }
    }
    return map;
  }, [graph, data.edges]);

  // Id-based neighbours, for fading everything unrelated to the hovered node.
  const neighbourIds = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const e of data.edges) {
      const s = String(e.source);
      const t = String(e.target);
      if (!map.has(s)) map.set(s, new Set());
      if (!map.has(t)) map.set(t, new Set());
      map.get(s)!.add(t);
      map.get(t)!.add(s);
    }
    return map;
  }, [data.edges]);

  // The hub: the single most-linked page (first on ties), drawn in the accent
  // colour so the graph has an obvious centre of gravity.
  const hubId = useMemo(() => {
    let best: GraphNode | null = null;
    for (const n of graph.nodes) if (n.links > 0 && (!best || n.links > best.links)) best = n;
    return best?.id ?? null;
  }, [graph]);

  // The single id currently announced / highlighted (selection wins over hover).
  const currentId = selectedId ?? hoverId;
  const currentTitle = currentId
    ? graph.nodes.find(n => n.id === currentId)?.title ?? null
    : null;

  // Arrow-key navigation between the focusable node entries in the text list.
  const onListKeyDown = (e: ReactKeyboardEvent<HTMLUListElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const items = Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>("button[data-node-entry]") ?? [],
    );
    if (items.length === 0) return;
    const idx = items.indexOf(document.activeElement as HTMLButtonElement);
    if (idx === -1) return;
    e.preventDefault();
    const next = e.key === "ArrowDown" ? Math.min(idx + 1, items.length - 1) : Math.max(idx - 1, 0);
    items[next]?.focus();
  };

  // The pointer cursor is set on document.body during node hover, so we must
  // reset it both on click (navigation prevents a hover-out) and on unmount.
  useEffect(() => {
    return () => {
      if (typeof document !== "undefined") document.body.style.cursor = "";
    };
  }, []);

  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;
    const charge = fg.d3Force("charge") as unknown as { strength?: (n: number) => unknown } | null;
    // Full-size views spread the layout further so 13px labels have room
    // at the capped zoom and never sit on top of a neighbouring node.
    charge?.strength?.(showControls ? -260 : -90);
    const link = fg.d3Force("link") as unknown as {
      distance?: (n: number) => unknown;
      strength?: (n: number) => unknown;
    } | null;
    link?.distance?.(showControls ? 90 : 40);
    link?.strength?.(0.92);

    // Gravity - pull every node toward the origin so the graph stays bounded.
    type SimNode = { x?: number; y?: number; vx?: number; vy?: number };
    type GravityForce = ((alpha: number) => void) & { initialize?: (nodes: SimNode[]) => void };
    let simNodes: SimNode[] = [];
    const gravityFn: GravityForce = (alpha: number) => {
      for (const n of simNodes) {
        n.vx = (n.vx ?? 0) - (n.x ?? 0) * 0.095 * alpha;
        n.vy = (n.vy ?? 0) - (n.y ?? 0) * 0.095 * alpha;
      }
    };
    gravityFn.initialize = (nodes: SimNode[]) => { simNodes = nodes; };
    fg.d3Force("gravity", gravityFn as unknown as Parameters<typeof fg.d3Force>[1]);
    fg.d3ReheatSimulation();
  }, [graph, width, height, showControls]);

  const showLabels = showControls || zoom > 1.6;
  const fittedRef = useRef(false);
  useEffect(() => { fittedRef.current = false; }, [graph]);
  // ~80px of breathing room in full views leaves space for the labels that
  // overhang the outermost nodes; the small panel graph keeps a tight frame.
  const fitPadding = showControls ? 80 : 24;
  // zoomToFit, but never past a comfortable max: a 3-node graph would
  // otherwise be blown up until the nodes are the size of buttons.
  // Then re-centre on the node bounding box, so the cluster sits in the
  // middle of the stage even after the zoom cap kicks in.
  const fitGraph = () => {
    const fg = fgRef.current;
    if (!fg) return;
    fg.zoomToFit(400, fitPadding);
    setTimeout(() => {
      const cur = fgRef.current;
      if (!cur) return;
      const maxZoom = showControls ? FULL_VIEW_MAX_ZOOM : 4;
      if (cur.zoom() > maxZoom) cur.zoom(maxZoom, 250);
      const center = boundingBoxCenter(graph.nodes);
      if (center) cur.centerAt(center.x, center.y, 250);
    }, 420);
  };
  const nodeById = useMemo(() => new Map(graph.nodes.map(n => [n.id, n] as const)), [graph]);
  const fgColor = tokens.fg || "#111";
  const mutedColor = tokens.muted || "#888";
  const accentColor = tokens.accent || "#3b82f6";
  const uiFontStack = tokens.uiFont || "ui-sans-serif, system-ui, sans-serif";

  // While a node is hovered/selected, it and its direct neighbours stay at full
  // strength and everything else fades.
  const focusSet = currentId ? new Set([currentId, ...(neighbourIds.get(currentId) ?? [])]) : null;
  const isRelated = (id: string) => !focusSet || focusSet.has(id);
  // Drawn radius in graph units. Full-size views stop growing nodes past the
  // fit cap so zooming in reads as navigation, not a diagram of blobs.
  const drawnRadius = (n: GraphNode, globalScale: number) =>
    showControls ? (n.radius * Math.min(globalScale, FULL_VIEW_MAX_ZOOM)) / globalScale : n.radius;

  return (
    <div
      ref={ref}
      role="group"
      aria-label="Document graph"
      className="relative h-full w-full overflow-hidden"
    >
      {/* Live region announcing the currently highlighted/selected document. */}
      <div role="status" aria-live="polite" className="sr-only">
        {currentTitle ? `Selected document: ${currentTitle}` : ""}
      </div>

      {/* Keyboard-accessible text equivalent of the pointer-only canvas: the same
          documents and their links, reachable by Tab / Up-Down arrows, Enter to
          open. Visually hidden but focusable so it doesn't alter the layout. */}
      <ul
        ref={listRef}
        aria-label="Documents in this graph"
        className="sr-only"
        onKeyDown={onListKeyDown}
      >
        {graph.nodes.map(n => {
          const connections = adjacency.get(n.id) ?? [];
          const tagText = n.tags.length > 0 ? `, tags: ${n.tags.join(", ")}` : "";
          const linkText =
            connections.length > 0 ? `, links to: ${connections.join(", ")}` : ", no links";
          return (
            <li key={n.id}>
              <button
                type="button"
                data-node-entry
                aria-current={currentId === n.id ? "true" : undefined}
                onFocus={() => setHoverId(n.id)}
                onBlur={() => setHoverId(prev => (prev === n.id ? null : prev))}
                onClick={() => {
                  if (typeof document !== "undefined") document.body.style.cursor = "";
                  setHoverId(null);
                  setSelectedId(null);
                  onNodeClick(n.id);
                }}
              >
                {n.title}
                {currentId === n.id ? " (selected)" : ""}
                {tagText}
                {linkText}
              </button>
            </li>
          );
        })}
      </ul>

      {width > 0 && height > 0 && (
        <ForceGraph2D<GraphNode, GraphLink>
          ref={fgRef}
          graphData={graph}
          width={width}
          height={height}
          backgroundColor="transparent"
          cooldownTicks={120}
          warmupTicks={20}
          d3VelocityDecay={0.3}
          linkCanvasObject={(link, ctx, globalScale) => {
            // Resolve endpoints by id so the line always runs centre to centre,
            // even before the simulation has swapped ids for node objects.
            const src = nodeById.get(endpointId(link.source));
            const tgt = nodeById.get(endpointId(link.target));
            if (!src || !tgt) return;
            const touchesFocus = !!currentId && (endpointId(link.source) === currentId || endpointId(link.target) === currentId);
            ctx.save();
            // 0.6 keeps links above the 3:1 non-text contrast minimum against
            // the page background (WCAG 2.2 1.4.11); links of the hovered node
            // strengthen, unrelated ones fade with their nodes.
            ctx.globalAlpha = touchesFocus ? 0.9 : currentId ? 0.6 * FADED_ALPHA : 0.6;
            ctx.beginPath();
            ctx.moveTo(src.x ?? 0, src.y ?? 0);
            ctx.lineTo(tgt.x ?? 0, tgt.y ?? 0);
            ctx.strokeStyle = touchesFocus ? fgColor : mutedColor;
            // Constant ~1.5px on screen regardless of zoom.
            ctx.lineWidth = 1.5 / Math.max(globalScale, 1);
            ctx.stroke();
            ctx.restore();
          }}
          onZoom={t => setZoom(t.k)}
          // Frame the settled layout once, so a small graph fills a sensible
          // share of the stage instead of floating tiny in the middle.
          onEngineStop={() => {
            if (fittedRef.current) return;
            fittedRef.current = true;
            fitGraph();
          }}
          onNodeHover={(node) => {
            setHoverId(node?.id != null ? String(node.id) : null);
            if (typeof document !== "undefined") {
              document.body.style.cursor = node ? "pointer" : "";
            }
          }}
          onNodeClick={(node) => {
            if (node?.id == null) return;
            const id = String(node.id);
            // Touch: first tap selects (preview), second tap on the same node opens.
            if (coarse && id !== selectedId) {
              setSelectedId(id);
              setHoverId(id);
              return;
            }
            if (typeof document !== "undefined") document.body.style.cursor = "";
            setHoverId(null);
            setSelectedId(null);
            onNodeClick(id);
          }}
          onBackgroundClick={() => {
            setSelectedId(null);
            setHoverId(null);
          }}
          onNodeDragEnd={(node) => {
            // release the pin so the node drifts back under simulation forces
            node.fx = undefined;
            node.fy = undefined;
          }}
          nodeCanvasObject={(node, ctx, globalScale) => {
            const n = node as GraphNode;
            const r = drawnRadius(n, globalScale);
            const isHover = currentId === n.id;
            const isHub = hubId === n.id;
            const alpha = isRelated(n.id) ? 1 : FADED_ALPHA;
            const nodeColor = isHover || isHub ? accentColor : (n.tagColor ?? mutedColor);
            ctx.save();
            // A soft halo marks the hub (and the hovered node) beyond colour alone.
            if (isHub || isHover) {
              ctx.beginPath();
              ctx.arc(n.x ?? 0, n.y ?? 0, r + 3.5 / globalScale, 0, 2 * Math.PI);
              ctx.fillStyle = accentColor;
              ctx.globalAlpha = alpha * 0.22;
              ctx.fill();
            }
            ctx.globalAlpha = alpha;
            ctx.beginPath();
            ctx.arc(n.x ?? 0, n.y ?? 0, r, 0, 2 * Math.PI);
            ctx.fillStyle = nodeColor;
            ctx.fill();

            if (showLabels || isHover) {
              const fontSize = Math.max((showControls ? 13 : 10) / globalScale, 2);
              ctx.font = `500 ${fontSize}px ${uiFontStack}`;
              ctx.textAlign = "center";
              const label = n.title;
              // Put the label on whichever side (below by default, else
              // above) fewer edges arrive from, so links rarely cross it.
              const above = labelGoesAbove(n, neighbourIds.get(n.id), nodeById);
              // ~6px on screen between the node's edge and its label.
              const gap = r + (showControls ? 6 : 4) / globalScale;
              const x = n.x ?? 0;
              const y = (n.y ?? 0) + (above ? -gap : gap);
              ctx.textBaseline = above ? "bottom" : "top";
              // A halo in the surface colour knocks out any link passing
              // behind the glyphs, so edges read as running under the text,
              // never through it. ~3px each side on screen regardless of zoom,
              // and always opaque - a faded label still hides the link behind.
              if (haloColor) {
                ctx.globalAlpha = 1;
                ctx.strokeStyle = haloColor;
                ctx.lineWidth = 6 / globalScale;
                ctx.lineJoin = "round";
                ctx.miterLimit = 2;
                ctx.strokeText(label, x, y);
              }
              // Muted labels by default; the hovered/selected page and the
              // hub read in full foreground.
              ctx.globalAlpha = alpha;
              ctx.fillStyle = isHover || isHub ? fgColor : mutedColor;
              ctx.fillText(label, x, y);
            }
            ctx.restore();
          }}
          nodePointerAreaPaint={(node, color, ctx) => {
            const n = node as GraphNode;
            // On touch, floor the hit radius so low-link nodes still hit ~44px
            // diameter without pinch-zoom. minHit is in graph units (zoom-aware).
            const k = Math.max(zoom, 0.01);
            const minHit = coarse ? 22 / k : 0;
            const hitR = Math.max(drawnRadius(n, k) + 2 / k, minHit);
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(n.x ?? 0, n.y ?? 0, hitR, 0, 2 * Math.PI);
            ctx.fill();
          }}
        />
      )}
      {showControls && (
        <div className="absolute bottom-4 right-4 flex flex-col overflow-hidden rounded-lg border border-border bg-popover/90 shadow-lg shadow-black/20 backdrop-blur">
          <Button variant="ghost" size="icon" className="size-9 rounded-none" aria-label="Zoom in" title="Zoom in"
            onClick={() => fgRef.current?.zoom(zoom * 1.3, 250)}>
            <Plus className="size-4" />
          </Button>
          <Button variant="ghost" size="icon" className="size-9 rounded-none border-t border-border" aria-label="Zoom out" title="Zoom out"
            onClick={() => fgRef.current?.zoom(zoom / 1.3, 250)}>
            <Minus className="size-4" />
          </Button>
          <Button variant="ghost" size="icon" className="size-9 rounded-none border-t border-border" aria-label="Fit graph" title="Fit graph"
            onClick={() => fitGraph()}>
            <Maximize2 className="size-3.5" />
          </Button>
        </div>
      )}
      {showControls && !coarse && (
        <p className="pointer-events-none absolute bottom-4 left-4 rounded-md border border-border bg-popover/80 px-2.5 py-1 text-xs text-muted-foreground shadow-sm backdrop-blur">
          Scroll to zoom &middot; drag to pan &middot; click a page to open it
        </p>
      )}
      {showLegend && (data.tagColors?.length ?? 0) > 0 && (
        <ul
          aria-label="Tag colour legend"
          className="pointer-events-none absolute left-2 top-2 flex max-w-[60%] flex-wrap gap-x-3 gap-y-1 rounded-md border bg-popover/80 px-2 py-1 text-xs text-muted-foreground shadow-sm backdrop-blur"
        >
          {data.tagColors!.map(rule => (
            <li key={rule.tag} className="flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className="inline-block size-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: rule.color }}
              />
              <span>{rule.tag}</span>
            </li>
          ))}
        </ul>
      )}
      {coarse && selectedId && (
        <div className="absolute inset-x-2 bottom-2 flex items-center gap-2 rounded-lg border bg-popover/95 p-2 shadow-md backdrop-blur pb-[env(safe-area-inset-bottom)]">
          <span className="min-w-0 flex-1 truncate text-sm">
            {graph.nodes.find(n => n.id === selectedId)?.title}
          </span>
          <Button
            size="sm"
            className="min-h-10 shrink-0"
            onClick={() => {
              const id = selectedId;
              if (typeof document !== "undefined") document.body.style.cursor = "";
              setSelectedId(null);
              setHoverId(null);
              if (id != null) onNodeClick(id);
            }}
          >
            Open
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="min-h-10 min-w-10"
            aria-label="Dismiss"
            onClick={() => {
              setSelectedId(null);
              setHoverId(null);
            }}
          >
            <X className="size-4" />
          </Button>
        </div>
      )}
    </div>
  );
}
