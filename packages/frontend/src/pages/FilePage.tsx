import { useState, useEffect, useRef } from "react";
import { useParams, useOutletContext, useLocation, useNavigate } from "react-router-dom";
import { Image, FileCode, FileArchive, FileText, File, Music, Video, Download, Link, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { AuthenticatedImage } from "@/components/AuthenticatedImage";
import { AudioVisualizer } from "@/components/AudioVisualizer";
import { apiFetch, apiFetchJson } from "@/lib/apiFetch";
import { pushRecentItem } from "@/lib/recentDocs";
import type { DocsLayoutContext, BreadcrumbItem } from "@/layouts/DocsLayout";

interface FileRecord {
  id: string;
  name: string;
  mime_type: string;
  size: number;
  project_id: string;
  folder_id: string | null;
  uploaded_by: string;
  created_at: string;
  // Short-lived capability token for streaming this file's bytes by URL, so
  // <video>/<audio>/<iframe> (which can't send the auth header) can seek/stream.
  content_token?: string;
}

function FileTypeIcon({ mimeType, className }: { mimeType: string; className?: string }) {
  if (mimeType.startsWith("image/")) return <Image className={className} />;
  if (mimeType.startsWith("audio/")) return <Music className={className} />;
  if (mimeType.startsWith("video/")) return <Video className={className} />;
  if (mimeType === "application/json" || mimeType.startsWith("text/")) return <FileCode className={className} />;
  if (mimeType.includes("zip") || mimeType.includes("tar") || mimeType.includes("gzip") || mimeType.includes("archive")) return <FileArchive className={className} />;
  if (mimeType === "application/pdf") return <FileText className={className} />;
  return <File className={className} />;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Files we render inline as decoded UTF-8 text. Covers text/* (text/plain,
// text/markdown, text/csv, …) plus a few structured-text application/* types.
function isTextFile(mimeType: string): boolean {
  return (
    mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    mimeType === "application/xml" ||
    mimeType === "application/javascript"
  );
}

// Guard rail so a huge log/dump doesn't lock up the tab — preview the first
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
  const { setBreadcrumbs, projectName } = useOutletContext<DocsLayoutContext>();
  const location = useLocation();
  const navigate = useNavigate();
  const [file, setFile] = useState<FileRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
  const [textContent, setTextContent] = useState<string | null>(null);
  const [textTruncated, setTextTruncated] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    if (!fileId) return;
    apiFetchJson<FileRecord>(`/api/files/${fileId}`)
      .then(result => {
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
          // capability token — no blob fetch. Text is fetched + decoded here so
          // we can render it inline (and cap the preview size).
          if (isTextFile(result.data.mime_type)) {
            apiFetch(`/api/files/${fileId}/content`)
              .then(r => r.arrayBuffer())
              .then(buf => {
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
      .finally(() => setLoading(false));
  }, [fileId]); // eslint-disable-line react-hooks/exhaustive-deps

  // URL the browser can stream/seek directly (token authenticates the request,
  // since media elements can't attach the Authorization header). Null until the
  // metadata — and thus the token — has loaded.
  const contentUrl = file?.content_token
    ? `/api/files/${file.id}/content?token=${encodeURIComponent(file.content_token)}`
    : null;

  async function handleDownload() {
    if (!file) return;
    setDownloading(true);
    try {
      const res = await apiFetch(`/api/files/${file.id}/content`);
      if (!res.ok) return;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = file.name;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setDownloading(false);
    }
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-10">
        <p className="text-sm text-muted-foreground">Loading…</p>
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

  return (
    <div className="mx-auto max-w-2xl px-6 py-10">
      <div className="flex items-center gap-4">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg border border-border bg-muted">
          <FileTypeIcon mimeType={file.mime_type} className="h-6 w-6 text-muted-foreground" />
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

      {file.mime_type.startsWith("image/") && (
        <div className="mt-6 overflow-hidden rounded-lg border border-border bg-muted/30">
          <AuthenticatedImage
            src={`/api/files/${file.id}/content`}
            alt={file.name}
            projectId={projectId}
            className="max-h-[60vh] w-full object-contain"
          />
        </div>
      )}

      {file.mime_type.startsWith("audio/") && contentUrl && (
        <div className="mt-6 rounded-lg border border-border bg-muted/30 p-4">
          <AudioVisualizer audioRef={audioRef} className="mb-3 h-20 text-primary" />
          <audio ref={audioRef} controls preload="metadata" src={contentUrl} className="w-full" />
        </div>
      )}

      {file.mime_type.startsWith("video/") && contentUrl && (
        <div className="mt-6 overflow-hidden rounded-lg border border-border bg-black">
          <video controls preload="metadata" src={contentUrl} className="max-h-[70vh] w-full bg-black">
            Your browser does not support embedded video playback.
          </video>
        </div>
      )}

      {file.mime_type === "application/pdf" && contentUrl && (
        <div className="mt-6 overflow-hidden rounded-lg border border-border bg-muted/30">
          <iframe src={contentUrl} title={file.name} className="h-[75vh] w-full" />
        </div>
      )}

      {isTextFile(file.mime_type) && textContent !== null && (
        <div className="mt-6 overflow-hidden rounded-lg border border-border bg-muted/30">
          <pre className="max-h-[75vh] overflow-auto p-4 text-sm leading-relaxed whitespace-pre-wrap break-words font-mono">
            {textContent}
          </pre>
          {textTruncated && (
            <div className="border-t border-border bg-muted/50 px-4 py-2 text-xs text-muted-foreground">
              Preview truncated at {formatBytes(MAX_TEXT_PREVIEW_BYTES)}. Download the file to see the full contents.
            </div>
          )}
        </div>
      )}

      <div className="mt-8 flex items-center gap-2">
        <Button onClick={handleDownload} disabled={downloading} className="gap-2">
          <Download className="h-4 w-4" />
          {downloading ? "Downloading…" : "Download"}
        </Button>
        {(file.mime_type.startsWith("image/") || file.mime_type.startsWith("audio/")) && (
          <Button
            variant="outline"
            className="gap-2"
            onClick={() => {
              navigator.clipboard.writeText(`![${file.name}](/api/files/${file.id}/content)`);
              setCopiedLink(true);
              setTimeout(() => setCopiedLink(false), 2000);
            }}
          >
            {copiedLink ? <Check className="h-4 w-4 text-green-500" /> : <Link className="h-4 w-4" />}
            {copiedLink ? "Copied!" : "Copy markdown"}
          </Button>
        )}
      </div>
    </div>
  );
}
