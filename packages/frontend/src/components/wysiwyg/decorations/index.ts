import { StateField } from "@codemirror/state";
import { EditorView, type DecorationSet } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { buildDecorations } from "./walker";
import { rendererCtxFacet } from "../context/RendererContext";
import { toggleCalloutFold } from "./calloutFold";

// Block decorations (HR, code fences, callouts, frontmatter, etc.) are not
// allowed from ViewPlugins — CM6 throws "Block decorations may not be specified
// via plugins". A StateField is the supported source for block decorations.
export const decorationField = StateField.define<DecorationSet>({
  create(state) {
    return buildDecorations(state);
  },
  update(decorations, tr) {
    const ctxChanged =
      tr.startState.facet(rendererCtxFacet) !== tr.state.facet(rendererCtxFacet);
    const foldToggled = tr.effects.some((e) => e.is(toggleCalloutFold));
    // Decorations are built from the Lezer syntax tree, which CodeMirror parses
    // INCREMENTALLY in the background (idle-scheduled, and throttled while the
    // tab is hidden). When the parser advances it dispatches a transaction with
    // no doc/selection change, so without this check the decorations for the
    // newly-parsed region (headings, tables, code blocks further down a large
    // doc) would never be built until an unrelated edit or click — the cause of
    // "it doesn't render until I click back in / scroll". Rebuilding when the
    // tree identity changes makes content render as soon as parsing reaches it
    // (and as soon as a backgrounded tab is refocused and parsing resumes),
    // with no interaction required. A transaction that doesn't touch the tree
    // returns the same tree object, so this adds no rebuilds in the common case.
    const treeChanged = syntaxTree(tr.startState) !== syntaxTree(tr.state);
    if (!tr.docChanged && !tr.selection && !ctxChanged && !foldToggled && !treeChanged) {
      return decorations.map(tr.changes);
    }
    return buildDecorations(tr.state);
  },
  provide: (f) => EditorView.decorations.from(f),
});
