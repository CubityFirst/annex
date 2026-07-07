import { createElement, type ReactElement, type CSSProperties } from "react";
import { WidgetType, type EditorView } from "@codemirror/view";
import { ReactWidget } from "./ReactWidget";
import {
  Pencil, ClipboardList, Info, CheckSquare, Flame, CheckCircle,
  HelpCircle, AlertTriangle, XCircle, Zap, Bug, List, Quote, ChevronDown,
} from "lucide-react";
import type { FC, SVGProps } from "react";
import { parseCalloutHeader } from "@/lib/callout";
import { isCalloutCollapsed, toggleCalloutFold } from "../decorations/calloutFold";

interface CalloutTypeConfig {
  label: string;
  Icon: FC<SVGProps<SVGSVGElement>>;
  tone: "zinc" | "cyan" | "blue" | "teal" | "green" | "yellow" | "amber" | "orange" | "red" | "purple";
}

export const CALLOUT_CONFIG: Record<string, CalloutTypeConfig> = {
  note:     { label: "Note",     Icon: Pencil,         tone: "zinc"   },
  abstract: { label: "Abstract", Icon: ClipboardList,  tone: "cyan"   },
  info:     { label: "Info",     Icon: Info,           tone: "blue"   },
  todo:     { label: "Todo",     Icon: CheckSquare,    tone: "blue"   },
  tip:      { label: "Tip",      Icon: Flame,          tone: "teal"   },
  success:  { label: "Success",  Icon: CheckCircle,    tone: "green"  },
  question: { label: "Question", Icon: HelpCircle,     tone: "yellow" },
  warning:  { label: "Warning",  Icon: AlertTriangle,  tone: "amber"  },
  failure:  { label: "Failure",  Icon: XCircle,        tone: "orange" },
  danger:   { label: "Danger",   Icon: Zap,            tone: "red"    },
  bug:      { label: "Bug",      Icon: Bug,            tone: "red"    },
  example:  { label: "Example",  Icon: List,           tone: "purple" },
  quote:    { label: "Quote",    Icon: Quote,          tone: "zinc"   },
};

interface Props {
  type: string;
  /** Whether the title is empty in the source - when empty, we render the canonical label after the icon. */
  showLabel: boolean;
  /** True for `> [!type]+` / `> [!type]-` callouts - renders a clickable collapse chevron. */
  foldable: boolean;
  /** Current effective collapsed state - drives the chevron rotation. */
  collapsed: boolean;
}

// The chevron was a styled <span>; keep it visually identical as a real
// <button> by zeroing the UA button chrome (the .cm-callout-chevron class in
// styles.css supplies the layout).
const chevronButtonReset: CSSProperties = {
  background: "none",
  border: 0,
  padding: 0,
  margin: 0,
  color: "inherit",
  font: "inherit",
};

function CalloutIconInner({ type, showLabel, foldable, collapsed }: Props) {
  const cfg = CALLOUT_CONFIG[type] ?? CALLOUT_CONFIG.note!;
  return createElement(
    "span",
    { className: "cm-callout-icon" },
    foldable
      ? createElement(
          "button",
          {
            type: "button",
            className: "cm-callout-chevron",
            style: chevronButtonReset,
            "data-collapsed": collapsed ? "true" : "false",
            "aria-expanded": !collapsed,
            "aria-label": collapsed ? "Expand callout" : "Collapse callout",
          },
          createElement(ChevronDown, { "aria-hidden": true } as SVGProps<SVGSVGElement>),
        )
      : null,
    createElement(cfg.Icon, { className: "cm-callout-icon__svg", "aria-hidden": true } as SVGProps<SVGSVGElement>),
    showLabel ? createElement("span", { className: "cm-callout-icon__label" }, cfg.label) : null,
  );
}

export class CalloutIconWidget extends ReactWidget {
  protected tag: "span" = "span";

  constructor(private readonly props: Props) {
    super();
  }

  protected render(): ReactElement {
    return createElement(CalloutIconInner, this.props);
  }

  // Foldable callouts own their click (chevron toggles fold). Non-foldable
  // callouts keep the default block-widget behaviour: a click falls through to
  // CM so the cursor lands in the range and the raw markdown reveals.
  protected revealOnClick(): boolean {
    return !this.props.foldable;
  }

  // Resolves the callout header at event time (positions may have shifted
  // since toDOM) and flips its fold state.
  private toggleFold(view: EditorView, el: HTMLElement): void {
    const pos = view.posAtDOM(el);
    const line = view.state.doc.lineAt(pos);
    const stripped = view.state.doc
      .sliceString(line.from, line.to)
      .replace(/^>\s?/, "");
    const parsed = parseCalloutHeader(stripped);
    if (!parsed) return;
    const collapsed = isCalloutCollapsed(view.state, line.from, parsed.fold);
    view.dispatch({
      effects: toggleCalloutFold.of({ from: line.from, collapsed: !collapsed }),
    });
  }

  toDOM(view: EditorView): HTMLElement {
    const el = super.toDOM(view);
    if (this.props.foldable) {
      // mousedown (with preventDefault) rather than click keeps the editor's
      // focus/selection untouched while toggling with the mouse.
      el.addEventListener("mousedown", (event) => {
        const target = event.target as HTMLElement | null;
        if (!target || !target.closest(".cm-callout-chevron")) return;
        event.preventDefault();
        event.stopPropagation();
        this.toggleFold(view, el);
      });
      // Keyboard path: the chevron is a real <button>, so it's Tab-focusable;
      // Enter/Space toggle. (CM ignores these events - ignoreEvent() is true
      // for foldable callouts - so they can't leak into editing keymaps.)
      el.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        const target = event.target as HTMLElement | null;
        if (!target || !target.closest(".cm-callout-chevron")) return;
        event.preventDefault();
        event.stopPropagation();
        this.toggleFold(view, el);
      });
    }
    return el;
  }

  eq(other: WidgetType): boolean {
    return (
      other instanceof CalloutIconWidget &&
      other.props.type === this.props.type &&
      other.props.showLabel === this.props.showLabel &&
      other.props.foldable === this.props.foldable &&
      other.props.collapsed === this.props.collapsed
    );
  }
}
