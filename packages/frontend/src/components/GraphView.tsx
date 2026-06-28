import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import ForceGraph2D, { type ForceGraphMethods, type NodeObject, type LinkObject } from "react-force-graph-2d";
import { X } from "lucide-react";
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
  radius: number;
  tagColor: string | null;
}

type GraphLink = LinkObject<GraphNode>;

function readCssVar(name: string): string {
  if (typeof window === "undefined") return "";
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v;
}

function useThemeTokens() {
  const [tokens, setTokens] = useState({ fg: "", muted: "", border: "", accent: "", uiFont: "" });
  useEffect(() => {
    const update = () => setTokens({
      fg: readCssVar("--foreground"),
      muted: readCssVar("--muted-foreground"),
      border: readCssVar("--border"),
      accent: readCssVar("--primary"),
      uiFont: readCssVar("--ui-font"),
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

export interface GraphViewProps {
  data: GraphData;
  onNodeClick: (id: string) => void;
}

export function GraphView({ data, onNodeClick }: GraphViewProps) {
  const { ref, width, height } = useContainerSize<HTMLDivElement>();
  const tokens = useThemeTokens();
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
        radius: 3 + Math.sqrt(n.links) * 0.8,
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
    charge?.strength?.(-90);
    const link = fg.d3Force("link") as unknown as {
      distance?: (n: number) => unknown;
      strength?: (n: number) => unknown;
    } | null;
    link?.distance?.(40);
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
  }, [graph, width, height]);

  const showLabels = zoom > 1.6;
  const fgColor = tokens.fg || "#111";
  const mutedColor = tokens.muted || "#888";
  const accentColor = tokens.accent || "#3b82f6";
  const uiFontStack = tokens.uiFont || "ui-sans-serif, system-ui, sans-serif";

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
          linkCanvasObject={(link, ctx) => {
            const src = link.source as GraphNode;
            const tgt = link.target as GraphNode;
            ctx.save();
            // Raised from 0.3 so links clear the 3:1 non-text contrast minimum
            // against the page background (WCAG 2.2 1.4.11).
            ctx.globalAlpha = 0.6;
            ctx.beginPath();
            ctx.moveTo(src.x ?? 0, src.y ?? 0);
            ctx.lineTo(tgt.x ?? 0, tgt.y ?? 0);
            ctx.strokeStyle = mutedColor;
            ctx.lineWidth = 1.5;
            ctx.stroke();
            ctx.restore();
          }}
          onZoom={t => setZoom(t.k)}
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
            const r = n.radius;
            const isHover = hoverId === n.id || selectedId === n.id;
            const nodeColor = isHover ? accentColor : (n.tagColor ?? mutedColor);
            ctx.beginPath();
            ctx.arc(n.x ?? 0, n.y ?? 0, r, 0, 2 * Math.PI);
            ctx.fillStyle = nodeColor;
            ctx.fill();

            if (showLabels || isHover) {
              const fontSize = Math.max(10 / globalScale, 2);
              ctx.font = `${fontSize}px ${uiFontStack}`;
              ctx.textAlign = "center";
              ctx.textBaseline = "top";
              const label = n.title;
              const padY = r + 2;
              ctx.fillStyle = isHover ? accentColor : fgColor;
              ctx.fillText(label, n.x ?? 0, (n.y ?? 0) + padY);
            }
          }}
          nodePointerAreaPaint={(node, color, ctx) => {
            const n = node as GraphNode;
            // On touch, floor the hit radius so low-link nodes still hit ~44px
            // diameter without pinch-zoom. minHit is in graph units (zoom-aware).
            const minHit = coarse ? 22 / Math.max(zoom, 0.01) : 0;
            const hitR = Math.max(n.radius + 2, minHit);
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(n.x ?? 0, n.y ?? 0, hitR, 0, 2 * Math.PI);
            ctx.fill();
          }}
        />
      )}
      {(data.tagColors?.length ?? 0) > 0 && (
        <ul
          aria-label="Tag color legend"
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
