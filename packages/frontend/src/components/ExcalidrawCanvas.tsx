import { useCallback, useEffect, useRef, useState } from "react";
import "@excalidraw/excalidraw/index.css";
import { Excalidraw, serializeAsJSON } from "@excalidraw/excalidraw";
import { Check } from "lucide-react";
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
  /** Called after a successful save (e.g. so the page can refresh metadata). */
  onSaved?: () => void;
}

function serialize(api: ExcalidrawApi): string {
  return serializeAsJSON(
    api.getSceneElements() as never,
    api.getAppState() as never,
    api.getFiles() as never,
    "local",
  );
}

export default function ExcalidrawCanvas({ contentUrl, fetcher, readOnly, name, theme, onSaved }: Props) {
  const { toast } = useToast();
  const apiRef = useRef<ExcalidrawApi | null>(null);
  const [scene, setScene] = useState<Scene | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
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

  // Load the scene JSON. cache:"no-store" so an edit-save-reopen always sees the
  // freshly-saved bytes rather than a cached body (the API also no-caches drawings).
  useEffect(() => {
    let cancelled = false;
    setScene(null);
    setLoadError(null);
    // Reset edit state for the new file so the just-loaded scene isn't flagged
    // dirty by Excalidraw's mount-time onChange.
    settledRef.current = false;
    dirtyRef.current = false;
    setDirty(false);
    fetcherRef.current(contentUrl, { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) throw new Error(`Failed to load drawing (${res.status})`);
        return res.json();
      })
      .then((data: Scene) => { if (!cancelled) setScene(data ?? {}); })
      .catch((e: unknown) => { if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [contentUrl]);

  useEffect(() => {
    if (!scene) return;
    settledRef.current = false;
    const t = setTimeout(() => { settledRef.current = true; }, 300);
    return () => clearTimeout(t);
  }, [scene]);

  const handleChange = useCallback(() => {
    if (readOnly || !settledRef.current || dirtyRef.current) return;
    dirtyRef.current = true;
    setDirty(true);
  }, [readOnly]);

  const handleSave = useCallback(async () => {
    const api = apiRef.current;
    if (!api || readOnly || !dirtyRef.current) return;
    setSaving(true);
    try {
      const res = await fetcherRef.current(contentUrl, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: serialize(api),
      });
      if (!res.ok) throw new Error(`Save failed (${res.status})`);
      dirtyRef.current = false;
      setDirty(false);
      setJustSaved(true);
      setTimeout(() => setJustSaved(false), 2000);
      onSaved?.();
    } catch (e) {
      toast({ title: "Couldn't save drawing", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }, [contentUrl, readOnly, onSaved, toast]);

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
  // keepalive lets the request outlive the unmount and still carries the auth
  // header (uses refs so it always sees the latest scene/url). The explicit Save
  // button remains the primary, user-visible path.
  useEffect(() => {
    const flush = () => {
      const api = apiRef.current;
      if (readOnlyRef.current || !dirtyRef.current || !api) return;
      try {
        void fetcherRef.current(contentUrlRef.current, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: serialize(api),
          keepalive: true,
        });
        dirtyRef.current = false;
      } catch { /* best effort */ }
    };
    window.addEventListener("pagehide", flush);
    return () => { window.removeEventListener("pagehide", flush); flush(); };
  }, []);

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

  const saveLabel = saving ? "Saving…" : dirty ? "Save" : justSaved ? "Saved" : "Save";

  return (
    <div className="relative h-full w-full">
      <Excalidraw
        excalidrawAPI={(api) => { apiRef.current = api as unknown as ExcalidrawApi; }}
        initialData={initialData as never}
        viewModeEnabled={readOnly}
        theme={theme}
        name={name}
        onChange={handleChange}
      />
      {!readOnly && (
        <Button
          size="sm"
          onClick={() => void handleSave()}
          disabled={saving || !dirty}
          className="absolute right-3 top-3 z-20 h-10 gap-1.5 px-4 shadow-md sm:right-4 sm:top-auto sm:bottom-4 sm:h-9 sm:px-3"
        >
          {saving ? <Spinner className="h-3.5 w-3.5 text-current" /> : (!dirty && justSaved) ? <Check className="h-3.5 w-3.5" /> : null}
          {saveLabel}
        </Button>
      )}
    </div>
  );
}
