import type { Command } from "@codemirror/view";

// ── Deliberately inert (T-M2 / T-L8) ─────────────────────────────────────────
//
// These commands used to insert "\n> " (Enter) / "\n" (Shift+Enter) inside a
// callout. Both are retired:
//
// - Enter: the built-in markdown continuation (`insertNewlineContinueMarkupCommand`,
//   bound at Prec.high in WysiwygEditor) already handles blockquote/callout
//   continuation AND empty-line exit, and it runs BEFORE this keymap - so the
//   old implementation was shadowed in every normal case. The residual cases
//   it did catch were corrupting: Enter at column 0 of a body line produced a
//   blank line + `> > body` (a detached nested quote), and a selection
//   spanning past the callout end was replaced with "\n> ", quote-prefixing
//   merged content.
// - Shift+Enter: inserting a plain "\n" is exactly what the default keymap
//   does anyway, and doing it mid-callout just split it into a callout plus a
//   headerless orphan blockquote.
//
// Returning false hands Enter/Shift+Enter to the next binding (the built-in
// continuation / default newline), which does the right thing in all cases.
//
// TODO(cleanup): remove the two keymap registrations and imports in
// WysiwygEditor.tsx, then delete this file.

/** Retired - always declines so the built-in markup continuation handles Enter. */
export const calloutContinueOnEnter: Command = () => false;

/** Retired - always declines so the default keymap inserts the plain newline. */
export const calloutBreakOnShiftEnter: Command = () => false;
