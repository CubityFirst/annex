import type { Range } from "@codemirror/state";
import type { Decoration } from "@codemirror/view";
import type { EditorState, SelectionRange } from "@codemirror/state";
import type { SyntaxNodeRef } from "@lezer/common";
import type { RendererCtx } from "../context/RendererContext";

export type DecoRange = Range<Decoration>;

/**
 * Shared mutable state for one decoration build. Lets nested block visitors
 * dedupe work (a line stamped by an ancestor isn't re-stamped by a descendant,
 * a quote marker hidden once isn't hidden again) and lets headings dedupe
 * their slug ids across the document.
 */
export interface BuildPass {
  /** `QuoteMark.from` positions whose marker is already hidden (nested quote/callout dedup). */
  hiddenQuoteMarks: Set<number>;
  /** Line numbers already stamped with a blockquote line class. */
  quoteLines: Set<number>;
  /** Heading slug -> occurrence count so far, for duplicate-id suffixes. */
  headingSlugs: Map<string, number>;
}

export function createBuildPass(): BuildPass {
  return {
    hiddenQuoteMarks: new Set(),
    quoteLines: new Set(),
    headingSlugs: new Map(),
  };
}

export interface VisitorArgs {
  node: SyntaxNodeRef;
  state: EditorState;
  sel: SelectionRange;
  reveal: boolean;
  ctx: RendererCtx;
  decos: DecoRange[];
  pass: BuildPass;
}

/**
 * A visitor's return value controls tree descent: `false` stops the walker
 * from entering the node's children (the node rendered as a widget / hid its
 * body), anything else descends.
 */
export type Visitor = (args: VisitorArgs) => false | void;

export function cursorTouches(sel: SelectionRange, from: number, to: number): boolean {
  return sel.from <= to && sel.to >= from;
}
