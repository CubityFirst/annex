import React, { useRef, useCallback, useMemo, useState, useLayoutEffect } from "react";
import { GripVerticalIcon, ArrowUp, ArrowDown, ArrowUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import type { Layout } from "react-resizable-panels";
import type { SortDir } from "@/lib/fileSort";

interface SortSpec {
  colIdx: number;
  dir: SortDir;
}

export interface ColumnDef {
  label: string;
  defaultSize: number; // % for resizable columns; ignored for constrained (minWidth) columns
  minSize?: number;    // % minimum for resizable columns
  minWidth?: number;   // px - if set, column becomes a standalone fixed-width segment
  maxWidth?: number;   // px - maximum width for constrained columns (only used with minWidth)
  sortable?: boolean;  // when true (with onSort), the header is a clickable sort toggle
}

export interface CellDef {
  content: React.ReactNode;
  className?: string;
  onClick?: React.MouseEventHandler<HTMLDivElement>;
}

interface ResizableTableProps {
  columns: ColumnDef[];
  checkboxColumn?: boolean;
  storageKey?: string;
  /** Active sort (column index + direction), or null for none. */
  sort?: SortSpec | null;
  /** Called with the clicked column index when a sortable header is clicked. */
  onSort?: (colIdx: number) => void;
  /**
   * Opaque token derived from the rendered rows' content. When it changes, the
   * table re-measures and re-fits its constrained columns (see the auto-fit
   * effect). Pass a string/number that varies with the data shown in any
   * constrained (minWidth) column - e.g. a join of that column's cell text.
   */
  measureKey?: string | number;
  children: React.ReactNode;
}

// Header cell - a plain label, or a clickable sort toggle when the column is
// sortable and an onSort handler is provided. Used by both header branches
// (constrained segment and resizable-panel segment) so they stay consistent.
function HeaderCell({
  col,
  idx,
  colIndex,
  sort,
  onSort,
}: {
  col: ColumnDef;
  idx: number;
  /** 1-based ARIA grid column index (accounts for the checkbox column). */
  colIndex: number;
  sort?: SortSpec | null;
  onSort?: (colIdx: number) => void;
}) {
  const base = "flex items-center h-full w-full px-3 text-xs font-medium text-muted-foreground";

  if (!col.sortable || !onSort) {
    return <div role="columnheader" aria-colindex={colIndex} className={base}>{col.label}</div>;
  }

  const active = sort?.colIdx === idx;
  const dir = active ? sort!.dir : undefined;

  return (
    <button
      type="button"
      role="columnheader"
      aria-colindex={colIndex}
      aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}
      onClick={() => onSort(idx)}
      title={`Sort by ${col.label}`}
      aria-label={
        active
          ? `${col.label}, sorted ${dir === "asc" ? "ascending" : "descending"}`
          : `Sort by ${col.label}`
      }
      className={cn(base, "group gap-1 select-none text-left cursor-pointer hover:text-foreground transition-colors")}
    >
      <span className="truncate">{col.label}</span>
      {active ? (
        dir === "asc"
          ? <ArrowUp className="size-3 shrink-0" />
          : <ArrowDown className="size-3 shrink-0" />
      ) : (
        <ArrowUpDown className="size-3 shrink-0 opacity-0 group-hover:opacity-50 transition-opacity" />
      )}
    </button>
  );
}

interface ResizableTableRowProps {
  columns: ColumnDef[];
  cells: CellDef[];
  checkboxCell?: React.ReactNode;
  className?: string;
  draggable?: boolean;
  onDragStart?: React.DragEventHandler;
  onDragEnd?: React.DragEventHandler;
  onDragOver?: React.DragEventHandler;
  onDragLeave?: React.DragEventHandler;
  onDrop?: React.DragEventHandler<HTMLDivElement>;
  /**
   * Optional keyboard-activation handler. When provided the row becomes
   * operable: Enter/Space fire `onActivate` (after `preventDefault`). Pair with
   * `tabIndex={0}` to make the row focusable. Pointer activation still flows
   * through each cell's own `onClick`.
   */
  onActivate?: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  /** Forwarded to the row container, composed after the built-in Enter/Space handling. */
  onKeyDown?: React.KeyboardEventHandler<HTMLDivElement>;
  /** Forwarded to the row container so a consumer can make the row focusable. */
  tabIndex?: number;
  /** ARIA role for the row container. Defaults to `"row"` (keeps grid semantics). */
  role?: React.AriaRole;
  /** Accessible name for the row when it is focusable/operable. */
  "aria-label"?: string;
}

