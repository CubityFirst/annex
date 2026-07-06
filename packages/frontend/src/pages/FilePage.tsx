import { useState, useEffect, useRef, lazy, Suspense } from "react";
import { useParams, useOutletContext, useLocation, useNavigate } from "react-router-dom";
import { Download, Link, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { AuthenticatedImage } from "@/components/AuthenticatedImage";
import { AudioVisualizer } from "@/components/AudioVisualizer";
import { FileTypeIcon } from "@/components/FileTypeIcon";
import { CodeBlock } from "@/components/CodeBlock";
import { Spinner } from "@/components/ui/spinner";
import { apiFetch, apiFetchJson } from "@/lib/apiFetch";
import { fileKind, guessLanguage } from "@/lib/fileKind";
import { fileEmbedMarkdown } from "@/lib/fileMarkdown";
import { fileContentEtag } from "@/lib/excalidraw";
import { formatBytes } from "@/lib/fileManager";
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

  useEffect(() => {
    if (!fileId) return;
    // `cancelled` guards every setState below so a fast fileId change can't
    // land file A's metadata/body under file B (same pattern as the other
    // fetch effects in AuthenticatedImage/ExcalidrawCanvas).
    let cancelled = false;
    setTextContent(null);
    setTextTruncated(false);
    setDrawingDirty(false);
    apiFetchJson<FileRecord>(`/api/files/${fileId}`)
      .then(result => {
        if (cancelled) return;
        if (result.ok && result.data) {
          setFile(result.data);
          if (projectId) pushRecentItem(projectId, { id: result.data.id, title: result.data.name, kind: "file", mime: result.data.mime_type });
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
          setBreadcrumbs([projectCrumb, ...folderCrumbs, { id: fileId ?? null, name: result.data.name }]);
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

  if (loading) {
    return (
      <div className="mx-auto flex max-w-2xl items-center gap-2 px-6 py-10 text-sm text-muted-foreground">
        <Spinner /> Loading…
      </div>
    );
  }

  if (!file) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-10">
        <p className="text-sm text-destructive">File not found.</p>
      </div>
    );
  }

  const kind = fileKind(file.mime_type, file.name);

  // Drawings render as a live canvas filling the content area - editor+ get the
  // full editor + Save; everyone else gets a read-only (view-mode) canvas.
  if (kind === "drawing") {
    const canEdit = myRole === "editor" || myRole === "admin" || myRole === "owner";
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

  return (
    <div className="mx-auto max-w-2xl px-6 py-10">
      <div className="flex items-center gap-4">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg border border-border bg-muted">
          <FileTypeIcon mimeType={file.mime_type} name={file.name} className="h-6 w-6 text-muted-foreground" />
        </div>
        <div className="min-w-0">
          <h1 className="truncate text-xl font-semibold">{file.name}</h1>
          <p className="text-sm text-muted-foreground">{file.mime_type}</p>
        </div>
      </div>

      <Separator className="my-6" />

      <dl className="grid grid-cols-[auto_1fr] gap-x-8 gap-y-3 text-sm">
        <dt className="text-muted-foreground">Size</dt>
        <dd>{formatBytes(file.size)}</dd>
        <dt className="text-muted-foreground">Uploaded</dt>
        <dd>{formatDate(file.created_at)}</dd>
      </dl>

      {kind === "image" && (
        <div className="mt-6 overflow-hidden rounded-lg border border-border bg-muted/30">
          <AuthenticatedImage
            src={`/api/files/${file.id}/content`}
            alt={file.name}
            projectId={projectId}
            mimeType={file.mime_type}
            className="max-h-[60vh] w-full object-contain"
          />
        </div>
      )}

      {kind === "audio" && contentUrl && (
        <div className="mt-6 rounded-lg border border-border bg-muted/30 p-4">
          <AudioVisualizer audioRef={audioRef} className="mb-3 h-20 text-primary" />
          <audio ref={audioRef} controls preload="metadata" src={contentUrl} className="w-full" />
        </div>
      )}

      {kind === "video" && videoSrc && (
        <div className="mt-6 overflow-hidden rounded-lg border border-border bg-black">
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
        <div className="mt-6 overflow-hidden rounded-lg border border-border bg-muted/30">
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
        <div className="mt-6">
          <CodeBlock
            lang={guessLanguage(file.name)}
            code={textContent}
            className="[&>pre]:max-h-[75vh] [&>pre]:overflow-y-auto"
          />
          {textTruncated && (
            <p className="mt-2 text-xs text-muted-foreground">
              Preview truncated at {formatBytes(MAX_TEXT_PREVIEW_BYTES)}. Download the file to see the full contents.
            </p>
          )}
        </div>
      )}

      <div className="mt-8 flex flex-wrap items-center gap-2">
        <Button onClick={handleDownload} disabled={downloading} className="gap-2">
          <Download className="h-4 w-4" />
          {downloading ? "Downloading…" : "Download"}
        </Button>
        <Button
          variant="outline"
          className="gap-2"
          aria-label={copiedLink ? "Copied" : "Copy markdown"}
          onClick={() => {
            navigator.clipboard.writeText(fileEmbedMarkdown(file));
            setCopiedLink(true);
            setTimeout(() => setCopiedLink(false), 2000);
          }}
        >
          {copiedLink ? <Check className="h-4 w-4 text-green-500" aria-hidden="true" /> : <Link className="h-4 w-4" aria-hidden="true" />}
          {copiedLink ? "Copied!" : "Copy markdown"}
        </Button>
      </div>
      {/* Announce the transient copy confirmation to assistive tech (the button
          text swap alone isn't reliably announced). */}
      <div role="status" aria-live="polite" className="sr-only">
        {copiedLink ? "Markdown copied to clipboard" : ""}
      </div>
    </div>
  );
}
