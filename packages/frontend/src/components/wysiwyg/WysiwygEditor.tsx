import { useCallback, useEffect, useRef, useState } from "react";
import { EditorView, keymap } from "@codemirror/view";
import { ChangeSet, EditorState, Prec } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { defaultKeymap, historyKeymap, history, indentWithTab, undo, redo } from "@codemirror/commands";
import { search, openSearchPanel, closeSearchPanel, searchPanelOpen } from "@codemirror/search";
import { markdown, markdownLanguage, insertNewlineContinueMarkupCommand, deleteMarkupBackward } from "@codemirror/lang-markdown";
import { Wikilink } from "./lezer/wikilinkExtension";
import { Comment as MdCommentExt } from "./lezer/commentExtension";
import { calloutContinueOnEnter, calloutBreakOnShiftEnter } from "./commands/calloutEnter";
import { tableContinueOnEnter } from "./commands/tableEnter";
import * as Y from "yjs";
import { yCollab } from "y-codemirror.next";
import { Awareness } from "y-protocols/awareness";
import { userColor, userColorLight } from "@/lib/userColor";
import { CollabProvider } from "@/lib/collabProvider";
import { ctxCompartment, modeCompartment, modeExtension, ctxExtension, buildCtxForMode, type WysiwygMode } from "./modes";
import { defaultRendererCtx, type RendererCtx } from "./context/RendererContext";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { ColorPicker } from "@/components/ui/color-picker";
import { Bold, Check, ClipboardPaste, Copy, Italic, Link as LinkIcon, List, ListChecks, ListOrdered, Loader2, Pilcrow, Scissors, Strikethrough, Type, Underline, Upload } from "lucide-react";
import { WysiwygToolbar, defaultActiveFormats, type ActiveFormats } from "./WysiwygToolbar";
import "./styles.css";

const editorTheme = EditorView.theme({
  "&": {
    height: "100%",
  },
  ".cm-scroller": {
    overflow: "auto",
    height: "100%",
    padding: "16px",
    boxSizing: "border-box",
  },
  ".cm-content": {
    padding: "0 0 22.75px 0",
    caretColor: "currentColor",
  },
  ".cm-line": { padding: "0" },
  ".cm-focused": { outline: "none" },
  ".cm-editor": { height: "100%" },
});

interface CollabUser {
  id: string;
  name: string;
  personalPlan?: "free" | "ink";
  personalPlanStyle?: string | null;
  personalPresenceColor?: string | null;
}

interface Props {
  mode: WysiwygMode;
  value: string;
  onChange?: (next: string) => void;
  onSave?: () => void;
  autoFocus?: boolean;
  collab?: { docId: string; user: CollabUser };
  onAwarenessChange?: (editors: { userId: string; name: string; color: string; personalPlan?: "free" | "ink"; personalPlanStyle?: string | null }[]) => void;
  // Terminal signal from collab server - reconnecting won't help (doc size cap exceeded
  // server-side, or our last frame was too big and local state has diverged). The provider
  // stops reconnecting; the parent should drop out of collab mode.
  onCollabFatal?: (reason: string) => void;
  rendererCtx?: RendererCtx;
  onPasteImage?: (file: File) => Promise<{ url: string; alt: string }>;
}

function applyMarkerCm(view: EditorView, marker: string) {
  const sel = view.state.selection.main;
  const selected = view.state.sliceDoc(sel.from, sel.to);
  const ml = marker.length;

  const before = sel.from >= ml ? view.state.sliceDoc(sel.from - ml, sel.from) : "";
  const after = view.state.sliceDoc(sel.to, sel.to + ml);

  const exactWrap = (s: string) => {
    if (s.length < ml * 2 + 1 || !s.startsWith(marker) || !s.endsWith(marker)) return false;
    if (marker === "*") return s[ml] !== "*" && s[s.length - ml - 1] !== "*";
    return true;
  };

  const outerMatch =
    before === marker &&
    after === marker &&
    (marker !== "*" || (
      view.state.sliceDoc(sel.from - ml - 1, sel.from - ml) !== "*" &&
      view.state.sliceDoc(sel.to + ml, sel.to + ml + 1) !== "*"
    ));

  if (outerMatch) {
    view.dispatch({
      changes: [
        { from: sel.from - ml, to: sel.from, insert: "" },
        { from: sel.to, to: sel.to + ml, insert: "" },
      ],
      selection: { anchor: sel.from - ml, head: sel.to - ml },
    });
    return;
  }

  if (exactWrap(selected)) {
    const inner = selected.slice(ml, selected.length - ml);
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: inner },
      selection: { anchor: sel.from, head: sel.from + inner.length },
    });
    return;
  }

  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: marker + selected + marker },
    selection: { anchor: sel.from + ml, head: sel.to + ml },
  });
}

