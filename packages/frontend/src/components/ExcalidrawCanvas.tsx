import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "@excalidraw/excalidraw/index.css";
import { Excalidraw, serializeAsJSON, getSceneVersion } from "@excalidraw/excalidraw";
import { fileContentEtag } from "@/lib/excalidraw";
import { Check, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useToast } from "@/hooks/use-toast";

// The drawing canvas. Lazily code-split (default export) because
// @excalidraw/excalidraw is a heavy chunk - it must never land in the main
// bundle. One component, two modes:
//   • readOnly  → <Excalidraw viewModeEnabled> for viewers and the public site
//                 (a live, pannable/zoomable canvas).
//   • editable  → editor+ get the full editor plus a single floating Save button
//                 that PUTs the serialized scene to the file's content URL.
// We deliberately add NO toolbar of our own - Excalidraw's built-in menu handles
// export/download/zoom; the only thing we layer on is the Save action. No
// realtime collaboration: a single-editor save/load surface.

// Minimal structural view of the imperative API we use, so we don't couple to
// @excalidraw/excalidraw's deep type paths (which sit behind a "./*" export).
interface ExcalidrawApi {
  getSceneElements: () => readonly unknown[];
  getAppState: () => Record<string, unknown>;
  getFiles: () => Record<string, unknown>;
}

interface Scene {
  elements?: readonly unknown[];
  appState?: Record<string, unknown>;
  files?: Record<string, unknown> | null;
}

interface Props {
  /** Content URL - GET loads the scene; PUT (editable only) saves it. */
  contentUrl: string;
  /** apiFetch for the authed app; plain fetch for the public site. */
  fetcher: (url: string, init?: RequestInit) => Promise<Response>;
  readOnly: boolean;
  name: string;
  theme: "light" | "dark";
  /** Called after a successful save with the PUT response's fresh metadata. */
  onSaved?: (meta: { id: string; size: number; updated_at: string }) => void;
  /** Called whenever the unsaved-changes flag flips (so the page can warn). */
  onDirtyChange?: (dirty: boolean) => void;
  /**
   * Content ETag ("<fileId>-<updatedAtMs>", quoted) derived from the file's
   * metadata, used for If-Match when the GET response exposes no ETag header.
   */
  fallbackEtag?: string;
  /**
   * Where to render the Save button (editable only). Controls placement:
   *   • undefined → floating button overlaid on the canvas (default; public
   *     site, embeds, demo).
   *   • HTMLElement → portal the button into that node (e.g. the page's top bar,
   *     so it can't overlap Excalidraw's own bottom-right "?" help control).
   *   • null → external-slot mode but the slot isn't mounted yet; render no
   *     button (avoids a one-frame flash of the floating button).
   */
  saveSlot?: HTMLElement | null;
}

