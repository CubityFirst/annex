import { useCallback, useEffect, useRef, useState } from "react";
import {
  Bell,
  Bold,
  ChevronDown,
  Code,
  Columns2,
  Image,
  Italic,
  Link as LinkIcon,
  List,
  ListChecks,
  ListOrdered,
  Minus,
  Quote,
  Redo2,
  Search,
  Strikethrough,
  Table,
  Underline,
  Undo2,
} from "lucide-react";
import { Toggle } from "@/components/ui/toggle";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { CALLOUT_CONFIG } from "./widgets/CalloutIconWidget";

// Tone hues live in ONE place: the `--callout-tone-*` custom properties
// declared (light + .dark) in styles.css. Referencing them here keeps the
// callout-menu icons in sync with the rendered callout colors.
const TONE_COLOR: Record<string, string> = {
  zinc:   "var(--callout-tone-zinc)",
  cyan:   "var(--callout-tone-cyan)",
  blue:   "var(--callout-tone-blue)",
  teal:   "var(--callout-tone-teal)",
  green:  "var(--callout-tone-green)",
  yellow: "var(--callout-tone-yellow)",
  amber:  "var(--callout-tone-amber)",
  orange: "var(--callout-tone-orange)",
  red:    "var(--callout-tone-red)",
  purple: "var(--callout-tone-purple)",
};

// Same UA sniff the rest of the app uses for shortcut labels (DocsLayout,
// PublicDocPage). Guarded so non-browser test environments don't throw.
const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);

/** "Ctrl+B" on Windows/Linux, "⌘B" on macOS. Exported for context-menu shortcut labels. */
export function modShortcut(key: string): string {
  return IS_MAC ? `⌘${key}` : `Ctrl+${key}`;
}
/** Redo is Cmd+Shift+Z on macOS, Ctrl+Y elsewhere. */
export const REDO_SHORTCUT = IS_MAC ? "⇧⌘Z" : "Ctrl+Y";

export interface ActiveFormats {
  headingLevel: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  blockquote: boolean;
  codeFence: boolean;
}

export const defaultActiveFormats: ActiveFormats = {
  headingLevel: 0,
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  blockquote: false,
  codeFence: false,
};

interface WysiwygToolbarProps {
  active: ActiveFormats;
  onFormat: (marker: "**" | "*" | "__" | "~~") => void;
  onList: (kind: "bullet" | "numbered" | "task") => void;
  onLink: () => void;
  onHeading: (level: 0 | 1 | 2 | 3 | 4 | 5 | 6) => void;
  onBlockquote: () => void;
  onHr: () => void;
  onCodeFence: () => void;
  onTable: (rows: number, cols: number) => void;
  onCallout: (type: string) => void;
  onImage: () => void;
  onCompare: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onFind: () => void;
}

const HEADING_OPTIONS: { label: string; display: string }[] = [
  { label: "Paragraph", display: "¶" },
  { label: "Heading 1",  display: "H1" },
  { label: "Heading 2",  display: "H2" },
  { label: "Heading 3",  display: "H3" },
  { label: "Heading 4",  display: "H4" },
  { label: "Heading 5",  display: "H5" },
  { label: "Heading 6",  display: "H6" },
];

const TABLE_COLS = 6;
const TABLE_ROWS = 5;

function ToolbarSeparator() {
  return <Separator orientation="vertical" className="h-4 mx-0.5" />;
}

// Buttons run their action on `click`, NOT on mousedown, so keyboard
// activation (Enter/Space fire a synthetic click) works too. The mousedown
// handler only calls preventDefault - that keeps focus (and the selection)
// in the editor when the button is used with the mouse, and since the action
// no longer lives on mousedown there is no double-fire to guard against.
const keepEditorFocus = (e: React.MouseEvent) => e.preventDefault();

function ToolToggle({
  title,
  pressed,
  onAction,
  children,
}: {
  title: string;
  pressed?: boolean;
  onAction: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Toggle
          size="sm"
          pressed={pressed}
          onMouseDown={keepEditorFocus}
          onClick={onAction}
          aria-label={title}
          className="shrink-0"
        >
          {children}
        </Toggle>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">
        {title}
      </TooltipContent>
    </Tooltip>
  );
}

// Non-togglable one-shot actions (Undo, Link, lists, HR, callout, find, …).
// Visually matches ToolToggle's sm size but uses <Button> so AT users don't
// hear a misleading "toggle, not pressed" announcement.
function ToolButton({
  title,
  onAction,
  children,
}: {
  title: string;
  onAction: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          className="h-9 min-w-9 px-2 sm:h-8 sm:min-w-8 sm:px-1.5 shrink-0 hover:bg-muted hover:text-muted-foreground [&_svg]:size-3.5"
          onMouseDown={keepEditorFocus}
          onClick={onAction}
          aria-label={title}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">
        {title}
      </TooltipContent>
    </Tooltip>
  );
}

