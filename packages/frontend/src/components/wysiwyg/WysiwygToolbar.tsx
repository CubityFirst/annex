import { useState } from "react";
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

const TONE_COLOR: Record<string, string> = {
  zinc:   "hsl(220 9% 60%)",
  cyan:   "hsl(190 90% 60%)",
  blue:   "hsl(217 91% 65%)",
  teal:   "hsl(174 70% 55%)",
  green:  "hsl(142 71% 55%)",
  yellow: "hsl(48 96% 60%)",
  amber:  "hsl(38 92% 60%)",
  orange: "hsl(25 95% 60%)",
  red:    "hsl(0 84% 65%)",
  purple: "hsl(270 75% 65%)",
};

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

function ToolToggle({
  title,
  pressed,
  onMouseDown,
  children,
}: {
  title: string;
  pressed?: boolean;
  onMouseDown: (e: React.MouseEvent) => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Toggle
          size="sm"
          pressed={pressed}
          onMouseDown={onMouseDown}
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
  onMouseDown,
  children,
}: {
  title: string;
  onMouseDown: (e: React.MouseEvent) => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          className="h-9 min-w-9 px-2 sm:h-8 sm:min-w-8 sm:px-1.5 shrink-0 hover:bg-muted hover:text-muted-foreground [&_svg]:size-3.5"
          onMouseDown={onMouseDown}
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
  return (
    <div className="p-2">
      <p className="text-xs text-center text-muted-foreground mb-1.5 h-4">
        {hovered.cols > 0 && hovered.rows > 0
          ? `${hovered.cols} × ${hovered.rows}`
          : "Insert table"}
      </p>
      <div
        className="grid gap-1"
        style={{ gridTemplateColumns: `repeat(${TABLE_COLS}, 1.75rem)` }}
        onMouseLeave={() => setHovered({ rows: 0, cols: 0 })}
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
              onMouseDown={(e) => { e.preventDefault(); onInsert(r, c); }}
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

  return (
    <TooltipProvider delayDuration={600}>
      <div
        role="toolbar"
        aria-label="Formatting"
        aria-orientation="horizontal"
        className="flex items-center gap-1 px-2 h-11 sm:h-9 sm:gap-0.5 border-b border-border shrink-0 overflow-x-auto"
      >

        {/* Undo / Redo */}
        <ToolButton title="Undo (Ctrl+Z)" onMouseDown={(e) => { e.preventDefault(); onUndo(); }}>
          <Undo2 />
        </ToolButton>
        <ToolButton title="Redo (Ctrl+Y)" onMouseDown={(e) => { e.preventDefault(); onRedo(); }}>
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
          <DropdownMenuContent align="start" className="w-36">
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
          title="Bold (Ctrl+B)"
          pressed={active.bold}
          onMouseDown={(e) => { e.preventDefault(); onFormat("**"); }}
        >
          <Bold />
        </ToolToggle>
        <ToolToggle
          title="Italic (Ctrl+I)"
          pressed={active.italic}
          onMouseDown={(e) => { e.preventDefault(); onFormat("*"); }}
        >
          <Italic />
        </ToolToggle>
        <ToolToggle
          title="Underline (Ctrl+U)"
          pressed={active.underline}
          onMouseDown={(e) => { e.preventDefault(); onFormat("__"); }}
        >
          <Underline />
        </ToolToggle>
        <ToolToggle
          title="Strikethrough"
          pressed={active.strike}
          onMouseDown={(e) => { e.preventDefault(); onFormat("~~"); }}
        >
          <Strikethrough />
        </ToolToggle>

        <ToolbarSeparator />

        {/* Link */}
        <ToolButton title="Insert link (Ctrl+K)" onMouseDown={(e) => { e.preventDefault(); onLink(); }}>
          <LinkIcon />
        </ToolButton>

        {/* Image */}
        <ToolButton title="Insert image" onMouseDown={(e) => { e.preventDefault(); onImage(); }}>
          <Image />
        </ToolButton>

        {/* Image comparison slider */}
        <ToolButton title="Insert image comparison" onMouseDown={(e) => { e.preventDefault(); onCompare(); }}>
          <Columns2 />
        </ToolButton>

        <ToolbarSeparator />

        {/* Lists */}
        <ToolButton title="Bullet list" onMouseDown={(e) => { e.preventDefault(); onList("bullet"); }}>
          <List />
        </ToolButton>
        <ToolButton title="Numbered list" onMouseDown={(e) => { e.preventDefault(); onList("numbered"); }}>
          <ListOrdered />
        </ToolButton>
        <ToolButton title="Task list" onMouseDown={(e) => { e.preventDefault(); onList("task"); }}>
          <ListChecks />
        </ToolButton>

        <ToolbarSeparator />

        {/* Block-level formats */}
        <ToolToggle
          title="Blockquote"
          pressed={active.blockquote}
          onMouseDown={(e) => { e.preventDefault(); onBlockquote(); }}
        >
          <Quote />
        </ToolToggle>
        <ToolToggle
          title="Code fence"
          pressed={active.codeFence}
          onMouseDown={(e) => { e.preventDefault(); onCodeFence(); }}
        >
          <Code />
        </ToolToggle>
        <ToolButton title="Horizontal rule" onMouseDown={(e) => { e.preventDefault(); onHr(); }}>
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
          <PopoverContent align="start" className="w-auto p-0">
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
          <DropdownMenuContent align="start" className="w-40">
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
        <ToolButton title="Find & replace (Ctrl+F)" onMouseDown={(e) => { e.preventDefault(); onFind(); }}>
          <Search />
        </ToolButton>

      </div>
    </TooltipProvider>
  );
}