// Re-skin Excalidraw's UI chrome (not the drawing itself) with the app's neutral
// neutral tokens so its default purple accent doesn't clash with the brand.
// Every selector doubles `.excalidraw.excalidraw` under our wrapper so it
// strictly out-specifies Excalidraw 0.18's own rules (`.excalidraw` /
// `.excalidraw.theme--dark` at 0-2-0, and its `.excalidraw.theme--dark.excalidraw
// .x:hover` dark-mode hovers at 0-5-0) regardless of stylesheet order - the
// lazily-loaded chunk can inject its CSS after this <style> in production.
// Light mode gets the same treatment.
const EX = ".annex-excalidraw .excalidraw.excalidraw";
const EX_DARK = `${EX}.theme--dark`;
const EXCALIDRAW_THEME_CSS = `
${EX} {
  --color-primary: var(--primary);
  --color-primary-darker: color-mix(in oklch, var(--primary) 88%, black);
  --color-primary-darkest: color-mix(in oklch, var(--primary) 76%, black);
  --color-primary-hover: color-mix(in oklch, var(--primary) 88%, black);
  --color-primary-light: var(--accent);
  --color-primary-light-darker: color-mix(in oklch, var(--accent) 85%, var(--foreground));
  --color-brand-hover: color-mix(in oklch, var(--primary) 88%, black);
  --color-brand-active: color-mix(in oklch, var(--primary) 76%, black);
  --color-selection: color-mix(in oklch, var(--primary) 70%, transparent);
  --color-slider-track: var(--border);
  --color-logo-icon: var(--primary);
  --color-logo-text: var(--foreground);
  --color-on-primary-container: var(--foreground);
  --color-surface-primary-container: var(--accent);
  --color-surface-high: var(--accent);
  --color-surface-mid: var(--muted);
  --color-surface-low: var(--muted);
  --color-surface-lowest: var(--background);
  --color-on-surface: var(--foreground);
  --color-border-outline: var(--muted-foreground);
  --color-border-outline-variant: var(--border);
  --color-promo: var(--primary);
  --island-bg-color: var(--card);
  --popup-bg-color: var(--popover);
  --default-bg-color: var(--background);
  --input-bg-color: var(--background);
  --input-border-color: var(--input);
  --input-hover-bg-color: var(--muted);
  --sidebar-bg-color: var(--card);
  --sidebar-border-color: var(--border);
  --default-border-color: var(--border);
  --select-highlight-color: var(--ring);
  --focus-highlight-color: var(--ring);
  --link-color: var(--foreground);
  /* Hovered buttons: a hair above the --accent "selected" fill. */
  --annex-hover: color-mix(in oklch, var(--accent) 94%, var(--foreground));
  --button-hover-bg: var(--annex-hover);
}
${EX_DARK} {
  /* In dark the "darker" accent steps get lighter, as in Excalidraw's own palette. */
  --color-primary-darker: color-mix(in oklch, var(--primary) 88%, white);
  --color-primary-darkest: color-mix(in oklch, var(--primary) 76%, white);
  --color-primary-hover: color-mix(in oklch, var(--primary) 88%, white);
  --color-brand-hover: color-mix(in oklch, var(--primary) 88%, white);
  --color-brand-active: color-mix(in oklch, var(--primary) 76%, white);
}
/* Selected tool / toggled toolbar buttons: the app's quiet accent fill. */
${EX} .ToolIcon .ToolIcon_type_radio:checked + .ToolIcon__icon,
${EX} .ToolIcon .ToolIcon_type_checkbox:checked + .ToolIcon__icon,
${EX} .App-toolbar__extra-tools-trigger--selected,
${EX} .App-toolbar__extra-tools-trigger--selected:hover,
${EX} .dropdown-menu-button.active {
  background: var(--accent);
  color: var(--foreground);
}
/* Excalidraw hard-codes a violet (#363541 / #31303b) for these dark-mode
   hovers and the main/mobile menu buttons instead of using its tokens. */
${EX_DARK} .dropdown-menu-button:hover,
${EX_DARK} .HelpDialog__btn:hover {
  --background: var(--annex-hover);
}
${EX_DARK} .App-mobile-menu,
${EX_DARK} .App-menu__left {
  --button-hover-bg: var(--annex-hover);
  --button-bg: var(--accent);
}
${EX_DARK} .layer-ui__search-header .ExcTextField__input {
  background-color: var(--background);
}
${EX} .App-toolbar__extra-tools-trigger:active {
  box-shadow: 0 0 0 1px var(--border) inset;
}
/* Canvas hint ("To move canvas, hold mouse wheel…"): the app's caption style. */
${EX} .HintViewer,
${EX_DARK} .HintViewer {
  font-size: 12px;
  color: var(--muted-foreground);
}
/* Text that Excalidraw paints white/black on a --color-primary fill: use the
   app's on-primary colour so it stays legible on the cream accent. */
${EX} .Dialog__action-button--primary,
${EX} .ttd-dialog-panel-button.excalidraw-button,
${EX} .library-actions-counter,
${EX} .sidebar-tab-trigger[data-state=active] {
  color: var(--primary-foreground);
}
${EX} .App-toolbar .eraser.active {
  --icon-fill-color: var(--primary-foreground);
  --keybinding-color: var(--primary-foreground);
}
`;

function serialize(api: ExcalidrawApi): string {
  return serializeAsJSON(
    api.getSceneElements() as never,
    api.getAppState() as never,
    api.getFiles() as never,
    "local",
  );
}

// Content identity of a serialized scene: the elements minus their bookkeeping
// fields. Excalidraw bumps version/versionNonce/updated on non-edits too
// (deselection when the Save button steals focus, post-draw normalization), so
// deciding "did the user change anything while the save was in flight?" off
// raw JSON or getSceneVersion() flags pure noise as unsaved edits.
function sceneContentKey(sceneJson: string): string {
  try {
    const parsed = JSON.parse(sceneJson) as { elements?: Record<string, unknown>[] };
    return JSON.stringify((parsed.elements ?? []).map(({ version, versionNonce, updated, ...rest }) => rest));
  } catch {
    return sceneJson;
  }
}

