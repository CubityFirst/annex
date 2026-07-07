import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { EditorView, keymap } from "@codemirror/view";
import { EditorState, Prec, type Text } from "@codemirror/state";
import { defaultKeymap, historyKeymap, history, indentWithTab, undo, redo } from "@codemirror/commands";
import { search, searchKeymap, openSearchPanel, closeSearchPanel, searchPanelOpen } from "@codemirror/search";
import { markdown, markdownLanguage, insertNewlineContinueMarkupCommand, deleteMarkupBackward } from "@codemirror/lang-markdown";
import { Wikilink } from "./lezer/wikilinkExtension";
import { Comment as MdCommentExt } from "./lezer/commentExtension";
import { tableContinueOnEnter } from "./commands/tableEnter";
import {
  applyMarkerCm,
  applyLinePrefixCm,
  applyBlockquoteCm,
  applyHrCm,
  applyCodeFenceCm,
  insertTableCm,
  insertCalloutCm,
  applyHeadingCm,
  computeActiveFormats,
  type InlineMarker,
  type ListKind,
  type HeadingLevel,
} from "./commands/formatting";
import {
  trackedRangesField,
  addTrackedRange,
  clearTrackedRange,
  getTrackedRange,
  newTrackedRangeId,
} from "./commands/trackedRanges";
import * as Y from "yjs";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
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
import { Bold, ClipboardPaste, Copy, Italic, Link as LinkIcon, List, ListChecks, ListOrdered, Pilcrow, Scissors, Strikethrough, Type, Underline } from "lucide-react";
import { WysiwygToolbar, defaultActiveFormats, modShortcut, type ActiveFormats } from "./WysiwygToolbar";
import { LinkDialog } from "./dialogs/LinkDialog";
import { ImageDialog } from "./dialogs/ImageDialog";
import { CompareDialog } from "./dialogs/CompareDialog";
import "./styles.css";

// A4: onChange serialization (doc.toString() / yText.toString()) is O(doc) per
// keystroke and triggers a parent re-render each time. Debounce it; flush on
// blur, before save (Mod-s) and before the view is destroyed.
const CHANGE_DEBOUNCE_MS = 200;

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

/** Keeps a ref pointing at the latest render's value (O3) - for callback props
 * consumed inside the once-mounted CodeMirror closure. */
function useLatestRef<T>(value: T): React.MutableRefObject<T> {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  });
  return ref;
}

/** C1/C2: capture the current main selection as a tracked range so it can be
 * remapped through any edits (local typing or remote collab ops) that land
 * before the deferred consumer (async upload, dialog submit) uses it. */
function beginTrackedRange(view: EditorView): number {
  const sel = view.state.selection.main;
  const id = newTrackedRangeId();
  view.dispatch({ effects: addTrackedRange.of({ id, from: sel.from, to: sel.to }) });
  return id;
}

/** Resolve a tracked range's CURRENT position. Falls back to the live selection
 * if the range is unknown (field missing / id never registered). The caller is
 * responsible for including `clearTrackedRange.of(id)` in its dispatch. */
