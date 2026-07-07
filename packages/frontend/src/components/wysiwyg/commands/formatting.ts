import { EditorView } from "@codemirror/view";
import { ChangeSet, type ChangeSpec, type EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";
import type { ActiveFormats } from "../WysiwygToolbar";

// Pure formatting commands for the WYSIWYG editor's toolbar / keymap, extracted
// from WysiwygEditor.tsx so they can be unit-tested in isolation.
//
// Multi-range note (T-M11): this editor never enables allowMultipleSelections,
// so `state.selection.main` is always the only range. If multiple selections
// are ever enabled these commands should switch to `changeByRange`.

export type InlineMarker = "**" | "*" | "__" | "~~";
export type ListKind = "bullet" | "numbered" | "task";
export type HeadingLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6;

const ANY_LIST_PREFIX = /^(\s*)(?:- \[[ xX]\] |- |\d+\. )/;
const WORD_CHAR = /[\p{L}\p{N}]/u;

// ── Inline markers (bold / italic / underline / strikethrough) ──────────────

/** Selected text is exactly `<marker>inner<marker>` (and, for `*`, the inner
 * edges aren't more asterisks - so `**bold**` isn't mistaken for `*..*`). */
function exactWrap(s: string, marker: string): boolean {
  const ml = marker.length;
  if (s.length < ml * 2 + 1 || !s.startsWith(marker) || !s.endsWith(marker)) return false;
  if (marker === "*") return s[ml] !== "*" && s[s.length - ml - 1] !== "*";
  return true;
}

/** For `*`, make sure the characters just outside [from, to) aren't further
 * asterisks (which would mean we're looking at part of a `**` pair). */
function asteriskNeighborsOk(state: EditorState, from: number, to: number, marker: string): boolean {
  if (marker !== "*") return true;
  return state.sliceDoc(from - 1, from) !== "*" && state.sliceDoc(to, to + 1) !== "*";
}

/** Does this syntax node represent the formatting toggled by `marker`?
 * `__` parses as StrongEmphasis but renders as underline in this app, so the
 * actual delimiter text disambiguates bold from underline. Emphasis accepts
 * either `*` or `_` delimiters - both render italic. */
function markerNodeMatches(state: EditorState, node: SyntaxNode, marker: InlineMarker): boolean {
  const delim = state.sliceDoc(node.from, node.from + marker.length);
  switch (marker) {
    case "*": return node.name === "Emphasis" && (delim === "*" || delim === "_");
    case "**": return node.name === "StrongEmphasis" && delim === "**";
    case "__": return node.name === "StrongEmphasis" && delim === "__";
    case "~~": return node.name === "Strikethrough" && delim === "~~";
  }
}

/** Innermost formatted span of `marker`'s kind strictly containing `pos`.
 * Strict containment matches computeActiveFormats: a caret sitting just after
 * the closing marker is outside the formatting. */
function findEnclosingMarkerNode(state: EditorState, pos: number, marker: InlineMarker): SyntaxNode | null {
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1);
  while (node) {
    if (pos > node.from && pos < node.to && markerNodeMatches(state, node, marker)) return node;
    node = node.parent;
  }
  return null;
}

/** Underscore emphasis is not flanking-valid intraword (`he__llo__` renders
 * literally), so expand the wrap range outward to word boundaries. */
function expandForUnderscore(state: EditorState, from: number, to: number, marker: InlineMarker): { from: number; to: number } {
  if (marker[0] !== "_") return { from, to };
  const line = state.doc.lineAt(from);
  const isWord = (p: number) => p >= line.from && p < line.to && WORD_CHAR.test(state.sliceDoc(p, p + 1));
  if (isWord(from - 1) && isWord(from)) { while (isWord(from - 1)) from--; }
  if (isWord(to) && isWord(to - 1)) { while (isWord(to)) to++; }
  return { from, to };
}

/** Multi-block selections (C4 / T-M9): emphasis can't span blocks in markdown,
 * so wrap (or unwrap) each line's slice of the selection separately. */