// ── Segment helpers ──────────────────────────────────────────────────────────

interface ResizableSegment {
  type: "resizable";
  cols: { col: ColumnDef; idx: number }[];
  segIdx: number;
  isLast: boolean;
  /** true when this segment came from a single column with minWidth/maxWidth */
  constrained: boolean;
  minPx: number;
  maxPx: number;
}
type Segment = ResizableSegment;

function buildSegments(columns: ColumnDef[]): Segment[] {
  const segments: Segment[] = [];
  let segIdx = 0;
  let current: { col: ColumnDef; idx: number }[] = [];

  const flush = (minPx = 50, maxPx = Infinity, constrained = false) => {
    if (current.length > 0) {
      segments.push({
        type: "resizable",
        cols: current,
        segIdx: segIdx++,
        isLast: false,
        constrained,
        minPx,
        maxPx,
      });
      current = [];
    }
  };

  for (let i = 0; i < columns.length; i++) {
    const col = columns[i];
    if (col.minWidth != null) {
      flush(); // flush preceding resizable columns
      current = [{ col, idx: i }];
      flush(col.minWidth, col.maxWidth ?? Infinity, true); // standalone constrained segment
    } else {
      current.push({ col, idx: i });
    }
  }
  flush();

  // Mark the last segment
  for (let i = segments.length - 1; i >= 0; i--) {
    segments[i].isLast = true;
    break;
  }

  return segments;
}

// ── ResizableTable ────────────────────────────────────────────────────────────