function TablePicker({ onInsert }: { onInsert: (rows: number, cols: number) => void }) {
  const [hovered, setHovered] = useState({ rows: 0, cols: 0 });
  const gridRef = useRef<HTMLDivElement>(null);

  // Arrow-key navigation between size cells (each cell is a real <button>, so
  // Enter/Space activate it via its click handler).
  const handleGridKeyDown = useCallback((e: React.KeyboardEvent) => {
    const delta =
      e.key === "ArrowRight" ? 1 :
      e.key === "ArrowLeft" ? -1 :
      e.key === "ArrowDown" ? TABLE_COLS :
      e.key === "ArrowUp" ? -TABLE_COLS : 0;
    if (delta === 0) return;
    const cells = Array.from(gridRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    const i = cells.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    const next = i + delta;
    if (next < 0 || next >= cells.length) return;
    e.preventDefault();
    cells[next]!.focus();
  }, []);

  return (
    <div className="p-2">
      <p className="text-xs text-center text-muted-foreground mb-1.5 h-4">
        {hovered.cols > 0 && hovered.rows > 0
          ? `${hovered.cols} × ${hovered.rows}`
          : "Insert table"}
      </p>
      <div
        ref={gridRef}
        className="grid gap-1"
        style={{ gridTemplateColumns: `repeat(${TABLE_COLS}, 1.75rem)` }}
        onMouseLeave={() => setHovered({ rows: 0, cols: 0 })}
        onKeyDown={handleGridKeyDown}
      >
        {Array.from({ length: TABLE_ROWS * TABLE_COLS }, (_, i) => {
          const r = Math.floor(i / TABLE_COLS) + 1;
          const c = (i % TABLE_COLS) + 1;
          const active = r <= hovered.rows && c <= hovered.cols;
          return (
            <button
              key={i}
              type="button"
              aria-label={`Insert ${c}×${r} table`}
              className={cn(
                "h-7 w-7 sm:h-5 sm:w-5 rounded-sm border transition-colors",
                active ? "bg-accent border-accent-foreground/30" : "bg-muted/30 border-border hover:bg-muted",
              )}
              onMouseEnter={() => setHovered({ rows: r, cols: c })}
              onFocus={() => setHovered({ rows: r, cols: c })}
              onClick={() => onInsert(r, c)}
            />
          );
        })}
      </div>
    </div>
  );
}

export function WysiwygToolbar({
  active,
  onFormat,
  onList,
  onLink,
  onHeading,
  onBlockquote,
  onHr,
  onCodeFence,
  onTable,
  onCallout,
  onImage,
  onCompare,
  onUndo,
  onRedo,
  onFind,
}: WysiwygToolbarProps) {
  const currentDisplay = HEADING_OPTIONS[active.headingLevel]?.display ?? "¶";
  const [tableOpen, setTableOpen] = useState(false);
  const toolbarRef = useRef<HTMLDivElement>(null);

  // ── Roving tabindex (WAI-ARIA toolbar pattern) ────────────────────────────
  // Exactly one toolbar item is in the tab order at a time: Tab enters/leaves
  // the toolbar as a whole, ArrowLeft/ArrowRight (plus Home/End) move within
  // it. Portaled popover/menu content is excluded by the DOM-containment
  // checks below (React portals bubble synthetic events through this
  // component tree even though the nodes live outside toolbarRef).
  const toolbarItems = useCallback((): HTMLElement[] => {
    return Array.from(
      toolbarRef.current?.querySelectorAll<HTMLElement>("button:not([disabled])") ?? [],
    );
  }, []);

  useEffect(() => {
    toolbarItems().forEach((el, i) => { el.tabIndex = i === 0 ? 0 : -1; });
  }, [toolbarItems]);

  const handleToolbarFocus = useCallback((e: React.FocusEvent) => {
    const target = (e.target as HTMLElement).closest("button");
    if (!target || !toolbarRef.current?.contains(target)) return;
    for (const el of toolbarItems()) el.tabIndex = el === target ? 0 : -1;
  }, [toolbarItems]);

  const handleToolbarKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft" && e.key !== "Home" && e.key !== "End") return;
    const items = toolbarItems();
    const current = items.indexOf(document.activeElement as HTMLElement);
    if (current < 0) return; // focus is in portaled content (or elsewhere)
    e.preventDefault();
    const next =
      e.key === "Home" ? 0 :
      e.key === "End" ? items.length - 1 :
      e.key === "ArrowRight" ? (current + 1) % items.length :
      (current - 1 + items.length) % items.length;
    items[current]!.tabIndex = -1;
    items[next]!.tabIndex = 0;
    items[next]!.focus();
  }, [toolbarItems]);

  // Radix menus/popovers refocus their trigger when they close, which yanks
  // the caret out of the editor right after every pick. The action handlers
  // already call view.focus(), so suppress the trigger refocus. (T-M6)
  const keepCaret = (e: Event) => e.preventDefault();

  return (
    <TooltipProvider delayDuration={600}>
      <div
        ref={toolbarRef}
        role="toolbar"
        aria-label="Formatting"
        aria-orientation="horizontal"
        className="flex items-center gap-1 px-2 h-11 sm:h-9 sm:gap-0.5 border-b border-border shrink-0 overflow-x-auto"
        onFocusCapture={handleToolbarFocus}
        onKeyDown={handleToolbarKeyDown}
      >

        {/* Undo / Redo */}
        <ToolButton title={`Undo (${modShortcut("Z")})`} onAction={onUndo}>
          <Undo2 />
        </ToolButton>
        <ToolButton title={`Redo (${REDO_SHORTCUT})`} onAction={onRedo}>
          <Redo2 />
        </ToolButton>

        <ToolbarSeparator />

        {/* Heading level */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label="Heading level"
              className={cn(
                "h-9 sm:h-7 gap-1 px-2 text-xs font-medium w-[4.5rem] justify-between shrink-0",
                active.headingLevel > 0 && "bg-accent text-accent-foreground",
              )}
            >
              <span>{currentDisplay}</span>
              <ChevronDown aria-hidden="true" className="h-3 w-3 opacity-50" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-36" onCloseAutoFocus={keepCaret}>
            {HEADING_OPTIONS.map(({ label }, i) => (
              <DropdownMenuItem
                key={i}
                className={cn(active.headingLevel === i && "bg-accent text-accent-foreground font-medium")}
                onSelect={() => onHeading(i as 0 | 1 | 2 | 3 | 4 | 5 | 6)}
              >
                {label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <ToolbarSeparator />

        {/* Inline formatting */}
        <ToolToggle
          title={`Bold (${modShortcut("B")})`}
          pressed={active.bold}
          onAction={() => onFormat("**")}
        >
          <Bold />
        </ToolToggle>
        <ToolToggle
          title={`Italic (${modShortcut("I")})`}
          pressed={active.italic}
          onAction={() => onFormat("*")}
        >
          <Italic />
        </ToolToggle>
        <ToolToggle
          title={`Underline (${modShortcut("U")})`}
          pressed={active.underline}
          onAction={() => onFormat("__")}
        >
          <Underline />
        </ToolToggle>
        <ToolToggle
          title="Strikethrough"
          pressed={active.strike}
          onAction={() => onFormat("~~")}
        >
          <Strikethrough />
        </ToolToggle>

        <ToolbarSeparator />

        {/* Link */}
        <ToolButton title={`Insert link (${modShortcut("K")})`} onAction={onLink}>
          <LinkIcon />
        </ToolButton>

        {/* Image */}
        <ToolButton title="Insert image" onAction={onImage}>
          <Image />
        </ToolButton>

        {/* Image comparison slider */}
        <ToolButton title="Insert image comparison" onAction={onCompare}>
          <Columns2 />
        </ToolButton>

        <ToolbarSeparator />

        {/* Lists */}
        <ToolButton title="Bullet list" onAction={() => onList("bullet")}>
          <List />
        </ToolButton>
        <ToolButton title="Numbered list" onAction={() => onList("numbered")}>
          <ListOrdered />
        </ToolButton>
        <ToolButton title="Task list" onAction={() => onList("task")}>
          <ListChecks />
        </ToolButton>

        <ToolbarSeparator />

        {/* Block-level formats */}
        <ToolToggle
          title="Blockquote"
          pressed={active.blockquote}
          onAction={onBlockquote}
        >
          <Quote />
        </ToolToggle>
        <ToolToggle
          title="Code fence"
          pressed={active.codeFence}
          onAction={onCodeFence}
        >
          <Code />
        </ToolToggle>
        <ToolButton title="Horizontal rule" onAction={onHr}>
          <Minus />
        </ToolButton>

        <ToolbarSeparator />

        {/* Table picker */}
        <Popover open={tableOpen} onOpenChange={setTableOpen}>
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <Toggle
                  size="sm"
                  aria-label="Insert table"
                  aria-haspopup="dialog"
                  pressed={tableOpen}
                  className="shrink-0"
                >
                  <Table />
                </Toggle>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">Insert table</TooltipContent>
          </Tooltip>
          <PopoverContent align="start" className="w-auto p-0" onCloseAutoFocus={keepCaret}>
            <TablePicker
              onInsert={(rows, cols) => {
                setTableOpen(false);
                onTable(rows, cols);
              }}
            />
          </PopoverContent>
        </Popover>

        {/* Callout picker */}
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  aria-label="Insert callout"
                  className="h-8 px-1.5 min-w-8 shrink-0 hover:bg-muted hover:text-muted-foreground [&_svg]:size-3.5"
                >
                  <Bell />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">Insert callout</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="start" className="w-40" onCloseAutoFocus={keepCaret}>
            {Object.entries(CALLOUT_CONFIG).map(([type, cfg]) => (
              <DropdownMenuItem
                key={type}
                onSelect={() => onCallout(type)}
                className="gap-2"
              >
                <cfg.Icon
                  aria-hidden="true"
                  className="h-3.5 w-3.5 shrink-0"
                  style={{ color: TONE_COLOR[cfg.tone] ?? "currentColor" }}
                />
                {cfg.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <ToolbarSeparator />

        {/* Find */}
        <ToolButton title={`Find & replace (${modShortcut("F")})`} onAction={onFind}>
          <Search />
        </ToolButton>

      </div>
    </TooltipProvider>
  );
}