function applyMarkerMultiLine(view: EditorView, marker: InlineMarker, from: number, to: number) {
  const state = view.state;
  const ml = marker.length;
  const startLine = state.doc.lineAt(from);
  const endLine = state.doc.lineAt(to);

  const segments: { from: number; to: number; text: string }[] = [];
  for (let n = startLine.number; n <= endLine.number; n++) {
    const line = state.doc.line(n);
    let segFrom = Math.max(line.from, from);
    let segTo = Math.min(line.to, to);
    const slice = state.sliceDoc(segFrom, segTo);
    segFrom += slice.length - slice.trimStart().length;
    segTo -= slice.length - slice.trimEnd().length;
    if (segFrom >= segTo) continue;
    ({ from: segFrom, to: segTo } = expandForUnderscore(state, segFrom, segTo, marker));
    segments.push({ from: segFrom, to: segTo, text: state.sliceDoc(segFrom, segTo) });
  }
  if (segments.length === 0) return;

  const allWrapped = segments.every((s) => exactWrap(s.text, marker));
  const specs: ChangeSpec[] = [];
  for (const s of segments) {
    if (allWrapped) {
      specs.push({ from: s.from, to: s.from + ml }, { from: s.to - ml, to: s.to });
    } else if (!exactWrap(s.text, marker)) {
      specs.push({ from: s.from, insert: marker }, { from: s.to, insert: marker });
    }
  }
  if (specs.length === 0) return;

  const changes = ChangeSet.of(specs, state.doc.length);
  const sel = state.selection.main;
  view.dispatch({
    changes,
    selection: { anchor: changes.mapPos(sel.anchor, -1), head: changes.mapPos(sel.head, 1) },
  });
}

export function applyMarkerCm(view: EditorView, marker: InlineMarker) {
  const state = view.state;
  const sel = state.selection.main;
  const ml = marker.length;

  if (sel.empty) {
    // C3: a collapsed cursor inside an existing formatted span unformats it,
    // matching the toolbar's lit active-state (which uses the same tree walk).
    const node = findEnclosingMarkerNode(state, sel.head, marker);
    if (node) {
      const changes = ChangeSet.of(
        [
          { from: node.from, to: node.from + ml },
          { from: node.to - ml, to: node.to },
        ],
        state.doc.length,
      );
      view.dispatch({ changes, selection: { anchor: changes.mapPos(sel.head, -1) } });
      return;
    }
    // Cursor sitting exactly inside an empty marker pair (`**|**` after
    // starting bold and typing nothing) - remove the pair.
    const before = sel.from >= ml ? state.sliceDoc(sel.from - ml, sel.from) : "";
    const after = state.sliceDoc(sel.to, sel.to + ml);
    if (before === marker && after === marker && asteriskNeighborsOk(state, sel.from - ml, sel.to + ml, marker)) {
      view.dispatch({
        changes: [
          { from: sel.from - ml, to: sel.from },
          { from: sel.to, to: sel.to + ml },
        ],
        selection: { anchor: sel.from - ml },
      });
      return;
    }
    // Start typing formatted: insert a pair and put the cursor between them.
    view.dispatch({
      changes: { from: sel.from, insert: marker + marker },
      selection: { anchor: sel.from + ml },
    });
    return;
  }

  // C4 / T-M9: trim edge whitespace out of the wrapped range - `**word **`
  // is not flanking-valid and renders literally.
  let from = sel.from;
  let to = sel.to;
  const raw = state.sliceDoc(from, to);
  from += raw.length - raw.trimStart().length;
  to -= raw.length - raw.trimEnd().length;
  if (from >= to) {
    // Whitespace-only selection: just start an empty marker pair.
    view.dispatch({
      changes: { from: sel.from, insert: marker + marker },
      selection: { anchor: sel.from + ml },
    });
    return;
  }

  const text = state.sliceDoc(from, to);

  // Multi-line selection: handle per line-slice (emphasis can't span blocks).
  if (text.includes("\n")) {
    applyMarkerMultiLine(view, marker, from, to);
    return;
  }

  // Unwrap when the selection includes the markers (`**bold**` selected)…
  if (exactWrap(text, marker)) {
    const inner = text.slice(ml, text.length - ml);
    view.dispatch({
      changes: { from, to, insert: inner },
      selection: { anchor: from, head: from + inner.length },
    });
    return;
  }

  // …or when the markers sit just outside it (`bold` selected inside `**bold**`).
  const before = from >= ml ? state.sliceDoc(from - ml, from) : "";
  const after = state.sliceDoc(to, to + ml);
  if (before === marker && after === marker && asteriskNeighborsOk(state, from - ml, to + ml, marker)) {
    view.dispatch({
      changes: [
        { from: from - ml, to: from },
        { from: to, to: to + ml },
      ],
      selection: { anchor: from - ml, head: to - ml },
    });
    return;
  }

  ({ from, to } = expandForUnderscore(state, from, to, marker));
  view.dispatch({
    changes: { from, to, insert: marker + state.sliceDoc(from, to) + marker },
    selection: { anchor: from + ml, head: to + ml },
  });
}