type ListKind = "bullet" | "numbered" | "task";
const ANY_LIST_PREFIX = /^(\s*)(?:- \[[ xX]\] |- |\d+\. )/;

function applyLinePrefixCm(view: EditorView, kind: ListKind) {
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
  const allThisKind = lines.length > 0 && lines.every(l => isThisKind(l.existing));

  const newPrefix = (i: number, indent: string): string => {
    if (kind === "bullet") return `${indent}- `;
    if (kind === "task") return `${indent}- [ ] `;
    return `${indent}${i + 1}. `;
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

function computeActiveFormats(state: EditorState): ActiveFormats {
  const pos = state.selection.main.head;
  const tree = syntaxTree(state);
  let headingLevel: ActiveFormats["headingLevel"] = 0;
  let bold = false, italic = false, underline = false, strike = false;
  let blockquote = false, codeFence = false;

  let node = tree.resolveInner(pos, -1);
  while (node) {
    const name = node.name;
    const hMatch = name.match(/^ATXHeading(\d)$/);
    if (hMatch) {
      headingLevel = Math.min(parseInt(hMatch[1]!, 10), 6) as ActiveFormats["headingLevel"];
    }
    if (name === "StrongEmphasis") {
      if (state.doc.sliceString(node.from, node.from + 1) === "_") underline = true;
      else bold = true;
    }
    if (name === "Emphasis") italic = true;
    if (name === "Strikethrough") strike = true;
    if (name === "Blockquote") blockquote = true;
    if (name === "FencedCode") codeFence = true;
    if (!node.parent) break;
    node = node.parent;
  }

  return { headingLevel, bold, italic, underline, strike, blockquote, codeFence };
}

function applyBlockquoteCm(view: EditorView) {
  const sel = view.state.selection.main;
  const startLine = view.state.doc.lineAt(sel.from);
  const endLine = view.state.doc.lineAt(sel.to);

  const lines: { from: number; text: string }[] = [];
  for (let n = startLine.number; n <= endLine.number; n++) {
    const line = view.state.doc.line(n);
    lines.push({ from: line.from, text: line.text });
  }

  const allBlockquote = lines.every(l => l.text.startsWith("> ") || l.text === ">");
  const changes = lines.map(l => {
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

function applyHrCm(view: EditorView) {
  const sel = view.state.selection.main;
  const line = view.state.doc.lineAt(sel.head);
  const insertPos = line.to;
  const prefix = line.text.trim() === "" ? "" : "\n";
  const text = `${prefix}\n---\n`;
  view.dispatch({
    changes: { from: insertPos, to: insertPos, insert: text },
    selection: { anchor: insertPos + text.length },
  });
}

function applyCodeFenceCm(view: EditorView) {
  const sel = view.state.selection.main;
  const line = view.state.doc.lineAt(sel.head);
  const insertPos = line.to;
  const prefix = line.text.trim() === "" ? "" : "\n";
  const text = `${prefix}\n\`\`\`\n\n\`\`\`\n`;
  const cursorPos = insertPos + prefix.length + 5; // land inside the fence
  view.dispatch({
    changes: { from: insertPos, to: insertPos, insert: text },
    selection: { anchor: cursorPos },
  });
}

function insertTableCm(view: EditorView, rows: number, cols: number) {
  const sel = view.state.selection.main;
  const line = view.state.doc.lineAt(sel.head);
  const insertPos = line.to;
  const header = "| " + Array.from({ length: cols }, (_, i) => `Col ${i + 1}`).join(" | ") + " |";
  const sep    = "| " + Array(cols).fill("---").join(" | ") + " |";
  const row    = "| " + Array(cols).fill("   ").join(" | ") + " |";
  const prefix = line.text.trim() === "" ? "" : "\n";
  const text = `${prefix}\n${[header, sep, ...Array(rows).fill(row)].join("\n")}\n`;
  view.dispatch({
    changes: { from: insertPos, to: insertPos, insert: text },
    selection: { anchor: insertPos + prefix.length + 2 },
  });
}

function insertCalloutCm(view: EditorView, type: string) {
  const sel = view.state.selection.main;
  const line = view.state.doc.lineAt(sel.head);
  const insertPos = line.to;
  const prefix = line.text.trim() === "" ? "" : "\n";
  const text = `${prefix}\n> [!${type}]\n> `;
  view.dispatch({
    changes: { from: insertPos, to: insertPos, insert: text },
    selection: { anchor: insertPos + text.length },
  });
}

function applyHeadingCm(view: EditorView, level: 0 | 1 | 2 | 3 | 4 | 5 | 6) {
  const sel = view.state.selection.main;
  const line = view.state.doc.lineAt(sel.head);
  const m = line.text.match(/^(#{1,6}) /);
  const currentPrefixLen = m ? m[1].length + 1 : 0;
  const newPrefix = level > 0 ? "#".repeat(level) + " " : "";
  const delta = newPrefix.length - currentPrefixLen;
  const adjustPos = (pos: number) => {
    if (pos < line.from) return pos;
    return Math.max(line.from + newPrefix.length, pos + delta);
  };
  view.dispatch({
    changes: { from: line.from, to: line.from + currentPrefixLen, insert: newPrefix },
    selection: { anchor: adjustPos(sel.anchor), head: adjustPos(sel.head) },
  });
}

export function WysiwygEditor({
  mode,
  value,
  onChange,
  onSave,
  autoFocus = false,
  collab,
  onAwarenessChange,
  onCollabFatal,
  rendererCtx,
  onPasteImage,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const lastExternalValue = useRef(value);

  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onAwarenessChangeRef = useRef(onAwarenessChange);
  onAwarenessChangeRef.current = onAwarenessChange;
  const onCollabFatalRef = useRef(onCollabFatal);
  onCollabFatalRef.current = onCollabFatal;
  const onPasteImageRef = useRef(onPasteImage);
  onPasteImageRef.current = onPasteImage;

  const [activeFormats, setActiveFormats] = useState<ActiveFormats>(defaultActiveFormats);
  const setActiveFormatsRef = useRef(setActiveFormats);
  setActiveFormatsRef.current = setActiveFormats;

  // Populated after the link dialog callbacks are defined below; used by Ctrl+K keymap.
  const openLinkDialogRef = useRef<() => void>(() => {});

  const initialValueRef = useRef(value);
  const collabRef = useRef(collab);
  const initialModeRef = useRef(mode);
  const initialCtxRef = useRef(rendererCtx ?? defaultRendererCtx);

  // Mount once
  useEffect(() => {
    if (!containerRef.current) return;

    let ydoc: Y.Doc | null = null;
    let awareness: Awareness | null = null;
    let provider: CollabProvider | null = null;
    const collabOpts = collabRef.current;
    const initialMode = initialModeRef.current;
    const initialCtx = buildCtxForMode(initialCtxRef.current, initialMode);

    // Yjs collab setup must happen BEFORE building the extensions array so we
    // can insert yCollab ahead of the decoration plugin. Otherwise our
    // EditorView.decorations provider runs before yCollab's setup, which can
    // misorder remote-cursor decorations relative to our content decorations.
    const yjsExtensions: ReturnType<typeof yCollab>[] = [];
    if (collabOpts) {
      ydoc = new Y.Doc();
      const yText = ydoc.getText("content");

      const initialValue = initialValueRef.current;
      if (initialValue.length > 0) {
        ydoc.transact(() => { yText.insert(0, initialValue); });
      }

      awareness = new Awareness(ydoc);
      // Ink supporters can override the deterministic per-user colour. We
      // only apply it for the foreground colour - the soft "background"
      // colour used for selection highlights stays derived so it always
      // pairs cleanly with the foreground regardless of what hex they
      // picked.
      const overrideColor = collabOpts.user.personalPlan === "ink" ? collabOpts.user.personalPresenceColor ?? null : null;
      const color = overrideColor ?? userColor(collabOpts.user.id);
      const colorLight = userColorLight(collabOpts.user.id);
      awareness.setLocalStateField("user", {
        id: collabOpts.user.id,
        name: collabOpts.user.name,
        color,
        colorLight,
        personalPlan: collabOpts.user.personalPlan ?? "free",
        personalPlanStyle: collabOpts.user.personalPlanStyle ?? null,
      });

      yText.observe(() => {
        const next = yText.toString();
        lastExternalValue.current = next;
        onChangeRef.current?.(next);
      });

      awareness.on("change", () => {
        if (!onAwarenessChangeRef.current) return;
        const states = awareness!.getStates();
        const editors: { userId: string; name: string; color: string; personalPlan?: "free" | "ink"; personalPlanStyle?: string | null }[] = [];
        states.forEach((state, clientId) => {
          if (clientId === ydoc!.clientID) return;
          if (state?.user) {
            editors.push({
              userId: state.user.id ?? String(clientId),
              name: state.user.name ?? "Unknown",
              color: state.user.color ?? "#888",
              personalPlan: state.user.personalPlan === "ink" ? "ink" : "free",
              personalPlanStyle: typeof state.user.personalPlanStyle === "string" ? state.user.personalPlanStyle : null,
            });
          }
        });
        onAwarenessChangeRef.current(editors);
      });

      yjsExtensions.push(yCollab(yText, awareness));

      provider = new CollabProvider(ydoc, awareness, collabOpts.docId, {
        onFatal: (reason) => onCollabFatalRef.current?.(reason),
      });
    }

    const extensions = [
      history(),
      search(),
      markdown({ base: markdownLanguage, extensions: [Wikilink, MdCommentExt], addKeymap: false }),
      // Re-add the markdown keymap manually with nonTightLists:false so that pressing
      // Enter on an empty list item exits the list rather than converting it to a
      // loose (blank-line-separated) list.
      Prec.high(keymap.of([
        { key: "Enter", run: insertNewlineContinueMarkupCommand({ nonTightLists: false }) },
        { key: "Backspace", run: deleteMarkupBackward },
      ])),
      editorTheme,
      EditorView.lineWrapping,
      keymap.of([
        {
          key: "Mod-s",
          run: () => { onSaveRef.current?.(); return true; },
          preventDefault: true,
        },
        {
          key: "Mod-b",
          run: (view) => { applyMarkerCm(view, "**"); return true; },
          preventDefault: true,
        },
        {
          key: "Mod-i",
          run: (view) => { applyMarkerCm(view, "*"); return true; },
          preventDefault: true,
        },
        {
          key: "Mod-u",
          run: (view) => { applyMarkerCm(view, "__"); return true; },
          preventDefault: true,
        },
        {
          key: "Mod-k",
          run: () => { openLinkDialogRef.current(); return true; },
          preventDefault: true,
        },
        // Context-aware Enter handling. Each command returns false when not
        // applicable so the next handler (or the default) gets a turn.
        { key: "Enter", run: tableContinueOnEnter },
        { key: "Enter", run: calloutContinueOnEnter },
        { key: "Shift-Enter", run: calloutBreakOnShiftEnter },
        indentWithTab,
        ...historyKeymap,
        ...defaultKeymap,
      ]),
      ...yjsExtensions,
      EditorView.domEventHandlers({
        paste(event, view) {
          if (view.state.readOnly) return false;
          const handler = onPasteImageRef.current;
          if (!handler) return false;
          const items = event.clipboardData?.items;
          if (!items) return false;
          const imageFiles: File[] = [];
          for (const item of items) {
            if (item.kind === "file" && item.type.startsWith("image/")) {
              const f = item.getAsFile();
              if (f) imageFiles.push(f);
            }
          }
          if (imageFiles.length === 0) return false;
          event.preventDefault();
          const pasteSel = view.state.selection.main;
          (async () => {
            const inserts: string[] = [];
            for (const file of imageFiles) {
              try {
                const { url, alt } = await handler(file);
                inserts.push(`![${alt}](${url})`);
              } catch { /* parent surfaces error toast */ }
            }
            if (inserts.length === 0) return;
            const text = inserts.join("\n");
            view.dispatch({
              changes: { from: pasteSel.from, to: pasteSel.to, insert: text },
              selection: { anchor: pasteSel.from + text.length },
            });
          })();
          return true;
        },
      }),
      ctxCompartment.of(ctxExtension(initialCtx)),
      modeCompartment.of(modeExtension(initialMode)),
      EditorView.updateListener.of((update) => {
        if (update.selectionSet || update.docChanged) {
          setActiveFormatsRef.current(computeActiveFormats(update.state));
        }
        if (update.docChanged && !collabOpts) {
          const next = update.state.doc.toString();
          lastExternalValue.current = next;
          onChangeRef.current?.(next);
        }
      }),
    ];

    const state = EditorState.create({
      doc: collabOpts ? (ydoc!.getText("content").toString() || initialValueRef.current) : value,
      extensions,
    });

    const view = new EditorView({
      state,
      parent: containerRef.current,
    });

    viewRef.current = view;
    lastExternalValue.current = value;

    if (autoFocus) view.focus();

    return () => {
      provider?.destroy();
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reconfigure mode without remount
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const ctx = buildCtxForMode(rendererCtx ?? defaultRendererCtx, mode);
    view.dispatch({
      effects: [
        modeCompartment.reconfigure(modeExtension(mode)),
        ctxCompartment.reconfigure(ctxExtension(ctx)),
      ],
    });
  }, [mode, rendererCtx]);

  // Sync external value (non-collab mode only)
  useEffect(() => {
    const view = viewRef.current;
    if (!view || collabRef.current) return;
    if (value === lastExternalValue.current) return;
    lastExternalValue.current = value;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
    });
  }, [value]);

  const [hasSelection, setHasSelection] = useState(false);

  const refreshSelection = useCallback(() => {
    const view = viewRef.current;
    if (!view) { setHasSelection(false); return; }
    setHasSelection(!view.state.selection.main.empty);
  }, []);

  const handleCut = useCallback(async () => {
    const view = viewRef.current;
    if (!view) return;
    const sel = view.state.selection.main;
    if (sel.empty) return;
    const text = view.state.sliceDoc(sel.from, sel.to);
    try { await navigator.clipboard.writeText(text); } catch { return; }
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: "" },
      selection: { anchor: sel.from },
    });
    view.focus();
  }, []);

  const handleCopy = useCallback(async () => {
    const view = viewRef.current;
    if (!view) return;
    const sel = view.state.selection.main;
    if (sel.empty) return;
    const text = view.state.sliceDoc(sel.from, sel.to);
    try { await navigator.clipboard.writeText(text); } catch { /* ignore */ }
    view.focus();
  }, []);

  const handlePaste = useCallback(async () => {
    const view = viewRef.current;
    if (!view) return;
    let text = "";
    try { text = await navigator.clipboard.readText(); } catch { return; }
    if (!text) return;
    const sel = view.state.selection.main;
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: text },
      selection: { anchor: sel.from + text.length },
    });
    view.focus();
  }, []);

  const handleFormat = useCallback((marker: "**" | "*" | "__" | "~~") => {
    const view = viewRef.current;
    if (!view) return;
    applyMarkerCm(view, marker);
    view.focus();
  }, []);

  const handleHeading = useCallback((level: 0 | 1 | 2 | 3 | 4 | 5 | 6) => {
    const view = viewRef.current;
    if (!view) return;
    applyHeadingCm(view, level);
    view.focus();
  }, []);

  const handleList = useCallback((kind: ListKind) => {
    const view = viewRef.current;
    if (!view) return;
    applyLinePrefixCm(view, kind);
    view.focus();
  }, []);

  const handleUndo = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    undo(view);
    view.focus();
  }, []);

  const handleRedo = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    redo(view);
    view.focus();
  }, []);

  const handleFind = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    if (searchPanelOpen(view.state)) closeSearchPanel(view);
    else openSearchPanel(view);
  }, []);

  const handleBlockquote = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    applyBlockquoteCm(view);
    view.focus();
  }, []);

  const handleHr = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    applyHrCm(view);
    view.focus();
  }, []);

  const handleCodeFence = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    applyCodeFenceCm(view);
    view.focus();
  }, []);

  const handleTable = useCallback((rows: number, cols: number) => {
    const view = viewRef.current;
    if (!view) return;
    insertTableCm(view, rows, cols);
    view.focus();
  }, []);

  const handleCallout = useCallback((type: string) => {
    const view = viewRef.current;
    if (!view) return;
    insertCalloutCm(view, type);
    view.focus();
  }, []);

  const [imageDialogOpen, setImageDialogOpen] = useState(false);
  const [imageAlt, setImageAlt] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const imageRangeRef = useRef<{ from: number; to: number }>({ from: 0, to: 0 });

  const handleOpenImageDialog = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    const sel = view.state.selection.main;
    const selected = view.state.sliceDoc(sel.from, sel.to);
    imageRangeRef.current = { from: sel.from, to: sel.to };
    setImageAlt(selected);
    setImageUrl("");
    setImageDialogOpen(true);
  }, []);

  const handleSubmitImage = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    const view = viewRef.current;
    if (!view) return;
    const url = imageUrl.trim();
    if (!url) return;
    const alt = imageAlt.trim();
    const insert = `![${alt}](${url})`;
    const { from, to } = imageRangeRef.current;
    view.dispatch({
      changes: { from, to, insert },
      selection: { anchor: from + insert.length },
    });
    setImageDialogOpen(false);
    view.focus();
  }, [imageAlt, imageUrl]);

  // ── Image comparison slider (juxtapose fenced block) ──────────────────────
  const [compareOpen, setCompareOpen] = useState(false);
  const [cmpBefore, setCmpBefore] = useState("");
  const [cmpAfter, setCmpAfter] = useState("");
  const [cmpBeforeLabel, setCmpBeforeLabel] = useState("");
  const [cmpAfterLabel, setCmpAfterLabel] = useState("");
  const [cmpOrientation, setCmpOrientation] = useState<"horizontal" | "vertical">("horizontal");
  const [cmpHandle, setCmpHandle] = useState<"arrows" | "bar">("arrows");
  const [cmpColorMode, setCmpColorMode] = useState<"default" | "accent" | "custom">("default");
  const [cmpCustomColor, setCmpCustomColor] = useState("#3b82f6");
  const [cmpUploading, setCmpUploading] = useState<null | "before" | "after">(null);
  const compareRangeRef = useRef<{ from: number; to: number }>({ from: 0, to: 0 });
  const cmpBeforeFileRef = useRef<HTMLInputElement>(null);
  const cmpAfterFileRef = useRef<HTMLInputElement>(null);

  const handleOpenCompareDialog = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    const sel = view.state.selection.main;
    compareRangeRef.current = { from: sel.from, to: sel.to };
    setCmpBefore("");
    setCmpAfter("");
    setCmpBeforeLabel("");
    setCmpAfterLabel("");
    setCmpOrientation("horizontal");
    setCmpHandle("arrows");
    setCmpColorMode("default");
    setCmpCustomColor("#3b82f6");
    setCmpUploading(null);
    setCompareOpen(true);
  }, []);

  const handleCompareUpload = useCallback(async (which: "before" | "after", file: File) => {
    const handler = onPasteImageRef.current;
    if (!handler) return;
    setCmpUploading(which);
    try {
      const { url } = await handler(file);
      if (which === "before") setCmpBefore(url);
      else setCmpAfter(url);
    } catch {
      // onPasteImage surfaces upload failures via toast.
    } finally {
      setCmpUploading(null);
    }
  }, []);

  const handleSubmitCompare = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    const view = viewRef.current;
    if (!view) return;
    const before = cmpBefore.trim();
    const after = cmpAfter.trim();
    if (!before || !after) return;
    const bLabel = cmpBeforeLabel.trim();
    const aLabel = cmpAfterLabel.trim();
    const lines = ["```juxtapose"];
    lines.push(`before: ${before}${bLabel ? ` "${bLabel}"` : ""}`);
    lines.push(`after: ${after}${aLabel ? ` "${aLabel}"` : ""}`);
    if (cmpOrientation === "vertical") lines.push("orientation: vertical");
    if (cmpHandle === "bar") lines.push("handle: bar");
    if (cmpColorMode === "accent") lines.push("accent: theme");
    else if (cmpColorMode === "custom") lines.push(`accent: ${cmpCustomColor.trim()}`);
    lines.push("```");
    const block = lines.join("\n");

    // Keep the fence on its own lines: prepend a newline unless we're already at
    // a line start, and always follow with one.
    const { from, to } = compareRangeRef.current;
    const atLineStart = from === 0 || view.state.doc.sliceString(from - 1, from) === "\n";
    const insert = `${atLineStart ? "" : "\n"}${block}\n`;
    view.dispatch({
      changes: { from, to, insert },
      selection: { anchor: from + insert.length },
    });
    setCompareOpen(false);
    view.focus();
  }, [cmpBefore, cmpAfter, cmpBeforeLabel, cmpAfterLabel, cmpOrientation, cmpHandle, cmpColorMode, cmpCustomColor]);

  const [linkDialogOpen, setLinkDialogOpen] = useState(false);
  const [linkText, setLinkText] = useState("");
  const [linkUrl, setLinkUrl] = useState("");
  const linkRangeRef = useRef<{ from: number; to: number }>({ from: 0, to: 0 });

  const handleOpenLinkDialog = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    const sel = view.state.selection.main;
    const selected = view.state.sliceDoc(sel.from, sel.to);
    linkRangeRef.current = { from: sel.from, to: sel.to };
    setLinkText(selected);
    setLinkUrl("");
    setLinkDialogOpen(true);
  }, []);
  openLinkDialogRef.current = handleOpenLinkDialog;

  const handleSubmitLink = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    const view = viewRef.current;
    if (!view) return;
    const url = linkUrl.trim();
    if (!url) return;
    const text = linkText.trim() || url;
    const insert = `[${text}](${url})`;
    const { from, to } = linkRangeRef.current;
    view.dispatch({
      changes: { from, to, insert },
      selection: { anchor: from + insert.length },
    });
    setLinkDialogOpen(false);
    view.focus();
  }, [linkText, linkUrl]);

  // Reading mode flows inline (height: auto, no scroll). Editing/raw mode
  // fills its positioned parent (absolute inset-0) via an outer flex wrapper
  // so the toolbar can sit above the scrollable editor area.
  const containerEl = (
    <div
      ref={containerRef}
      className={mode === "reading" ? "cm-wysiwyg cm-wysiwyg--reading" : "cm-wysiwyg absolute inset-0"}
      spellCheck={false}
    />
  );

  if (mode === "reading") return containerEl;

  return (
    <>
    <div className="absolute inset-0 flex flex-col bg-background text-foreground">
      <WysiwygToolbar
        active={activeFormats}
        onFormat={handleFormat}
        onList={handleList}
        onLink={handleOpenLinkDialog}
        onHeading={handleHeading}
        onBlockquote={handleBlockquote}
        onHr={handleHr}
        onCodeFence={handleCodeFence}
        onTable={handleTable}
        onCallout={handleCallout}
        onImage={handleOpenImageDialog}
        onCompare={handleOpenCompareDialog}
        onUndo={handleUndo}
        onRedo={handleRedo}
        onFind={handleFind}
      />
      <div className="relative flex-1 overflow-hidden">
        <ContextMenu onOpenChange={(open) => { if (open) refreshSelection(); }}>
          <ContextMenuTrigger asChild>{containerEl}</ContextMenuTrigger>
          <ContextMenuContent className="w-48">
            <ContextMenuItem disabled={!hasSelection} onSelect={handleCut}>
              <Scissors />
              Cut
              <ContextMenuShortcut>Ctrl+X</ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuItem disabled={!hasSelection} onSelect={handleCopy}>
              <Copy />
              Copy
              <ContextMenuShortcut>Ctrl+C</ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuItem onSelect={handlePaste}>
              <ClipboardPaste />
              Paste
              <ContextMenuShortcut>Ctrl+V</ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={handleOpenLinkDialog}>
              <LinkIcon />
              Create link…
              <ContextMenuShortcut>Ctrl+K</ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuSub>
              <ContextMenuSubTrigger
                disabled={!hasSelection}
                className="gap-2 data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
              >
                <Type />
                Format
              </ContextMenuSubTrigger>
              <ContextMenuSubContent className="w-44">
                <ContextMenuItem onSelect={() => handleFormat("**")}>
                  <Bold />
                  Bold
                  <ContextMenuShortcut>Ctrl+B</ContextMenuShortcut>
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => handleFormat("*")}>
                  <Italic />
                  Italic
                  <ContextMenuShortcut>Ctrl+I</ContextMenuShortcut>
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => handleFormat("__")}>
                  <Underline />
                  Underline
                  <ContextMenuShortcut>Ctrl+U</ContextMenuShortcut>
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => handleFormat("~~")}>
                  <Strikethrough />
                  Strikethrough
                </ContextMenuItem>
              </ContextMenuSubContent>
            </ContextMenuSub>
            <ContextMenuSub>
              <ContextMenuSubTrigger className="gap-2">
                <Pilcrow />
                Paragraph
              </ContextMenuSubTrigger>
              <ContextMenuSubContent className="w-48">
                <ContextMenuItem onSelect={() => handleList("bullet")}>
                  <List />
                  Bullet list
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => handleList("numbered")}>
                  <ListOrdered />
                  Numbered list
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => handleList("task")}>
                  <ListChecks />
                  Task list
                </ContextMenuItem>
              </ContextMenuSubContent>
            </ContextMenuSub>
          </ContextMenuContent>
        </ContextMenu>
      </div>
    </div>
    <Dialog open={linkDialogOpen} onOpenChange={setLinkDialogOpen}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Create link</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmitLink} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="link-text">Text</Label>
            <Input
              id="link-text"
              placeholder="Link text"
              value={linkText}
              onChange={e => setLinkText(e.target.value)}
              autoFocus={linkText.length === 0}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="link-url">URL</Label>
            <Input
              id="link-url"
              type="url"
              placeholder="https://example.com"
              value={linkUrl}
              onChange={e => setLinkUrl(e.target.value)}
              autoFocus={linkText.length > 0}
              required
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setLinkDialogOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={!linkUrl.trim()}>Insert</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
    <Dialog open={imageDialogOpen} onOpenChange={setImageDialogOpen}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Insert image</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmitImage} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="image-alt">Alt text</Label>
            <Input
              id="image-alt"
              placeholder="Image description"
              value={imageAlt}
              onChange={e => setImageAlt(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="image-url">URL</Label>
            <Input
              id="image-url"
              type="url"
              placeholder="https://example.com/image.png"
              value={imageUrl}
              onChange={e => setImageUrl(e.target.value)}
              autoFocus
              required
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setImageDialogOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={!imageUrl.trim()}>Insert</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
    <Dialog open={compareOpen} onOpenChange={setCompareOpen}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Insert image comparison</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmitCompare} className="flex flex-col gap-4">
          {(["before", "after"] as const).map((which) => {
            const url = which === "before" ? cmpBefore : cmpAfter;
            const setUrl = which === "before" ? setCmpBefore : setCmpAfter;
            const label = which === "before" ? cmpBeforeLabel : cmpAfterLabel;
            const setLabel = which === "before" ? setCmpBeforeLabel : setCmpAfterLabel;
            const fileRef = which === "before" ? cmpBeforeFileRef : cmpAfterFileRef;
            const uploading = cmpUploading === which;
            return (
              <div key={which} className="flex flex-col gap-2 rounded-md border border-border p-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium capitalize">{which} image</span>
                  {url && <Check className="h-4 w-4 text-green-600" aria-label="Image set" />}
                </div>
                <div className="flex gap-2">
                  <Input
                    aria-label={`${which} image URL`}
                    placeholder="Image URL"
                    value={url}
                    onChange={e => setUrl(e.target.value)}
                  />
                  {onPasteImage && (
                    <>
                      <input
                        ref={fileRef}
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={e => {
                          const file = e.target.files?.[0];
                          if (file) handleCompareUpload(which, file);
                          e.target.value = "";
                        }}
                      />
                      <Button
                        type="button"
                        variant="outline"
                        className="shrink-0 gap-1.5"
                        disabled={uploading}
                        onClick={() => fileRef.current?.click()}
                      >
                        {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                        Upload
                      </Button>
                    </>
                  )}
                </div>
                <Input
                  aria-label={`${which} label`}
                  placeholder="Label (optional)"
                  value={label}
                  onChange={e => setLabel(e.target.value)}
                />
              </div>
            );
          })}
          <div className="flex flex-col gap-1.5">
            <Label>Orientation</Label>
            <div className="flex gap-2">
              <Button
                type="button"
                variant={cmpOrientation === "horizontal" ? "default" : "outline"}
                className="flex-1"
                onClick={() => setCmpOrientation("horizontal")}
              >
                Horizontal
              </Button>
              <Button
                type="button"
                variant={cmpOrientation === "vertical" ? "default" : "outline"}
                className="flex-1"
                onClick={() => setCmpOrientation("vertical")}
              >
                Vertical
              </Button>
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Handle style</Label>
            <div className="flex gap-2">
              <Button
                type="button"
                variant={cmpHandle === "arrows" ? "default" : "outline"}
                className="flex-1"
                onClick={() => setCmpHandle("arrows")}
              >
                Circle + arrows
              </Button>
              <Button
                type="button"
                variant={cmpHandle === "bar" ? "default" : "outline"}
                className="flex-1"
                onClick={() => setCmpHandle("bar")}
              >
                Slim grip bar
              </Button>
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Handle colour</Label>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant={cmpColorMode === "default" ? "default" : "outline"}
                onClick={() => setCmpColorMode("default")}
              >
                Default
              </Button>
              <Button
                type="button"
                variant={cmpColorMode === "accent" ? "default" : "outline"}
                onClick={() => setCmpColorMode("accent")}
              >
                Theme accent
              </Button>
              <Button
                type="button"
                variant={cmpColorMode === "custom" ? "default" : "outline"}
                onClick={() => setCmpColorMode("custom")}
              >
                Custom
              </Button>
              {cmpColorMode === "custom" && <ColorPicker value={cmpCustomColor} onChange={setCmpCustomColor} />}
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setCompareOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={!cmpBefore.trim() || !cmpAfter.trim() || cmpUploading !== null}>Insert</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
    </>
  );
}
