import { useState, useEffect } from "react";
import { apiFetch } from "@/lib/apiFetch";
import { HELP_MISSING_IMAGES_URL } from "@/lib/helpLinks";
import { Badge } from "@/components/ui/badge";
import { ImageOff } from "lucide-react";

interface Props extends React.ComponentPropsWithoutRef<"img"> {
  projectId?: string;
  /** Public mode: rewrites /api/files/ to /api/public/files/?projectId= and skips auth. */
  isPublic?: boolean;
  /**
   * Declared MIME type of the source. When set and the fetched blob's type
   * differs (e.g. an SVG the API serves as application/octet-stream so it can't
   * be navigated to as a scriptable document), the bytes are re-typed so the
   * <img> decoder accepts them. SVG is special-cased to a data: URL (never a
   * same-origin blob: URL) - see the comment in the effect below.
   */
  mimeType?: string;
}

// Module-level dedup so concurrent renders of the same image src share a single
// network fetch. The browser HTTP cache covers subsequent renders within
// max-age, but the *first* render of a doc with N copies of one image used to
// fire N parallel fetches because the browser doesn't always coalesce
// concurrent fetch() calls. We hold the resolved promise briefly after
// resolution so adjacent component mounts can hit the same in-memory blob.
const inflight = new Map<string, Promise<Blob | null>>();

// btoa wants a binary string; build it in chunks so a large SVG doesn't blow
// the engine's argument-count limit for String.fromCharCode(...spread).
function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function getImageBlob(src: string): Promise<Blob | null> {
  const existing = inflight.get(src);
  if (existing) return existing;
  const p = apiFetch(src).then(r => r.ok ? r.blob() : null, () => null);
  inflight.set(src, p);
  // Evict the entry shortly after resolution. 5s comfortably covers a single
  // document's render cycle without pinning large Blobs in memory afterward.
  // The `=== p` guard avoids racing a newer entry that replaced this one.
  p.then(() => setTimeout(() => {
    if (inflight.get(src) === p) inflight.delete(src);
  }, 5_000));
  return p;
}

export function AuthenticatedImage({ src, alt, projectId, isPublic, mimeType, ...props }: Props) {
  const [resolvedSrc, setResolvedSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);

    if (!src?.startsWith("/api/files/") && !src?.startsWith("/api/public/files/")) {
      setResolvedSrc(src ?? null);
      return;
    }

    if (isPublic) {
      let publicSrc = src;
      if (src.startsWith("/api/files/")) {
        publicSrc = src.replace("/api/files/", "/api/public/files/");
      }
      if (projectId && !publicSrc.includes("projectId=")) {
        publicSrc += (publicSrc.includes("?") ? "&" : "?") + `projectId=${projectId}`;
      }
      setResolvedSrc(publicSrc);
      return;
    }

    let blobUrl: string | null = null;
    let cancelled = false;
    const fetchSrc = projectId ? `${src}?projectId=${projectId}` : src;
    getImageBlob(fetchSrc).then(async blob => {
      if (cancelled) return;
      if (!blob) { setFailed(true); return; }
      // The API serves non-inline-safe images (notably SVG) as
      // application/octet-stream so they can't be navigated to as scriptable
      // documents. The <img> decoder won't accept octet-stream, so we have to
      // restore a renderable type - but HOW matters:
      //   • SVG gets a data: URL. A same-origin blob: URL typed image/svg+xml
      //     would be navigable ("open image in new tab", or any surfacing of
      //     resolvedSrc) and a scripted SVG would then execute in the app
      //     origin with the user's session - undoing the server's defence.
      //     <img> renders data: SVG fine, the URL carries no origin, and
      //     browsers block top-level navigation to data: URLs, so the
      //     script-execution vector is gone.
      //   • Other declared types keep the plain blob: re-wrap - <img>-loaded
      //     rasters can't run script, and blob avoids base64-copying large
      //     images in memory.
      if (/svg/i.test(mimeType ?? "") || /svg/i.test(blob.type)) {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        if (cancelled) return;
        setResolvedSrc(`data:image/svg+xml;base64,${bytesToBase64(bytes)}`);
        return;
      }
      const typed = mimeType && blob.type !== mimeType
        ? new Blob([await blob.arrayBuffer()], { type: mimeType })
        : blob;
      if (cancelled) return;
      blobUrl = URL.createObjectURL(typed);
      setResolvedSrc(blobUrl);
    });
    return () => {
      cancelled = true;
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [src, projectId, isPublic, mimeType]);

  if (failed) {
    return (
      <a href={HELP_MISSING_IMAGES_URL} target="_blank" rel="noopener noreferrer" aria-label="Image unavailable - learn more">
        <Badge variant="destructive" className="inline-flex items-center gap-1.5 font-normal cursor-pointer" title={alt}>
          <ImageOff className="h-3.5 w-3.5 shrink-0" />
          Image unavailable: Learn more about missing images and permissions.
        </Badge>
      </a>
    );
  }

  if (!resolvedSrc) return null;
  // data-original-src lets the PDF export inliner refetch via apiFetch even
  // after the blob URL is revoked; harmless for normal rendering.
  const originalSrc = (typeof src === "string" && (src.startsWith("/api/files/") || src.startsWith("/api/public/files/")))
    ? src
    : undefined;
  return <img src={resolvedSrc} alt={alt} data-original-src={originalSrc} onError={() => setFailed(true)} {...props} />;
}
