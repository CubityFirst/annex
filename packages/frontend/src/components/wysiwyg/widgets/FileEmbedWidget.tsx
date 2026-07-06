import { useEffect, useState, createElement, type ReactElement } from "react";
import { WidgetType, type EditorView } from "@codemirror/view";
import { Download } from "lucide-react";
import { ReactWidget } from "./ReactWidget";
import { useRendererCtx } from "../context/RendererContext";
import { apiFetch, apiFetchJson } from "@/lib/apiFetch";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { FileTypeIcon } from "@/components/FileTypeIcon";

// A ```file fenced block whose body is a file id renders a download card for
// that file: type icon, name, size, and a Download button. The syntax is what
// the "Copy markdown" action in FilePage/FileManager emits for non-media kinds
// (media uses ![name](url), drawings use ```excalidraw).

interface FileMeta {
  name: string;
  mime_type: string;
  size: number;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function FileEmbedInner({ fileId }: { fileId: string }): ReactElement {
  const ctx = useRendererCtx();
  const [meta, setMeta] = useState<FileMeta | null>(null);
  const [metaFailed, setMetaFailed] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadFailed, setDownloadFailed] = useState(false);

  // Same content-URL + fetcher split as ExcalidrawEmbedWidget: authed apiFetch
  // in the app, plain fetch for published content (which needs no auth header).
  const isPublic = ctx.isPublic;
  const projectId = ctx.projectId;

  useEffect(() => {
    let cancelled = false;
    const apply = (m: FileMeta | null) => {
      if (cancelled) return;
      if (m) setMeta(m); else setMetaFailed(true);
    };
    if (isPublic) {
      fetch(`/api/public/files/${fileId}?projectId=${projectId ?? ""}`)
        .then(r => (r.ok ? r.json() : null))
        .then((body: { ok?: boolean; data?: FileMeta } | null) => apply(body?.ok && body.data ? body.data : null))
        .catch(() => apply(null));
    } else {
      apiFetchJson<FileMeta>(`/api/files/${fileId}`)
        .then(result => apply(result.ok && result.data ? result.data : null))
        .catch(() => apply(null));
    }
    return () => { cancelled = true; };
  }, [fileId, isPublic, projectId]);

  async function handleDownload() {
    setDownloading(true);
    setDownloadFailed(false);
    try {
      const contentUrl = isPublic
        ? `/api/public/files/${fileId}/content?projectId=${projectId ?? ""}`
        : `/api/files/${fileId}/content`;
      const res = isPublic ? await fetch(contentUrl) : await apiFetch(contentUrl);
      if (!res.ok) { setDownloadFailed(true); return; }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = meta?.name ?? "download";
      a.click();
      URL.revokeObjectURL(url);
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
        disabled={downloading}
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

  toDOM(view: EditorView): HTMLElement {
    const el = super.toDOM(view);
    el.classList.add("cm-codefence-widget-root");
    return el;
  }

  protected render(): ReactElement {
    return createElement(FileEmbedInner, { fileId: this.fileId });
  }

  // Deliberately NOT revealOnClick: the Download button owns clicks. The author
  // edits/removes the block by arrowing the cursor into its range (keyboard
  // reveal still fires in codeFence.ts) - matching the excalidraw-embed
  // convention.

  eq(other: WidgetType): boolean {
    return other instanceof FileEmbedWidget && other.fileId === this.fileId;
  }
}