export function ResizableTable({ columns, checkboxColumn = true, storageKey, sort, onSort, measureKey, children }: ResizableTableProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const segments = useMemo(() => buildSegments(columns), [columns]);
  // Segments the user has manually dragged this session. The auto-fit effect
  // leaves these alone so re-measuring (on data change) never clobbers a width
  // the user set by hand. (Cross-session, the persisted `saved` width does the
  // same job; this covers the window before a reload.)
  const userResizedSegs = useRef<Set<number>>(new Set());

  const [saved] = useState<Record<string, string>>(() => {
    if (!storageKey) return {};
    try { return JSON.parse(localStorage.getItem(storageKey) ?? "{}") as Record<string, string>; }
    catch { return {}; }
  });

  const save = useCallback((key: string, value: string) => {
    if (!storageKey) return;
    try {
      const current = JSON.parse(localStorage.getItem(storageKey) ?? "{}") as Record<string, string>;
      current[key] = value;
      localStorage.setItem(storageKey, JSON.stringify(current));
    } catch {}
  }, [storageKey]);

  const initialStyle = useMemo((): React.CSSProperties => {
    const style: Record<string, string> = {};
    const totalResizable = columns.reduce((s, c) => c.minWidth == null ? s + c.defaultSize : s, 0);

    for (const seg of segments) {
      if (!seg.isLast) {
        const savedWidth = saved[`--seg-${seg.segIdx}-width`];
        if (savedWidth) {
          style[`--seg-${seg.segIdx}-width`] = savedWidth;
        } else if (seg.constrained) {
          style[`--seg-${seg.segIdx}-width`] = `${seg.minPx}px`;
        } else {
          const segTotal = seg.cols.reduce((s, c) => s + c.col.defaultSize, 0);
          style[`--seg-${seg.segIdx}-width`] = `${(segTotal / totalResizable) * 100}%`;
        }
      }

      if (seg.constrained) {
        // Single constrained column always fills 100% of its segment
        style[`--col-${seg.cols[0].idx}`] = "100%";
      } else {
        const segColTotal = seg.cols.reduce((s, c) => s + c.col.defaultSize, 0);
        for (const { col, idx } of seg.cols) {
          style[`--col-${idx}`] = saved[`--col-${idx}`] ?? `${(col.defaultSize / segColTotal) * 100}%`;
        }
      }
    }

    return style as React.CSSProperties;
  }, [columns, segments, saved]);

  const segDefaultLayout = useCallback((seg: ResizableSegment): Layout => {
    const layout: Layout = {};
    const segColTotal = seg.cols.reduce((s, c) => s + c.col.defaultSize, 0);
    for (const { col, idx } of seg.cols) {
      const savedVal = saved[`--col-${idx}`];
      const pct = savedVal ? parseFloat(savedVal) : (segColTotal > 0 ? (col.defaultSize / segColTotal) * 100 : 100);
      layout[`col-${idx}`] = isNaN(pct) ? 100 : pct;
    }
    return layout;
  }, [saved]);

  const makeLayoutHandler = useCallback(
    (seg: ResizableSegment) => (layout: Layout) => {
      const el = containerRef.current;
      if (!el) return;
      const sizes = seg.cols.map(({ idx }) => layout[`col-${idx}`] ?? 0);
      const total = sizes.reduce((s, v) => s + v, 0);
      seg.cols.forEach(({ idx }, j) => {
        const pct = total > 0 ? (sizes[j] / total) * 100 : 100 / seg.cols.length;
        const value = `${pct}%`;
        el.style.setProperty(`--col-${idx}`, value);
        save(`--col-${idx}`, value);
      });
    },
    [save],
  );

  const startSegDrag = useCallback((seg: ResizableSegment, e: React.MouseEvent) => {
    e.preventDefault();
    const el = containerRef.current;
    if (!el) return;
    const segEl = el.querySelector<HTMLElement>(`[data-seg="${seg.segIdx}"]`);
    if (!segEl) return;
    const startWidth = segEl.getBoundingClientRect().width;
    const startX = e.clientX;

    userResizedSegs.current.add(seg.segIdx);
    const onMove = (ev: MouseEvent) => {
      const raw = startWidth + ev.clientX - startX;
      const newWidth = Math.max(seg.minPx, Math.min(seg.maxPx, raw));
      const value = `${newWidth}px`;
      el.style.setProperty(`--seg-${seg.segIdx}-width`, value);
      save(`--seg-${seg.segIdx}-width`, value);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [save]);

  // Auto-fit constrained (minWidth) columns to their content. For each such
  // column we measure the widest cell's natural width (briefly forcing
  // `max-content` so truncation doesn't hide the true size), then clamp to
  // [minWidth, maxWidth] and pin the segment to that width. Result: the column
  // grows to fit names/badges when there's room and only truncates past the
  // cap. Runs in a layout effect (before paint, so no flash) and re-runs when
  // `measureKey` changes. A column the user has manually dragged keeps its
  // saved width and is left alone.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    for (const seg of segments) {
      if (!seg.constrained) continue;
      if (saved[`--seg-${seg.segIdx}-width`]) continue;
      if (userResizedSegs.current.has(seg.segIdx)) continue;
      const idx = seg.cols[0].idx;
      const cells = Array.from(el.querySelectorAll<HTMLElement>(`[data-col="${idx}"]`));
      if (cells.length === 0) continue;
      const prevWidths = cells.map(c => c.style.width);
      cells.forEach(c => { c.style.width = "max-content"; });
      let max = 0;
      cells.forEach(c => { max = Math.max(max, c.getBoundingClientRect().width); });
      cells.forEach((c, i) => { c.style.width = prevWidths[i]; });
      if (max > 0) {
        const clamped = Math.max(seg.minPx, Math.min(seg.maxPx, Math.ceil(max)));
        el.style.setProperty(`--seg-${seg.segIdx}-width`, `${clamped}px`);
      }
    }
  }, [segments, saved, measureKey]);

  const colOffset = checkboxColumn ? 1 : 0;

  return (
    <div ref={containerRef} role="grid" className="rounded-md border overflow-x-auto bg-background" style={initialStyle}>
    <div className="min-w-0 md:min-w-[700px]">
      <div role="row" className="flex items-center bg-muted/50 border-b h-10">
        {checkboxColumn && <div role="columnheader" aria-colindex={1} className="w-10 shrink-0" />}

        {segments.map((seg, i) => {
          const wrapperStyle: React.CSSProperties = seg.isLast
            ? { flex: "1 1 0", minWidth: 0 }
            : { width: `var(--seg-${seg.segIdx}-width)`, flexShrink: 0 };

          const nextSeg = segments[i + 1];
          const needsDragHandle = !seg.isLast && nextSeg != null;

          return (
            <React.Fragment key={`seg-${seg.segIdx}`}>
              <div data-seg={seg.segIdx} style={wrapperStyle} className="h-full flex">
                {seg.constrained ? (
                  // Constrained (standalone) segment - no internal panel group needed
                  <HeaderCell col={seg.cols[0].col} idx={seg.cols[0].idx} colIndex={seg.cols[0].idx + 1 + colOffset} sort={sort} onSort={onSort} />
                ) : (
                  <ResizablePanelGroup
                    className="flex-1 h-full"
                    defaultLayout={segDefaultLayout(seg)}
                    onLayoutChange={makeLayoutHandler(seg)}
                  >
                    {seg.cols.flatMap(({ col, idx }, j) => [
                      j > 0 ? <ResizableHandle key={`h${idx}`} withHandle className="bg-transparent" /> : null,
                      <ResizablePanel
                        key={`p${idx}`}
                        id={`col-${idx}`}
                        defaultSize={col.defaultSize}
                        minSize={col.minSize ?? 8}
                      >
                        <HeaderCell col={col} idx={idx} colIndex={idx + 1 + colOffset} sort={sort} onSort={onSort} />
                      </ResizablePanel>,
                    ])}
                  </ResizablePanelGroup>
                )}
              </div>
              {needsDragHandle && (
                <div
                  className="relative flex w-px shrink-0 items-center justify-center cursor-col-resize after:absolute after:inset-y-0 after:left-1/2 after:w-2 after:-translate-x-1/2"
                  onMouseDown={e => startSegDrag(seg, e)}
                >
                  <div className="z-10 flex h-4 w-3 items-center justify-center rounded-xs border bg-border">
                    <GripVerticalIcon className="size-2.5" />
                  </div>
                </div>
              )}
            </React.Fragment>
          );
        })}
      </div>

      {children}
    </div>
    </div>
  );
}