// ── Line prefixes (bullet / numbered / task lists) ───────────────────────────

export function applyLinePrefixCm(view: EditorView, kind: ListKind) {
  const sel = view.state.selection.main;
  const startLine = view.state.doc.lineAt(sel.from);
  const endLine = view.state.doc.lineAt(sel.to);

  const lines: { from: number; text: string; existing: RegExpMatchArray | null }[] = [];
  for (let n = startLine.number; n <= endLine.number; n++) {
    const line = view.state.doc.line(n);
    lines.push({ from: line.from, text: line.text, existing: line.text.match(ANY_LIST_PREFIX) });
  }

  const isThisKind = (m: RegExpMatchArray | null) => {
    if (!m) return false;
    const rest = m[0].slice(m[1].length);
    if (kind === "bullet") return rest === "- ";
    if (kind === "task") return /^- \[[ xX]\] $/.test(rest);
    return /^\d+\. $/.test(rest);
  };
  const allThisKind = lines.length > 0 && lines.every((l) => isThisKind(l.existing));

  // U4: converting to a numbered list continues an ordered list sitting
  // immediately above the selection (same indent) instead of restarting at 1.
  let startNum = 1;
  if (kind === "numbered" && !allThisKind && startLine.number > 1) {
    const prev = view.state.doc.line(startLine.number - 1);
    const m = prev.text.match(/^(\s*)(\d+)\. /);
    if (m && m[1] === (lines[0].existing?.[1] ?? "")) startNum = parseInt(m[2], 10) + 1;
  }

  const newPrefix = (i: number, indent: string): string => {
    if (kind === "bullet") return `${indent}- `;
    if (kind === "task") return `${indent}- [ ] `;
    return `${indent}${startNum + i}. `;
  };

  const changes = lines.map((l, i) => {
    const indent = l.existing?.[1] ?? "";
    const existingLen = l.existing?.[0].length ?? indent.length;
    if (allThisKind) {
      return { from: l.from + indent.length, to: l.from + existingLen, insert: "" };
    }
    return { from: l.from, to: l.from + existingLen, insert: newPrefix(i, indent) };
  });

  const changeSet = ChangeSet.of(changes, view.state.doc.length);
  view.dispatch({
    changes: changeSet,
    selection: {
      anchor: changeSet.mapPos(sel.anchor, 1),
      head: changeSet.mapPos(sel.head, 1),
    },
  });
}

// ── Toolbar active-state detection ───────────────────────────────────────────

