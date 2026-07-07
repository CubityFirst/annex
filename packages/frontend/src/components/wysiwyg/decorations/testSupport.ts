// Shared helpers for the decoration test suites. Test-only module (imported
// exclusively from *.test.ts files - never from app code).
import { EditorState, EditorSelection } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import type { Decoration } from "@codemirror/view";
import { buildDecorations } from "./walker";
import { rendererCtxFacet, type RendererCtx } from "../context/RendererContext";
import { Wikilink } from "../lezer/wikilinkExtension";
import { Comment as MdCommentExt } from "../lezer/commentExtension";

export interface StateOpts {
  /** Extra ctx values; default is reading mode (revealOnCursor: false). */
  ctx?: Partial<RendererCtx>;
  /** Cursor position (defaults to 0). */
  cursor?: number;
}

/** Fully-parsed EditorState with the same markdown config the editor uses. */
export function stateFor(doc: string, opts: StateOpts = {}): EditorState {
  const ctx: RendererCtx = { isPublic: false, revealOnCursor: false, ...opts.ctx };
  const state = EditorState.create({
    doc,
    selection: EditorSelection.cursor(opts.cursor ?? 0),
    extensions: [
      markdown({ base: markdownLanguage, extensions: [Wikilink, MdCommentExt] }),
      rendererCtxFacet.of(ctx),
    ],
  });
  // Force a complete parse so all nodes exist (the background parser is
  // viewport-limited otherwise).
  ensureSyntaxTree(state, doc.length, 5000);
  return state;
}

export interface DecoEntry {
  from: number;
  to: number;
  deco: Decoration;
}

/** Every decoration the walker emits for the state, in range order. */
export function entriesFor(state: EditorState): DecoEntry[] {
  const set = buildDecorations(state);
  const out: DecoEntry[] = [];
  set.between(0, state.doc.length, (from, to, deco) => {
    out.push({ from, to, deco });
  });
  return out;
}

/** All decoration widgets (block + inline replaces + point widgets). */
export function widgetsFor(state: EditorState): unknown[] {
  return entriesFor(state)
    .filter((e) => e.deco.spec.widget)
    .map((e) => e.deco.spec.widget as unknown);
}

/** Convenience: build state + collect widgets in one call. */
export function widgetsForDoc(doc: string, opts: StateOpts = {}): unknown[] {
  return widgetsFor(stateFor(doc, opts));
}

/**
 * Line decoration classes per 1-indexed line number. Line decorations are
 * zero-length ranges anchored at the line start with a `class` spec.
 */
export function lineClassesFor(state: EditorState): Map<number, string[]> {
  const out = new Map<number, string[]>();
  for (const e of entriesFor(state)) {
    if (e.from !== e.to) continue;
    const cls = e.deco.spec.class as string | undefined;
    if (!cls) continue;
    const line = state.doc.lineAt(e.from);
    if (line.from !== e.from) continue;
    const list = out.get(line.number) ?? [];
    list.push(...cls.split(/\s+/).filter(Boolean));
    out.set(line.number, list);
  }
  return out;
}

/**
 * The document text that survives all replace decorations (ranges replaced by
 * widgets contribute nothing). Mark decorations (spec.class) don't hide text.
 */
export function visibleTextFor(state: EditorState): string {
  const hidden = entriesFor(state)
    .filter((e) => e.from < e.to && e.deco.spec.class === undefined)
    .map((e) => ({ from: e.from, to: e.to }))
    .sort((a, b) => a.from - b.from);
  let text = "";
  let pos = 0;
  for (const h of hidden) {
    if (h.from > pos) text += state.doc.sliceString(pos, h.from);
    pos = Math.max(pos, h.to);
  }
  if (pos < state.doc.length) text += state.doc.sliceString(pos, state.doc.length);
  return text;
}
