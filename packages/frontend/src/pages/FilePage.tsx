import { useState, useEffect, useRef, useMemo, lazy, Suspense } from "react";
import { useParams, useOutletContext, useLocation, useNavigate } from "react-router-dom";
import { Download, Code, Check, MoreHorizontal, Pencil, FolderInput, Trash2, Folder, House } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { AuthenticatedImage } from "@/components/AuthenticatedImage";
import { AudioVisualizer } from "@/components/AudioVisualizer";
import { FileTypeIcon } from "@/components/FileTypeIcon";
import { CodeBlock } from "@/components/CodeBlock";
import { Spinner } from "@/components/ui/spinner";
import { apiFetch, apiFetchJson } from "@/lib/apiFetch";
import { describeFileType, fileKind, guessLanguage } from "@/lib/fileKind";
import { fileEmbedMarkdown } from "@/lib/fileMarkdown";
import { fileContentEtag } from "@/lib/excalidraw";
import { formatBytes, folderPathLabel, type MoveFolderLike } from "@/lib/fileManager";
import { restoreTrashEntry } from "@/lib/trash";
import { downloadStoredFile } from "@/lib/downloadStoredFile";
import { useToast } from "@/hooks/use-toast";
import { isLightTheme } from "@/lib/theme";
import { pushRecentItem } from "@/lib/recentDocs";
import type { DocsLayoutContext, BreadcrumbItem } from "@/layouts/DocsLayout";

// @excalidraw/excalidraw is a heavy chunk - keep it out of the main bundle and
// only fetch it when a drawing is actually opened.
const ExcalidrawCanvas = lazy(() => import("@/components/ExcalidrawCanvas"));

interface FileRecord {
  id: string;
  name: string;
  mime_type: string;
  size: number;
  project_id: string;
  folder_id: string | null;
  uploaded_by: string;
  created_at: string;
  updated_at: string;
  // Short-lived capability token for streaming this file's bytes by URL, so
  // <video>/<audio>/<iframe> (which can't send the auth header) can seek/stream.
  content_token?: string;
  // Presigned R2 URL for video - streams directly from R2 (no Worker in the byte
  // path). Present only for video when R2 S3 creds are configured server-side.
  content_stream_url?: string | null;
}

// Guard rail so a huge log/dump doesn't lock up the tab - preview the first
// chunk and tell the user to download for the rest.
const MAX_TEXT_PREVIEW_BYTES = 512 * 1024;

// The viewer column follows the doc page's container rule (DocPage): a 44rem
// column centred in the content area, with a w-60 rail reserved on the right
// at xl (docs keep their outline there). At xl the column keeps the doc
// column's left edge but may run wider to the right (capped at 56rem), so
// previews get room while the file title lines up with a doc title.
const VIEWER_COLUMN_CLASS =
  "mx-auto max-w-[44rem] xl:mr-0 xl:ml-[max(0px,calc((100%_-_44rem)/2))] xl:max-w-[56rem]";

// Muted 16px menu icons, the destructive item keeping its red (same as the
// File Manager's row menus).
const MENU_CLASS =
  "min-w-[200px] [&_[role=menuitem]]:pr-4 [&_svg:not([class*='size-'])]:size-4 [&_[role=menuitem]:not([data-variant=destructive])_svg]:text-muted-foreground";

// Content area + empty xl rail, mirroring DocPage's reading layout.
function ViewerLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-full">
      <div className="min-w-0 flex-1 px-5 py-6 sm:px-6 sm:py-10">
        <div className={VIEWER_COLUMN_CLASS}>{children}</div>
      </div>
      {/* Empty rail matching the doc outline rail, so the column sits where a doc's does. */}
      <div className="hidden w-60 shrink-0 xl:block" aria-hidden="true" />
    </div>
  );
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric", month: "long", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