export default function ExcalidrawCanvas({ contentUrl, fetcher, readOnly, name, theme, onSaved, onDirtyChange, fallbackEtag, saveSlot }: Props) {
  const { toast } = useToast();
  const apiRef = useRef<ExcalidrawApi | null>(null);
  const [scene, setScene] = useState<Scene | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  // Concurrency guard (server returns 412 when the content changed since we
  // loaded): the content ETag of the scene we're editing, sent as If-Match on
  // every save. Captured from the GET response, refreshed from each save.
  const etagRef = useRef<string | null>(null);
  // Set when a save came back 412 - someone else saved since we loaded. All
  // saving (explicit, Ctrl-S, exit flush) is parked until the user reloads,
  // so a stale tab can never clobber the newer scene.
  const [conflict, setConflict] = useState(false);
  const conflictRef = useRef(false);
  const [reloadKey, setReloadKey] = useState(0);
  // The in-flight explicit save, resolving to its success. Lets the exit flush
  // wait for the outcome instead of either double-PUTting or silently dropping
  // edits when that save later fails.
  const pendingSaveRef = useRef<Promise<boolean> | null>(null);
  // Content identity of the scene as of the last load/save, plus the cheap
  // scene-version fingerprint that goes with it. Excalidraw keeps firing
  // onChange for selection/hover bookkeeping (including shortly AFTER a save
  // completes), so "any onChange = unsaved changes" would flip the scene
  // straight back to dirty on noise; handleChange compares against these
  // baselines instead.
  const savedKeyRef = useRef<string | null>(null);
  const savedVersionRef = useRef<number | null>(null);
  // Excalidraw fires onChange once on mount (and on mere selection/pan), so we
  // ignore changes until the canvas has settled to avoid a false "unsaved" flag.
  const settledRef = useRef(false);
  // Callers pass inline arrows for these, so identity changes every render. Hold
  // them in refs so the load effect (and the save-on-exit handler) read the
  // latest without re-running / remounting the canvas and discarding edits.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const contentUrlRef = useRef(contentUrl);
  contentUrlRef.current = contentUrl;
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const onDirtyChangeRef = useRef(onDirtyChange);
  onDirtyChangeRef.current = onDirtyChange;
  const fallbackEtagRef = useRef(fallbackEtag);
  fallbackEtagRef.current = fallbackEtag;

  // Single place dirty flips so the ref, the state, and the parent stay in sync.
  const setDirtyState = useCallback((v: boolean) => {
    dirtyRef.current = v;
    setDirty(v);
    onDirtyChangeRef.current?.(v);
  }, []);

  // Same for the conflict flag - ref (read by the save/flush paths) and state
  // (drives the banner + disabled button) must never drift.
  const setConflictState = useCallback((v: boolean) => {
    conflictRef.current = v;
    setConflict(v);
  }, []);

  // Load the scene JSON. cache:"no-store" so an edit-save-reopen always sees the
  // freshly-saved bytes rather than a cached body (the API also no-caches drawings).
  // reloadKey re-runs the load after a 412 conflict ("Reload latest").
  useEffect(() => {
    let cancelled = false;
    setScene(null);
    setLoadError(null);
    // Reset edit state for the new file so the just-loaded scene isn't flagged
    // dirty by Excalidraw's mount-time onChange.
    settledRef.current = false;
    setDirtyState(false);
    setConflictState(false);
    etagRef.current = null;
    fetcherRef.current(contentUrl, { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) throw new Error(`Failed to load drawing (${res.status})`);
        // Remember which content version we loaded so saves can send If-Match
        // (the server 412s a stale save). Fall back to the metadata-derived
        // value when the header isn't exposed (e.g. a stripping proxy).
        etagRef.current = res.headers.get("ETag") ?? fallbackEtagRef.current ?? null;
        return res.json();
      })
      .then((data: Scene) => { if (!cancelled) setScene(data ?? {}); })
      .catch((e: unknown) => { if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [contentUrl, reloadKey, setDirtyState, setConflictState]);

  useEffect(() => {
    if (!scene) return;
    settledRef.current = false;
    savedKeyRef.current = null;
    savedVersionRef.current = null;
    const t = setTimeout(() => {
      settledRef.current = true;
      // Baseline the just-loaded scene once Excalidraw has settled (it
      // normalizes elements on mount, so the stored JSON isn't reliable).
      const api = apiRef.current;
      if (api) {
        savedVersionRef.current = getSceneVersion(api.getSceneElements() as never);
        savedKeyRef.current = sceneContentKey(serialize(api));
      }
    }, 300);
    return () => clearTimeout(t);
  }, [scene]);

  const handleChange = useCallback(() => {
    if (readOnly || !settledRef.current || dirtyRef.current) return;
    const api = apiRef.current;
    if (api && savedVersionRef.current !== null) {
      // Cheap first: unchanged scene version = no element was touched at all
      // (selection/pan/hover noise) - stay clean.
      const version = getSceneVersion(api.getSceneElements() as never);
      if (version === savedVersionRef.current) return;
      // Version moved but content (minus version/updated bookkeeping) is
      // still what we saved - a normalization bump, not an edit. Re-baseline
      // the version so the next noise event takes the cheap path again.
      if (savedKeyRef.current !== null && sceneContentKey(serialize(api)) === savedKeyRef.current) {
        savedVersionRef.current = version;
        return;
      }
    }
    setDirtyState(true);
  }, [readOnly, setDirtyState]);

  const handleSave = useCallback(async () => {
    const api = apiRef.current;
    if (!api || readOnly || !dirtyRef.current || conflictRef.current || savingRef.current) return;
    setSaving(true);
    savingRef.current = true;
    const run = (async (): Promise<boolean> => {
      const payload = serialize(api);
      try {
        const res = await fetcherRef.current(contentUrl, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            ...(etagRef.current ? { "If-Match": etagRef.current } : {}),
          },
          body: payload,
        });
        if (res.status === 412) {
          // The drawing changed since we loaded (another tab/editor saved).
          // Never retry-overwrite: park all saving until the user reloads.
          setConflictState(true);
          toast({
            title: "Drawing changed elsewhere",
            description: "Someone saved a newer version. Reload to get it - saving is paused so it isn't overwritten.",
            variant: "destructive",
          });
          return false;
        }
        if (!res.ok) throw new Error(`Save failed (${res.status})`);
        // Advance the If-Match baseline to the version we just wrote - prefer
        // the server's own ETag header over re-deriving the formula.
        const body = await res.json().catch(() => null) as { data?: { id: string; size: number; updated_at: string } } | null;
        const meta = body?.data;
        const headerEtag = res.headers.get("ETag");
        if (headerEtag) etagRef.current = headerEtag;
        else if (meta?.updated_at) etagRef.current = fileContentEtag(meta.id, meta.updated_at);
        // Clean only if the scene's CONTENT still matches what was sent -
        // element edits made while the PUT was in flight were never
        // serialized and must keep the scene dirty (they'd otherwise be
        // silently lost on navigation). The saved baselines feed
        // handleChange's noise filter.
        savedKeyRef.current = sceneContentKey(payload);
        const clean = sceneContentKey(serialize(api)) === savedKeyRef.current;
        if (clean) savedVersionRef.current = getSceneVersion(api.getSceneElements() as never);
        setDirtyState(!clean);
        if (meta) onSaved?.(meta);
        return true;
      } catch (e) {
        toast({ title: "Couldn't save drawing", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
        return false;
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    })();
    pendingSaveRef.current = run;
    await run;
  }, [contentUrl, readOnly, onSaved, toast, setDirtyState, setConflictState]);

  // Ctrl/Cmd-S saves (editable only).
  useEffect(() => {
    if (readOnly) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void handleSave();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [readOnly, handleSave]);

  // Best-effort save-on-exit so an SPA navigation (react-router unmount, which
  // beforeunload can't catch) or a tab close doesn't silently drop unsaved edits.
  // Guards (uses refs so it always sees the latest scene/url/etag):
  //   • skipped while a save is in flight - a second concurrent PUT could land
  //     older bytes after the newer ones;
  //   • skipped after a 412 conflict - a parked stale tab must never clobber;
  //   • sends the same If-Match as the explicit path, so a stale flush 412s
  //     server-side instead of overwriting.
  // keepalive (lets the request outlive the document) is reserved for genuine
  // page dismissal (pagehide); a plain in-app unmount uses a normal fetch,
  // which the browser completes even after the component is gone. The explicit
  // Save button remains the primary, user-visible path.
  useEffect(() => {
    const flush = (keepalive: boolean) => {
      const api = apiRef.current;
      if (readOnlyRef.current || !dirtyRef.current || !api) return;
      if (conflictRef.current) return;
      if (savingRef.current) {
        // An explicit save is mid-flight. Don't double-PUT - but if the scene
        // is still dirty once it settles (the save failed, or edits landed
        // while it was in flight), those edits would vanish with no toast and
        // no retry, so chase the outcome and re-flush (refs carry the latest
        // state past the unmount).
        void pendingSaveRef.current?.then(() => {
          if (dirtyRef.current && !conflictRef.current) flush(keepalive);
        });
        return;
      }
      try {
        void fetcherRef.current(contentUrlRef.current, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            ...(etagRef.current ? { "If-Match": etagRef.current } : {}),
          },
          body: serialize(api),
          ...(keepalive ? { keepalive: true } : {}),
        });
        // setDirtyState (not raw ref writes) so state/ref/parent stay in sync;
        // after unmount the setState inside is a harmless no-op.
        setDirtyState(false);
      } catch { /* best effort */ }
    };
    const onPageHide = () => flush(true);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      flush(false);
    };
  }, [setDirtyState]);

  if (loadError !== null) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-destructive">
        {loadError}
      </div>
    );
  }

  if (scene === null) {
    return (
      <div className="flex h-full items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
        <Spinner /> Loading drawing…
      </div>
    );
  }

  const initialData = {
    elements: scene.elements ?? [],
    // collaborators is a runtime Map; never feed a serialized object back in.
    appState: { ...(scene.appState ?? {}), collaborators: undefined },
    files: scene.files ?? undefined,
  };

  // Mirrors DocPage's Save button: primary + Save icon while there are
  // unsaved edits; a quiet "Saved" (check) state once everything is persisted.
  // A parked 412 conflict keeps the "Save" label but stays disabled.
  const clean = !saving && !dirty && !conflict;
  const saveLabel = saving ? "Saving…" : clean ? "Saved" : "Save";

  // When a slot is provided we portal the button there (e.g. the page top bar);
  // otherwise it floats over the canvas. The floating placement keeps clear of
  // Excalidraw's own controls but can still sit under the bottom-right help "?".
  const inHeader = saveSlot !== undefined;
  const saveButton = (
    <Button
      size="sm"
      variant={clean ? (inHeader ? "ghost" : "outline") : "default"}
      onClick={() => void handleSave()}
      disabled={saving || !dirty || conflict}
      className={[
        "gap-1.5",
        clean && "text-muted-foreground disabled:opacity-100",
        clean && !inHeader && "bg-card",
        inHeader
          ? ""
          : "absolute right-3 top-3 z-20 h-10 px-4 shadow-md sm:right-4 sm:top-auto sm:bottom-4 sm:h-9 sm:px-3",
      ].filter(Boolean).join(" ")}
    >
      {saving
        ? <Spinner className="h-3.5 w-3.5 text-current" />
        : clean
          ? <Check className="h-3.5 w-3.5" aria-hidden="true" />
          : <Save className="h-3.5 w-3.5" aria-hidden="true" />}
      {saveLabel}
    </Button>
  );

  return (
    <div className="annex-excalidraw relative h-full w-full">
      <style>{EXCALIDRAW_THEME_CSS}</style>
      {/* 412 conflict: a newer version exists on the server. Reload swaps in
          the latest scene (discarding the local unsaved edits it refused to
          save over); until then every save path stays parked. */}
      {conflict && (
        <div className="absolute inset-x-0 top-0 z-30 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-border bg-background/95 px-4 py-2 text-sm">
          <span className="text-destructive">
            This drawing was changed elsewhere - saving is paused so the newer version isn't overwritten.
          </span>
          <Button size="sm" variant="outline" className="h-7" onClick={() => setReloadKey(k => k + 1)}>
            Reload latest
          </Button>
        </div>
      )}
      <Excalidraw
        excalidrawAPI={(api) => { apiRef.current = api as unknown as ExcalidrawApi; }}
        initialData={initialData as never}
        viewModeEnabled={readOnly}
        theme={theme}
        name={name}
        onChange={handleChange}
      />
      {!readOnly && (inHeader
        ? (saveSlot ? createPortal(saveButton, saveSlot) : null)
        : saveButton)}
    </div>
  );
}