// ── ResizableTableRow ─────────────────────────────────────────────────────────

export function ResizableTableRow({
  columns,
  cells,
  checkboxCell,
  className,
  draggable,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDragLeave,
  onDrop,
  onActivate,
  onKeyDown,
  tabIndex,
  role = "row",
  "aria-label": ariaLabel,
}: ResizableTableRowProps) {
  const segments = useMemo(() => buildSegments(columns), [columns]);
  const colOffset = checkboxCell !== undefined ? 1 : 0;

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (onActivate && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      onActivate(e);
    }
    onKeyDown?.(e);
  };

  return (
    <div
      role={role}
      tabIndex={tabIndex}
      aria-label={ariaLabel}
      onKeyDown={onActivate || onKeyDown ? handleKeyDown : undefined}
      className={cn(
        "flex items-center border-b last:border-b-0 h-10 select-none transition-colors hover:bg-muted/40",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        className,
      )}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {checkboxCell !== undefined && (
        <div role="gridcell" aria-colindex={1} className="w-10 shrink-0 px-3" onClick={e => e.stopPropagation()}>
          {checkboxCell}
        </div>
      )}

      {segments.map((seg) => {
        const containerStyle: React.CSSProperties = seg.isLast
          ? { flex: "1 1 0", minWidth: 0, display: "flex" }
          : { width: `var(--seg-${seg.segIdx}-width)`, flexShrink: 0, display: "flex" };

        return (
          <div key={`seg-${seg.segIdx}`} style={containerStyle}>
            {seg.cols.map(({ idx }) => {
              const cell = cells[idx];
              return (
                <div
                  key={idx}
                  data-col={idx}
                  role="gridcell"
                  aria-colindex={idx + 1 + colOffset}
                  style={{ width: `var(--col-${idx})` }}
                  className={cn("flex items-center overflow-hidden shrink-0", cell?.className ?? "px-3")}
                  onClick={cell?.onClick}
                >
                  {cell?.content}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