function resolveTrackedRange(view: EditorView, id: number | null): { from: number; to: number } {
  const range = id != null ? getTrackedRange(view.state, id) : null;
  if (range) return { from: range.from, to: range.to };
  const sel = view.state.selection.main;
  return { from: sel.from, to: sel.to };
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

  const onSaveRef = useLatestRef(onSave);
  const onChangeRef = useLatestRef(onChange);
  const onAwarenessChangeRef = useLatestRef(onAwarenessChange);
  const onCollabFatalRef = useLatestRef(onCollabFatal);
  const onPasteImageRef = useLatestRef(onPasteImage);

  const [activeFormats, setActiveFormats] = useState<ActiveFormats>(defaultActiveFormats);

  // Populated by an effect after the link dialog callbacks are defined below
  // (O2); used by the Ctrl+K keymap.
  const openLinkDialogRef = useRef<() => void>(() => {});

  // A3/T-H2: in collab mode undo/redo go through a Y.UndoManager scoped to
  // local edits (CM history is not installed there). Null in non-collab mode.
  const collabUndoRef = useRef<Y.UndoManager | null>(null);

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
    let yText: Y.Text | null = null;
    const collabOpts = collabRef.current;
    const initialMode = initialModeRef.current;
    const initialCtx = buildCtxForMode(initialCtxRef.current, initialMode);

    // ── A4: debounced onChange serialization ────────────────────────────────
    // `pendingDoc` holds a cheap Text reference (non-collab); serialization
    // happens once per debounce window, not per keystroke. In collab mode the
    // current text is read from yText at emit time instead.
    let changeTimer: ReturnType<typeof setTimeout> | null = null;
    let changeDirty = false;
    let pendingDoc: Text | null = null;
    const emitChange = () => {
      if (changeTimer !== null) {
        clearTimeout(changeTimer);
        changeTimer = null;
      }
      if (!changeDirty) return;
      changeDirty = false;
      const next = yText ? yText.toString() : pendingDoc?.toString();
      if (next === undefined || next === lastExternalValue.current) return;
      lastExternalValue.current = next;
      onChangeRef.current?.(next);
    };
    const scheduleChange = () => {
      changeDirty = true;
      if (changeTimer !== null) clearTimeout(changeTimer);
      changeTimer = setTimeout(emitChange, CHANGE_DEBOUNCE_MS);
    };

    // Yjs collab setup must happen BEFORE building the extensions array so we
    // can insert yCollab ahead of the decoration plugin. Otherwise our
    // EditorView.decorations provider runs before yCollab's setup, which can
    // misorder remote-cursor decorations relative to our content decorations.
    const yjsExtensions: ReturnType<typeof yCollab>[] = [];
    if (collabOpts) {
      ydoc = new Y.Doc();
      yText = ydoc.getText("content");

      const initialValue = initialValueRef.current;
      if (initialValue.length > 0) {
        ydoc.transact(() => { yText!.insert(0, initialValue); });
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

      yText.observe(() => scheduleChange());

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

      // A3/T-H2: undo must never revert other users' edits. The UndoManager
      // starts with NO tracked origins (Y.UndoManager's default tracks the
      // null origin, which would capture the seed insert above AND
      // CollabProvider's seed-delete - undoing right after connect would then
      // re-insert the seed and duplicate the doc for everyone). y-codemirror's
      // yUndoManager plugin registers the local ySync origin itself, so only
      // this client's own edits become undoable. Remote updates arrive with
      // the websocket as origin and are never captured.
      const undoManager = new Y.UndoManager(yText, { trackedOrigins: new Set() });
      collabUndoRef.current = undoManager;

      yjsExtensions.push(yCollab(yText, awareness, { undoManager }));

      provider = new CollabProvider(ydoc, awareness, collabOpts.docId, {
        onFatal: (reason) => onCollabFatalRef.current?.(reason),
      });
    }

    const extensions = [
      // A3/T-H2: CM history only in non-collab mode - in collab mode it would
      // record remote Yjs updates as undoable local history.
      ...(collabOpts ? [] : [history()]),
      search(),
      trackedRangesField,
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
      EditorView.contentAttributes.of({ "aria-label": "Document content" }),
      keymap.of([
        {
          key: "Mod-s",
          run: () => {
            // A4: a debounced onChange may still be pending. flushSync commits
            // it into the parent's state synchronously (and re-renders, so
            // onSaveRef points at a closure that sees the current content)
            // before the save handler runs.
            if (changeDirty) flushSync(emitChange);
            onSaveRef.current?.();
            return true;
          },
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
        // Context-aware Enter handling: declines (returns false) when the
        // cursor isn't in a table so the default newline gets a turn. The
        // retired callout Enter/Shift+Enter commands are gone - the built-in
        // markup continuation bound at Prec.high above owns blockquote/callout
        // continuation and empty-line exit (T-M2/T-L8).
        { key: "Enter", run: tableContinueOnEnter },
        indentWithTab,
        // A3/T-H2: Mod-z/Mod-y route to the Y.UndoManager in collab mode.
        ...(collabOpts ? yUndoManagerKeymap : historyKeymap),
        // U1/T-M1: Mod-f opens CM's search panel (browser find can't see
        // virtualized/hidden content); Escape closes it, F3/Mod-g navigate.
        ...searchKeymap,
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
          // C1/T-M10: uploads take seconds; local typing or remote collab
          // edits meanwhile shift positions. Track the captured selection so
          // the insert lands at the mapped range, not the stale offsets.
          const rangeId = beginTrackedRange(view);
          (async () => {
            const inserts: string[] = [];
            for (const file of imageFiles) {
              try {
                const { url, alt } = await handler(file);
                inserts.push(`![${alt}](${url})`);
              } catch { /* parent surfaces error toast */ }
            }
            if (viewRef.current !== view) return; // editor unmounted mid-upload
            if (inserts.length === 0) {
              view.dispatch({ effects: clearTrackedRange.of(rangeId) });
              return;
            }
            const { from, to } = resolveTrackedRange(view, rangeId);
            const text = inserts.join("\n");
            view.dispatch({
              changes: { from, to, insert: text },
              selection: { anchor: from + text.length },
              effects: clearTrackedRange.of(rangeId),
            });
          })();
          return true;
        },
        blur: () => {
          // A4: don't leave a pending onChange behind when focus moves away
          // (e.g. to the Save button) - the parent must see current content.
          emitChange();
        },
      }),
      ctxCompartment.of(ctxExtension(initialCtx)),
      modeCompartment.of(modeExtension(initialMode)),
      EditorView.updateListener.of((update) => {
        if (update.selectionSet || update.docChanged) {
          setActiveFormats(computeActiveFormats(update.state));
        }
        if (update.docChanged && !collabOpts) {
          pendingDoc = update.state.doc; // cheap reference; serialized at emit time (A4)
          scheduleChange();
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
      emitChange(); // A4: flush any pending onChange before teardown
      provider?.destroy();
      view.destroy();
      viewRef.current = null;
      collabUndoRef.current = null;
      // C5: destroy the Y.Doc and Awareness too - they hold observer lists and
      // Awareness runs a heartbeat interval that would otherwise leak per
      // collab session.
      awareness?.destroy();
      ydoc?.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reconfigure mode without remount
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    // T-L7: reading mode renders the container div in a different JSX position
    // than editing/raw, so flipping across that boundary makes React discard
    // the old div and mount a new one - stranding the CodeMirror DOM on the
    // discarded element. No current caller flips modes mid-mount, but if one
    // ever does, re-attach the editor DOM to the live container.
    const container = containerRef.current;
    if (container && view.dom.parentElement !== container) {
      container.appendChild(view.dom);
    }
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

  const handleFormat = useCallback((marker: InlineMarker) => {
    const view = viewRef.current;
    if (!view) return;
    applyMarkerCm(view, marker);
    view.focus();
  }, []);

  const handleHeading = useCallback((level: HeadingLevel) => {
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
    // A3/T-H2: collab undo goes through the Y.UndoManager (local edits only);
    // CM history isn't installed in collab mode.
    const um = collabUndoRef.current;
    if (um) um.undo();
    else undo(view);
    view.focus();
  }, []);

  const handleRedo = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    const um = collabUndoRef.current;
    if (um) um.redo();
    else redo(view);
    view.focus();
  }, []);

  const handleFind = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    if (searchPanelOpen(view.state)) {
      closeSearchPanel(view);
      view.focus();
    } else {
      // U5: openSearchPanel focuses (and selects) the panel's query field, so
      // the user can type their search immediately.
      openSearchPanel(view);
    }
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

  // ── Dialogs ────────────────────────────────────────────────────────────────
  // Each dialog captures the selection as a tracked range when it opens (C2):
  // edits made while it is open - local typing or remote collab ops - remap
  // the range, so submit splices at the range's CURRENT position.

  const [linkDialogOpen, setLinkDialogOpen] = useState(false);
  const [linkInitialText, setLinkInitialText] = useState("");
  const linkRangeIdRef = useRef<number | null>(null);

  const handleOpenLinkDialog = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    const sel = view.state.selection.main;
    setLinkInitialText(view.state.sliceDoc(sel.from, sel.to));
    linkRangeIdRef.current = beginTrackedRange(view);
    setLinkDialogOpen(true);
  }, []);

  // O2: ref used by the Ctrl+K keymap; assigned in an effect, not during render.
  useEffect(() => {
    openLinkDialogRef.current = handleOpenLinkDialog;
  }, [handleOpenLinkDialog]);

  const closeLinkDialog = useCallback(() => {
    const view = viewRef.current;
    const id = linkRangeIdRef.current;
    linkRangeIdRef.current = null;
    if (view && id != null) view.dispatch({ effects: clearTrackedRange.of(id) });
    setLinkDialogOpen(false);
  }, []);

  const handleSubmitLink = useCallback(({ text, url }: { text: string; url: string }) => {
    const view = viewRef.current;
    if (!view) return;
    const id = linkRangeIdRef.current;
    linkRangeIdRef.current = null;
    const { from, to } = resolveTrackedRange(view, id);
    const insert = `[${text || url}](${url})`;
    view.dispatch({
      changes: { from, to, insert },
      selection: { anchor: from + insert.length },
      effects: id != null ? clearTrackedRange.of(id) : [],
    });
    setLinkDialogOpen(false);
    view.focus();
  }, []);

  const [imageDialogOpen, setImageDialogOpen] = useState(false);
  const [imageInitialAlt, setImageInitialAlt] = useState("");
  const imageRangeIdRef = useRef<number | null>(null);

  const handleOpenImageDialog = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    const sel = view.state.selection.main;
    setImageInitialAlt(view.state.sliceDoc(sel.from, sel.to));
    imageRangeIdRef.current = beginTrackedRange(view);
    setImageDialogOpen(true);
  }, []);

  const closeImageDialog = useCallback(() => {
    const view = viewRef.current;
    const id = imageRangeIdRef.current;
    imageRangeIdRef.current = null;
    if (view && id != null) view.dispatch({ effects: clearTrackedRange.of(id) });
    setImageDialogOpen(false);
  }, []);

  const handleSubmitImage = useCallback(({ alt, url }: { alt: string; url: string }) => {
    const view = viewRef.current;
    if (!view) return;
    const id = imageRangeIdRef.current;
    imageRangeIdRef.current = null;
    const { from, to } = resolveTrackedRange(view, id);
    const insert = `![${alt}](${url})`;
    view.dispatch({
      changes: { from, to, insert },
      selection: { anchor: from + insert.length },
      effects: id != null ? clearTrackedRange.of(id) : [],
    });
    setImageDialogOpen(false);
    view.focus();
  }, []);

  // ── Image comparison slider (juxtapose fenced block) ──────────────────────
  const [compareOpen, setCompareOpen] = useState(false);
  const compareRangeIdRef = useRef<number | null>(null);

  const handleOpenCompareDialog = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    compareRangeIdRef.current = beginTrackedRange(view);
    setCompareOpen(true);
  }, []);

  const closeCompareDialog = useCallback(() => {
    const view = viewRef.current;
    const id = compareRangeIdRef.current;
    compareRangeIdRef.current = null;
    if (view && id != null) view.dispatch({ effects: clearTrackedRange.of(id) });
    setCompareOpen(false);
  }, []);

  const handleSubmitCompare = useCallback((block: string) => {
    const view = viewRef.current;
    if (!view) return;
    const id = compareRangeIdRef.current;
    compareRangeIdRef.current = null;
    const { from, to } = resolveTrackedRange(view, id);
    // Keep the fence on its own lines: prepend a newline unless we're already at
    // a line start, and always follow with one.
    const atLineStart = from === 0 || view.state.doc.sliceString(from - 1, from) === "\n";
    const insert = `${atLineStart ? "" : "\n"}${block}\n`;
    view.dispatch({
      changes: { from, to, insert },
      selection: { anchor: from + insert.length },
      effects: id != null ? clearTrackedRange.of(id) : [],
    });
    setCompareOpen(false);
    view.focus();
  }, []);

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
              <ContextMenuShortcut>{modShortcut("X")}</ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuItem disabled={!hasSelection} onSelect={handleCopy}>
              <Copy />
              Copy
              <ContextMenuShortcut>{modShortcut("C")}</ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuItem onSelect={handlePaste}>
              <ClipboardPaste />
              Paste
              <ContextMenuShortcut>{modShortcut("V")}</ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={handleOpenLinkDialog}>
              <LinkIcon />
              Create link…
              <ContextMenuShortcut>{modShortcut("K")}</ContextMenuShortcut>
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
                  <ContextMenuShortcut>{modShortcut("B")}</ContextMenuShortcut>
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => handleFormat("*")}>
                  <Italic />
                  Italic
                  <ContextMenuShortcut>{modShortcut("I")}</ContextMenuShortcut>
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => handleFormat("__")}>
                  <Underline />
                  Underline
                  <ContextMenuShortcut>{modShortcut("U")}</ContextMenuShortcut>
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
    <LinkDialog
      open={linkDialogOpen}
      initialText={linkInitialText}
      onClose={closeLinkDialog}
      onSubmit={handleSubmitLink}
    />
    <ImageDialog
      open={imageDialogOpen}
      initialAlt={imageInitialAlt}
      onClose={closeImageDialog}
      onSubmit={handleSubmitImage}
    />
    <CompareDialog
      open={compareOpen}
      onClose={closeCompareDialog}
      onSubmit={handleSubmitCompare}
      onUploadImage={onPasteImage}
    />
    </>
  );
}