export function computeActiveFormats(state: EditorState): ActiveFormats {
  const pos = state.selection.main.head;
  const tree = syntaxTree(state);
  let headingLevel: ActiveFormats["headingLevel"] = 0;
  let bold = false, italic = false, underline = false, strike = false;
  let blockquote = false, codeFence = false;

  // Inline marks require strict containment (T-L11): with the caret sitting
  // just past the closing marker (pos === node.to), typing produces unformatted
  // text, so the toolbar shouldn't light up. Block contexts (heading, quote,
  // fence) keep edge-inclusive behavior - typing at their edges extends them.
  const strictlyInside = (node: SyntaxNode) => node.from < pos && pos < node.to;

  let node = tree.resolveInner(pos, -1);
  while (node) {
    const name = node.name;
    const hMatch = name.match(/^ATXHeading(\d)$/);
    if (hMatch) {
      headingLevel = Math.min(parseInt(hMatch[1]!, 10), 6) as ActiveFormats["headingLevel"];
    }
    if (name === "StrongEmphasis" && strictlyInside(node)) {
      if (state.doc.sliceString(node.from, node.from + 1) === "_") underline = true;
      else bold = true;
    }
    if (name === "Emphasis" && strictlyInside(node)) italic = true;
    if (name === "Strikethrough" && strictlyInside(node)) strike = true;
    if (name === "Blockquote") blockquote = true;
    if (name === "FencedCode") codeFence = true;
    if (!node.parent) break;
    node = node.parent;
  }

  return { headingLevel, bold, italic, underline, strike, blockquote, codeFence };
}

// ── Blockquote ───────────────────────────────────────────────────────────────

export function applyBlockquoteCm(view: EditorView) {
  const sel = view.state.selection.main;
  const startLine = view.state.doc.lineAt(sel.from);
  const endLine = view.state.doc.lineAt(sel.to);

  const lines: { from: number; text: string }[] = [];
  for (let n = startLine.number; n <= endLine.number; n++) {
    const line = view.state.doc.line(n);
    lines.push({ from: line.from, text: line.text });
  }

  const allBlockquote = lines.every((l) => l.text.startsWith("> ") || l.text === ">");
  const changes = lines.map((l) => {
    if (allBlockquote) {
      const removeLen = l.text.startsWith("> ") ? 2 : 1;
      return { from: l.from, to: l.from + removeLen, insert: "" };
    }
    return { from: l.from, to: l.from, insert: "> " };
  });

  const changeSet = ChangeSet.of(changes, view.state.doc.length);
  view.dispatch({
    changes: changeSet,
    selection: { anchor: changeSet.mapPos(sel.anchor, 1), head: changeSet.mapPos(sel.head, 1) },
  });
}

// ── Block inserts (HR / code fence / table / callout) ────────────────────────

/** Leading text for a block inserted at the end of `line`: a blank separator
 * line after content, nothing when the line is already empty (T-L11 - the
 * block reuses the empty line instead of leaving a stray blank above). */
function blockLead(lineText: string): string {
  return lineText.trim() === "" ? "" : "\n\n";
}

export function applyHrCm(view: EditorView) {
  const sel = view.state.selection.main;
  const line = view.state.doc.lineAt(sel.head);
  const insertPos = line.to;
  const text = `${blockLead(line.text)}---\n`;
  view.dispatch({
    changes: { from: insertPos, to: insertPos, insert: text },
    selection: { anchor: insertPos + text.length },
  });
}

function findEnclosingFence(state: EditorState, pos: number): SyntaxNode | null {
  for (const side of [-1, 1] as const) {
    let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, side);
    while (node) {
      if (node.name === "FencedCode") return node;
      node = node.parent;
    }
  }
  return null;
}

