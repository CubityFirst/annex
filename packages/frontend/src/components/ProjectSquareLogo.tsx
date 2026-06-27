import { useState, useEffect } from "react";
import { BookOpen } from "lucide-react";
import { cn } from "@/lib/utils";
import { getToken } from "@/lib/auth";

interface Props {
  projectId: string;
  /** ISO timestamp from `projects.logo_square_updated_at`. Null/undefined means no square logo uploaded - render the BookOpen fallback. */
  logoSquareUpdatedAt: string | null | undefined;
  /** Tailwind size classes for both the `<img>` and the BookOpen fallback (e.g. "h-4 w-4"). */
  className?: string;
}

// Module-scoped cache of resolved blob URLs keyed by `${projectId}|${updatedAt}`.
// Without this, mounting N copies of the sidebar / switching routes refetches
// the same logo. Browser HTTP cache helps after the first load but the fetch
// still incurs an auth round-trip; the blob URL is reusable for the lifetime
// of the tab.
const blobUrlCache = new Map<string, string>();
const inflight = new Map<string, Promise<string | null>>();

function fetchLogoBlobUrl(projectId: string, updatedAt: string): Promise<string | null> {
  const key = `${projectId}|${updatedAt}`;
  const cached = blobUrlCache.get(key);
  if (cached) return Promise.resolve(cached);
  const existing = inflight.get(key);
  if (existing) return existing;

  const token = getToken();
  if (!token) return Promise.resolve(null);
  const p = fetch(`/api/projects/${projectId}/logo/square?v=${encodeURIComponent(updatedAt)}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
    .then(r => r.ok ? r.blob() : null)
    .then(blob => {
      if (!blob) return null;
      const url = URL.createObjectURL(blob);
      blobUrlCache.set(key, url);
      return url;
    })
    .catch(() => null)
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

export function ProjectSquareLogo({ projectId, logoSquareUpdatedAt, className }: Props) {
  const [src, setSrc] = useState<string | null>(() => {
    if (!logoSquareUpdatedAt) return null;
    return blobUrlCache.get(`${projectId}|${logoSquareUpdatedAt}`) ?? null;
  });

  useEffect(() => {
    if (!logoSquareUpdatedAt) {
      setSrc(null);
      return;
    }
    let cancelled = false;
    fetchLogoBlobUrl(projectId, logoSquareUpdatedAt).then(url => {
      if (!cancelled) setSrc(url);
    });
    return () => { cancelled = true; };
  }, [projectId, logoSquareUpdatedAt]);

  if (logoSquareUpdatedAt && src) {
    return <img src={src} alt="" className={cn("shrink-0 rounded object-cover", className)} />;
  }
  return <BookOpen className={cn("shrink-0", className)} />;
}
