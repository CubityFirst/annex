import { useEffect, useState, createElement, type ReactElement } from "react";
import { WidgetType } from "@codemirror/view";
import { Download } from "lucide-react";
import { ReactWidget } from "./ReactWidget";
import { useRendererCtx } from "../context/RendererContext";
import { isSafeFileId } from "./fileId";
import { apiFetch, apiFetchJson } from "@/lib/apiFetch";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { FileTypeIcon } from "@/components/FileTypeIcon";
import { formatBytes } from "@/lib/fileManager";

// A ```file fenced block whose body is a file id renders a download card for
// that file: type icon, name, size, and a Download button. The syntax is what
// the "Copy markdown" action in FilePage/FileManager emits for non-media kinds
// (media uses ![name](url), drawings use ```excalidraw).

interface FileMeta {
  name: string;
  mime_type: string;
  size: number;
}

// Module-level dedup so reveal cycles (and multiple embeds of one file) share
// a single metadata fetch - same pattern as AuthenticatedImage. Held briefly
// after resolution so a hide→reveal remount hits the in-memory result instead
// of refetching.
const metaInflight = new Map<string, Promise<FileMeta | null>>();

function getFileMeta(url: string, isPublic: boolean): Promise<FileMeta | null> {
  const existing = metaInflight.get(url);
  if (existing) return existing;
  const p: Promise<FileMeta | null> = isPublic
    ? fetch(url)
        .then(r => (r.ok ? r.json() : null))
        .then((body: { ok?: boolean; data?: FileMeta } | null) => (body?.ok && body.data ? body.data : null))
        .catch(() => null)
    : apiFetchJson<FileMeta>(url)
        .then(result => (result.ok && result.data ? result.data : null))
        .catch(() => null);
  metaInflight.set(url, p);
  p.then(() => setTimeout(() => {
    if (metaInflight.get(url) === p) metaInflight.delete(url);
  }, 5_000));
  return p;
}

export function FileEmbedInner({ fileId }: { fileId: string }): ReactElement {
  const ctx = useRendererCtx();
  const [meta, setMeta] = useState<FileMeta | null>(null);
  const [metaFailed, setMetaFailed] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadFailed, setDownloadFailed] = useState(false);

  // Same content-URL + fetcher split as ExcalidrawEmbedWidget: authed apiFetch
  // in the app, plain fetch for published content (which needs no auth header).
  const isPublic = ctx.isPublic;
  const projectId = ctx.projectId;
  // Fence bodies are author-controlled text; only an id-shaped body may be
  // interpolated into an API path (encodeURIComponent is belt-and-braces).
  const validId = isSafeFileId(fileId);
  const encodedId = encodeURIComponent(fileId);

  useEffect(() => {
    // Reset - with DOM-reuse (updateDOM) this component can be re-targeted at
    // a different fileId, and stale meta must not label the new file.
    setMeta(null);
    setMetaFailed(false);
    setDownloadFailed(false);
    if (!validId) {
      setMetaFailed(true);
      return;
    }
    let cancelled = false;
    const metaUrl = isPublic
      ? `/api/public/files/${encodedId}?projectId=${encodeURIComponent(projectId ?? "")}`
      : `/api/files/${encodedId}`;
    getFileMeta(metaUrl, isPublic).then(m => {
      if (cancelled) return;
      if (m) setMeta(m); else setMetaFailed(true);
    });
    return () => { cancelled = true; };
  }, [encodedId, validId, isPublic, projectId]);

  async function handleDownload() {
    setDownloading(true);
    setDownloadFailed(false);
    try {
      const contentUrl = isPublic
        ? `/api/public/files/${encodedId}/content?projectId=${encodeURIComponent(projectId ?? "")}`
        : `/api/files/${encodedId}/content`;
      const res = isPublic ? await fetch(contentUrl) : await apiFetch(contentUrl);
      if (!res.ok) { setDownloadFailed(true); return; }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = meta?.name ?? "download";
      a.click();
      // Revoking immediately races the browser's navigation to the blob URL
      // (the download can silently fail). Give it a generous grace period.
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch {
      setDownloadFailed(true);
    } finally {
      setDownloading(false);
    }
  }

  // Metadata is decoration only - a viewer who can fetch the bytes but not the
  // metadata (e.g. a limited member on a shared doc) still gets a working
  // Download button, just with a generic label.
  const name = meta?.name ?? (metaFailed ? "Attachment" : "Loading…");
  const detail = downloadFailed
    ? "Download failed"
    : meta
      ? formatBytes(meta.size)
      : metaFailed ? "File" : "";

  return (
    <div className="cm-file-embed flex items-center gap-3 rounded-lg border border-border bg-muted/30 px-4 py-3">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-border bg-background">
        <FileTypeIcon mimeType={meta?.mime_type ?? ""} name={meta?.name} className="h-5 w-5 text-muted-foreground" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{name}</div>
        <div className={`truncate text-xs ${downloadFailed ? "text-destructive" : "text-muted-foreground"}`}>{detail}</div>
      </div>
      <Button
        variant="outline"
        size="sm"
        className="shrink-0 gap-2"
        onClick={handleDownload}
        disabled={downloading || !validId}
        aria-label={`Download ${meta?.name ?? "file"}`}
      >
        {downloading ? <Spinner /> : <Download className="h-4 w-4" aria-hidden="true" />}
        Download
      </Button>
    </div>
  );
}

export class FileEmbedWidget extends ReactWidget {
  protected tag: "div" = "div";

  constructor(private readonly fileId: string) {
    super();
  }

  protected rootClass(): string {
    return "cm-codefence-widget-root";
  }

  protected render(): ReactElement {
    return createElement(FileEmbedInner, { fileId: this.fileId });
  }

  // Deliberately NOT revealOnClick: the Download button owns clicks. The author
  // edits/removes the block by arrowing the cursor into its range (keyboard
  // reveal still fires in codeFence.ts) - matching the excalidraw-embed
  // convention.

  // Card height: h-10 icon + py-3 padding + border.
  get estimatedHeight(): number {
    return 66;
  }

  eq(other: WidgetType): boolean {
    return other instanceof FileEmbedWidget && other.fileId === this.fileId;
  }
}