export function applyCodeFenceCm(view: EditorView) {
  const state = view.state;
  const sel = state.selection.main;

  // T-M5: inside an existing fence the toolbar shows the button as pressed -
  // toggle the fence OFF (remove its marker lines, keep the body) instead of
  // inserting a nested pair that corrupts the document.
  const fence = findEnclosingFence(state, sel.head);
  if (fence) {
    const openLine = state.doc.lineAt(fence.from);
    const marks = fence.getChildren("CodeMark");
    const lastMark = marks.length > 1 ? marks[marks.length - 1] : null;
    const closeLine = lastMark && state.doc.lineAt(lastMark.from).number > openLine.number
      ? state.doc.lineAt(lastMark.from)
      : null; // unclosed fence: only an opening line to remove
    const specs: ChangeSpec[] = [
      { from: openLine.from, to: Math.min(openLine.to + 1, state.doc.length) },
    ];
    if (closeLine) specs.push({ from: closeLine.from, to: Math.min(closeLine.to + 1, state.doc.length) });
    const changes = ChangeSet.of(specs, state.doc.length);
    view.dispatch({
      changes,
      selection: { anchor: changes.mapPos(sel.anchor, -1), head: changes.mapPos(sel.head, -1) },
    });
    return;
  }

  const line = state.doc.lineAt(sel.head);
  const lead = blockLead(line.text);
  const insertPos = line.to;
  const text = `${lead}\`\`\`\n\n\`\`\`\n`;
  const cursorPos = insertPos + lead.length + 4; // on the blank line inside the fence
  view.dispatch({
    changes: { from: insertPos, to: insertPos, insert: text },
    selection: { anchor: cursorPos },
  });
}

export function insertTableCm(view: EditorView, rows: number, cols: number) {
  const sel = view.state.selection.main;
  const line = view.state.doc.lineAt(sel.head);
  const insertPos = line.to;
  const header = "| " + Array.from({ length: cols }, (_, i) => `Col ${i + 1}`).join(" | ") + " |";
  const sep    = "| " + Array(cols).fill("---").join(" | ") + " |";
  const row    = "| " + Array(cols).fill("   ").join(" | ") + " |";
  const lead = blockLead(line.text);
  const text = `${lead}${[header, sep, ...Array(rows).fill(row)].join("\n")}\n`;
  // Select the first header placeholder ("Col 1") so typing replaces it,
  // instead of parking the caret between the pipe and the space (T-L11).
  const headerTextFrom = insertPos + lead.length + 2;
  view.dispatch({
    changes: { from: insertPos, to: insertPos, insert: text },
    selection: { anchor: headerTextFrom, head: headerTextFrom + "Col 1".length },
  });
}

export function insertCalloutCm(view: EditorView, type: string) {
  const sel = view.state.selection.main;
  const line = view.state.doc.lineAt(sel.head);
  const insertPos = line.to;
  const text = `${blockLead(line.text)}> [!${type}]\n> `;
  view.dispatch({
    changes: { from: insertPos, to: insertPos, insert: text },
    selection: { anchor: insertPos + text.length },
  });
}

// ── Headings ─────────────────────────────────────────────────────────────────

export function applyHeadingCm(view: EditorView, level: HeadingLevel) {
  const state = view.state;
  const sel = state.selection.main;
  const startLine = state.doc.lineAt(sel.from);
  const endLine = state.doc.lineAt(sel.to);
  const newPrefix = level > 0 ? "#".repeat(level) + " " : "";
  const multiLine = startLine.number !== endLine.number;

  // U5: apply to every selected line (like the bullet/quote handlers), skipping
  // blank lines in multi-line selections.
  const specs: ChangeSpec[] = [];
  const changedLines = new Set<number>();
  for (let n = startLine.number; n <= endLine.number; n++) {
    const line = state.doc.line(n);
    if (multiLine && line.text.trim() === "") continue;
    const m = line.text.match(/^(#{1,6}) /);
    const currentPrefixLen = m ? m[1].length + 1 : 0;
    if (currentPrefixLen === newPrefix.length) continue; // already at this level
    specs.push({ from: line.from, to: line.from + currentPrefixLen, insert: newPrefix });
    changedLines.add(n);
  }
  if (specs.length === 0) return;

  const changes = ChangeSet.of(specs, state.doc.length);
  // Keep the caret out of the freshly inserted `#` prefix on lines we changed.
  const adjustPos = (pos: number) => {
    const line = state.doc.lineAt(pos);
    const mapped = changes.mapPos(pos, 1);
    if (!changedLines.has(line.number)) return mapped;
    const mappedLineFrom = changes.mapPos(line.from, -1);
    return Math.max(mappedLineFrom + newPrefix.length, mapped);
  };
  view.dispatch({
    changes,
    selection: { anchor: adjustPos(sel.anchor), head: adjustPos(sel.head) },
  });
}