export function FilePage() {
  const { projectId, fileId } = useParams<{ projectId: string; fileId: string }>();
  const { setBreadcrumbs, projectName, myRole, theme, customColor, headerActionSlot } = useOutletContext<DocsLayoutContext>();
  const location = useLocation();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [file, setFile] = useState<FileRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
  const [textContent, setTextContent] = useState<string | null>(null);
  const [textTruncated, setTextTruncated] = useState(false);
  const [drawingDirty, setDrawingDirty] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);

  // "⋯" menu (editors): rename / move / delete, mirroring the File Manager's
  // file row actions and API calls.
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameName, setRenameName] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [moveFolders, setMoveFolders] = useState<MoveFolderLike[] | null>(null);
  const [moving, setMoving] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const canEdit = myRole === "editor" || myRole === "admin" || myRole === "owner";

  // Move picker rows: every folder with its full ancestry label, sorted by path.
  const destinations = useMemo(() => {
    const all = moveFolders ?? [];
    const byId = new Map(all.map(f => [f.id, f]));
    return all
      .map(f => ({ folder: f, label: folderPathLabel(all, f, byId) }))
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: "base" }));
  }, [moveFolders]);

  useEffect(() => {
    if (!fileId) return;
    // `cancelled` guards every setState below so a fast fileId change can't
    // land file A's metadata/body under file B (same pattern as the other
    // fetch effects in AuthenticatedImage/ExcalidrawCanvas).
    let cancelled = false;
    setTextContent(null);
    setTextTruncated(false);
    setDrawingDirty(false);
    // One automatic retry on 5xx: a single transient server hiccup otherwise
    // dead-ends the page in "File not found" with no recourse but reload.
    const loadMeta = async () => {
      const first = await apiFetchJson<FileRecord>(`/api/files/${fileId}`);
      if (first.ok || first.redirected || first.status < 500 || cancelled) return first;
      await new Promise(r => setTimeout(r, 300));
      return apiFetchJson<FileRecord>(`/api/files/${fileId}`);
    };
    loadMeta()
      .then(result => {
        if (cancelled) return;
        if (result.ok && result.data) {
          setFile(result.data);
          if (projectId) pushRecentItem(projectId, { id: result.data.id, title: result.data.name, kind: "file", mime: result.data.mime_type });
          // Media (audio/video/pdf) streams directly from the content URL via a
          // capability token - no blob fetch. Text is fetched + decoded here so
          // we can render it inline (and cap the preview size).
          if (fileKind(result.data.mime_type, result.data.name) === "text") {
            apiFetch(`/api/files/${fileId}/content`)
              .then(r => r.arrayBuffer())
              .then(buf => {
                if (cancelled) return;
                const truncated = buf.byteLength > MAX_TEXT_PREVIEW_BYTES;
                const slice = truncated ? buf.slice(0, MAX_TEXT_PREVIEW_BYTES) : buf;
                // Decode as UTF-8 explicitly so non-ASCII bytes render correctly.
                const text = new TextDecoder("utf-8").decode(slice);
                setTextContent(text);
                setTextTruncated(truncated);
              })
              .catch(() => {});
          }
        }
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [fileId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Breadcrumbs live in their own effect (not the fetch above) so they rebuild
  // once the layout's project list resolves - on a direct load the file meta
  // can land before `projectName`, which left an empty leading crumb.
  useEffect(() => {
    if (!file || file.id !== fileId) return;
    const rawPath: { id: string | null; name: string }[] = location.state?.folderPath ?? [];
    const basePath = location.state?.basePath ?? `/projects/${projectId}`;
    // Folder ancestry without the project crumb. FileManager prefixes it; direct nav doesn't.
    const folderAncestry = rawPath.length > 0 && rawPath[0].id === null ? rawPath.slice(1) : rawPath;
    const projectCrumb: BreadcrumbItem = {
      id: null,
      name: projectName,
      onClick: () => navigate(basePath),
    };
    const folderCrumbs: BreadcrumbItem[] = folderAncestry.map(crumb => ({
      id: crumb.id,
      name: crumb.name,
      onClick: () => navigate(crumb.id ? `/projects/${projectId}/folders/${crumb.id}` : basePath),
    }));
    setBreadcrumbs([projectCrumb, ...folderCrumbs, { id: fileId ?? null, name: file.name }]);
  }, [file, fileId, projectId, projectName, location.state, navigate, setBreadcrumbs]);

  // Warn before the tab/window closes while the drawing has unsaved edits.
  // In-app route changes can't be blocked this way: react-router's useBlocker
  // needs a data router and the app mounts a plain <BrowserRouter>, so those
  // navigations rely on the canvas's guarded final-save-on-unmount instead.
  useEffect(() => {
    if (!drawingDirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [drawingDirty]);

  // URL the browser can stream/seek directly (token authenticates the request,
  // since media elements can't attach the Authorization header). Null until the
  // metadata - and thus the token - has loaded.
  const contentUrl = file?.content_token
    ? `/api/files/${file.id}/content?token=${encodeURIComponent(file.content_token)}`
    : null;

  // Video prefers a presigned R2 URL (streams direct from R2, no Worker per
  // range request); falls back to the Worker token route when presigning is off.
  const videoSrc = file?.content_stream_url ?? contentUrl;

  async function handleDownload() {
    if (!file) return;
    // Shared streaming path (lib/downloadStoredFile): mints a FRESH token per
    // click - the page-load token expires after 3h, so a long-open tab would
    // otherwise download the API's error JSON - and falls back to an
    // authenticated blob when no token is available.
    setDownloading(true);
    try {
      if (!(await downloadStoredFile(file.id, file.name))) {
        toast({ title: "Download failed.", variant: "destructive" });
      }
    } finally {
      setDownloading(false);
    }
  }

  async function handleRename(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = renameName.trim();
    if (!file || !trimmed || renaming) return;
    setRenaming(true);
    try {
      const result = await apiFetchJson(`/api/files/${file.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      if (result.ok) {
        setFile(f => (f && f.id === file.id ? { ...f, name: trimmed } : f));
        // Keep the sidebar's "Recently accessed" entry in step with the new name.
        if (projectId) pushRecentItem(projectId, { id: file.id, title: trimmed, kind: "file", mime: file.mime_type });
        setRenameOpen(false);
      } else if (!result.redirected) {
        toast({ title: "Rename failed.", description: result.error, variant: "destructive" });
      }
    } finally {
      setRenaming(false);
    }
  }

  async function openMove() {
    setMoveOpen(true);
    setMoveFolders(null);
    const result = await apiFetchJson<MoveFolderLike[]>(`/api/folders?projectId=${projectId}&all=1`);
    if (result.ok && result.data) setMoveFolders(result.data);
    else {
      setMoveFolders([]);
      if (!result.redirected) toast({ title: "Couldn't load folders.", description: result.error, variant: "destructive" });
    }
  }

  async function handleMoveTo(targetFolderId: string | null) {
    if (!file || moving) return;
    setMoving(true);
    try {
      const result = await apiFetchJson(`/api/files/${file.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folderId: targetFolderId }),
      });
      if (result.ok) {
        setFile(f => (f && f.id === file.id ? { ...f, folder_id: targetFolderId } : f));
        // Rebuild the breadcrumb trail for the new location - the crumbs come
        // from router state, which still describes the old folder.
        const byId = new Map((moveFolders ?? []).map(f => [f.id, f]));
        const chain: { id: string; name: string }[] = [];
        const seen = new Set<string>();
        for (let id = targetFolderId; id && !seen.has(id); id = byId.get(id)?.parent_id ?? null) {
          seen.add(id);
          const folder = byId.get(id);
          if (!folder) break;
          chain.unshift({ id: folder.id, name: folder.name });
        }
        navigate(location.pathname, {
          replace: true,
          state: { ...(location.state ?? {}), folderPath: [{ id: null, name: projectName }, ...chain] },
        });
        setMoveOpen(false);
        const dest = chain.at(-1);
        toast({ title: dest ? `Moved to "${dest.name}".` : "Moved to the top level." });
      } else if (!result.redirected) {
        toast({ title: "Failed to move file.", description: result.error, variant: "destructive" });
      }
    } finally {
      setMoving(false);
    }
  }

  async function handleDelete() {
    if (!file || !projectId || deleting) return;
    setDeleting(true);
    const { id, name, folder_id } = file;
    try {
      const result = await apiFetchJson<{ trashEntryId?: string }>(`/api/files/${id}`, { method: "DELETE" });
      if (result.ok) {
        const entryId = result.data?.trashEntryId;
        setDeleteOpen(false);
        navigate(folder_id ? `/projects/${projectId}/folders/${folder_id}` : `/projects/${projectId}`);
        toast({
          title: `Moved "${name}" to the recycle bin.`,
          action: entryId ? {
            label: "Undo",
            onClick: () => {
              void restoreTrashEntry(projectId, entryId).then(r => {
                if (r.ok) navigate(`/projects/${projectId}/files/${id}`);
                else if (!r.redirected) toast({ title: `Couldn't restore "${name}".`, description: r.error, variant: "destructive" });
              });
            },
          } : undefined,
        });
      } else if (!result.redirected) {
        toast({ title: "Delete failed.", description: result.error, variant: "destructive" });
        setDeleteOpen(false);
      }
    } finally {
      setDeleting(false);
    }
  }

  if (loading) {
    return (
      <ViewerLayout>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner /> Loading…
        </div>
      </ViewerLayout>
    );
  }

  if (!file) {
    return (
      <ViewerLayout>
        <p className="text-sm text-destructive">File not found.</p>
      </ViewerLayout>
    );
  }

  const kind = fileKind(file.mime_type, file.name);

  // Drawings render as a live canvas filling the content area - editor+ get the
  // full editor + Save; everyone else gets a read-only (view-mode) canvas.
  if (kind === "drawing") {
    const exTheme = isLightTheme({ mode: theme, customColor }) ? "light" : "dark";
    return (
      <div className="flex h-full flex-col">
        <Suspense fallback={<div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground"><Spinner /> Loading editor…</div>}>
          <ExcalidrawCanvas
            contentUrl={`/api/files/${file.id}/content`}
            fetcher={(u, init) => apiFetch(u, init)}
            readOnly={!canEdit}
            name={file.name}
            theme={exTheme}
            // If-Match fallback for saves when the content GET exposes no ETag
            // header (same scheme the server uses - see lib/excalidraw).
            fallbackEtag={file.updated_at ? fileContentEtag(file.id, file.updated_at) : undefined}
            // Keep the displayed metadata fresh after each save.
            onSaved={(meta) => setFile(f => (f && f.id === meta.id ? { ...f, size: meta.size, updated_at: meta.updated_at } : f))}
            // Track unsaved edits so the beforeunload warning above can arm.
            onDirtyChange={setDrawingDirty}
            // Render Save in the top bar (title bar) rather than floating over
            // the canvas, where it overlapped Excalidraw's bottom-right "?".
            saveSlot={headerActionSlot}
          />
        </Suspense>
      </div>
    );
  }

  // One viewer column for every kind (image/text/PDF/media) so the header -
  // title, metadata, actions - sits in exactly the same place from file to
  // file, with the title on the same left edge as a doc title (see
  // VIEWER_COLUMN_CLASS; the type icon rides in the metadata line rather than
  // a leading tile, which would push the title off that edge). The header
  // shares the column so its edges line up with the preview.
  return (
    <ViewerLayout>
      <div className="flex flex-wrap items-center gap-4">
        {/* min width lets the actions wrap onto their own line on phones
            instead of squeezing the title to a sliver. */}
        <div className="min-w-[12rem] flex-1">
          <h1 className="truncate text-xl font-semibold tracking-tight">{file.name}</h1>
          {/* Each item carries a leading "·" in its left padding; the row is
              pulled left by that padding and clipped, so the first item on
              every line (including after a wrap) shows no stray separator. */}
          <div className="mt-1 overflow-hidden">
            <p className="-ml-4 flex flex-wrap items-center text-sm text-muted-foreground [&>span]:relative [&>span]:pl-4 [&>span]:before:absolute [&>span]:before:left-1.5 [&>span]:before:text-muted-foreground/50 [&>span]:before:content-['·']">
              <span title={file.mime_type} className="inline-flex items-center gap-1.5">
                <FileTypeIcon mimeType={file.mime_type} name={file.name} className="h-3.5 w-3.5 shrink-0" />
                {describeFileType(file.mime_type, file.name)}
              </span>
              <span>{formatBytes(file.size)}</span>
              <span>Uploaded {formatDate(file.created_at)}</span>
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="outline"
            className="gap-2"
            aria-label={copiedLink ? "Copied" : "Copy embed"}
            title="Copy markdown to embed this file in a doc"
            onClick={() => {
              navigator.clipboard.writeText(fileEmbedMarkdown(file));
              setCopiedLink(true);
              setTimeout(() => setCopiedLink(false), 2000);
            }}
          >
            {copiedLink ? <Check className="h-4 w-4 text-emerald-600 dark:text-emerald-400" aria-hidden="true" /> : <Code className="h-4 w-4" aria-hidden="true" />}
            {copiedLink ? "Copied!" : "Copy embed"}
          </Button>
          <Button onClick={handleDownload} disabled={downloading} className="gap-2">
            <Download className="h-4 w-4" />
            {downloading ? "Downloading…" : "Download"}
          </Button>
          {canEdit && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon" aria-label="More file actions" title="More actions">
                  <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className={MENU_CLASS}>
                <DropdownMenuItem onClick={() => { setRenameName(file.name); setRenameOpen(true); }}>
                  <Pencil />
                  Rename
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => { void openMove(); }}>
                  <FolderInput />
                  Move to folder…
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onClick={() => setDeleteOpen(true)}>
                  <Trash2 />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      {/* The image sits on a thin card "mat" (8-12px) - just enough that
          dark-edged images don't merge into the page, without a heavy frame. */}
      {kind === "image" && (
        <div className="mt-8 rounded-xl border border-border bg-card p-2 sm:p-3">
          <AuthenticatedImage
            src={`/api/files/${file.id}/content`}
            alt={file.name}
            projectId={projectId}
            mimeType={file.mime_type}
            className="max-h-[70vh] w-full rounded-md object-contain"
          />
        </div>
      )}

      {kind === "audio" && contentUrl && (
        <div className="mt-8 rounded-xl border border-border bg-card p-4">
          <AudioVisualizer audioRef={audioRef} className="mb-3 h-20 text-primary" />
          <audio ref={audioRef} controls preload="metadata" src={contentUrl} className="w-full" />
        </div>
      )}

      {kind === "video" && videoSrc && (
        <div className="mt-8 overflow-hidden rounded-xl border border-border bg-black">
          <video
            controls
            preload="metadata"
            src={videoSrc}
            onError={(e) => {
              // A presigned R2 URL can expire while the page sits open; on
              // failure fall back to the in-Worker token route. The endsWith
              // guard stops a retry loop once we're already on that route.
              const v = e.currentTarget;
              if (contentUrl && !v.src.endsWith(contentUrl)) v.src = contentUrl;
            }}
            className="max-h-[70vh] w-full bg-black"
          >
            Your browser does not support embedded video playback.
          </video>
        </div>
      )}

      {kind === "pdf" && contentUrl && (
        <div className="mt-8 overflow-hidden rounded-xl border border-border bg-card">
          {/* sandbox WITHOUT allow-same-origin puts the viewer in an opaque
              origin, so the browser's PDF script can't touch the app origin;
              allow-scripts keeps the viewer itself functional. */}
          <iframe src={contentUrl} title={file.name} referrerPolicy="no-referrer" sandbox="allow-scripts" className="hidden h-[75vh] w-full sm:block" />
          <div className="flex flex-col items-center gap-3 p-6 text-center sm:hidden">
            <FileTypeIcon mimeType={file.mime_type} name={file.name} className="h-8 w-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">PDF preview isn’t available on small screens.</p>
            <Button asChild className="min-h-11 w-full">
              <a href={contentUrl} target="_blank" rel="noreferrer">Open PDF</a>
            </Button>
          </div>
        </div>
      )}

      {kind === "text" && textContent !== null && (
        <div className="mt-8 [&_pre]:text-[13.5px] [&_pre]:leading-6">
          {/* Plain-file preview sits on the card surface (never the
              highlighter theme's own background), framed like the other previews. */}
          <CodeBlock
            lang={guessLanguage(file.name)}
            code={textContent}
            className="!my-0 [&_pre]:max-h-[75vh] [&_pre]:overflow-y-auto [&_pre]:!rounded-xl [&_pre]:!border [&_pre]:!border-border [&_pre]:!bg-card [&_pre]:!p-5"
          />
          {textTruncated && (
            <p className="mt-2 text-xs text-muted-foreground">
              Preview truncated at {formatBytes(MAX_TEXT_PREVIEW_BYTES)}. Download the file to see the full contents.
            </p>
          )}
        </div>
      )}

      {/* Announce the transient copy confirmation to assistive tech (the button
          text swap alone isn't reliably announced). */}
      <div role="status" aria-live="polite" className="sr-only">
        {copiedLink ? "Embed markdown copied to clipboard" : ""}
      </div>

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Rename</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleRename} className="flex flex-col">
            <div className="grid gap-2">
              <Label htmlFor="file-rename-name">Name</Label>
              <Input
                id="file-rename-name"
                value={renameName}
                onChange={e => setRenameName(e.target.value)}
                autoFocus
                required
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setRenameOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={renaming}>
                {renaming ? "Renaming…" : "Rename"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Move-to-folder picker - same rows as the File Manager's. */}
      <Dialog open={moveOpen} onOpenChange={setMoveOpen}>
        <DialogContent className="sm:max-w-xs">
          <DialogHeader>
            <DialogTitle>Move "{file.name}"</DialogTitle>
            <DialogDescription>Choose a destination folder.</DialogDescription>
          </DialogHeader>
          <div className="flex max-h-72 flex-col gap-1 overflow-y-auto">
            {moveFolders === null ? (
              <div className="flex flex-col gap-1.5 py-1">
                {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-9 w-full" />)}
              </div>
            ) : (
              <>
                <button
                  type="button"
                  disabled={moving || file.folder_id === null}
                  onClick={() => handleMoveTo(null)}
                  className="flex items-center gap-2 rounded-sm px-2 py-2 text-left text-sm hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  <House className="h-4 w-4 shrink-0 text-primary/70" aria-hidden="true" />
                  <span className="truncate">{projectName} (home)</span>
                </button>
                {destinations.map(({ folder: f, label }) => (
                  <button
                    key={f.id}
                    type="button"
                    disabled={moving || file.folder_id === f.id}
                    onClick={() => handleMoveTo(f.id)}
                    title={label}
                    className="flex items-center gap-2 rounded-sm px-2 py-2 text-left text-sm hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  >
                    <Folder className="h-4 w-4 shrink-0 text-primary/70" aria-hidden="true" />
                    <span className="truncate">{label}</span>
                  </button>
                ))}
                {destinations.length === 0 && (
                  <p className="px-2 py-2 text-sm text-muted-foreground">No folders yet.</p>
                )}
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete "{file.name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              It will be moved to the recycle bin, where it can be restored for 30 days.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={e => { e.preventDefault(); void handleDelete(); }}
              disabled={deleting}
            >
              {deleting ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ViewerLayout>
  );
}
