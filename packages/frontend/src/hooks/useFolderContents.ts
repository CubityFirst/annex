import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetchJson } from "@/lib/apiFetch";
import type { FolderCounts } from "@/lib/fileManager";

// The listing state for one folder of the File Manager: folders / docs / files
// plus per-folder counts and the breadcrumb ancestor chain. Owns the load
// lifecycle so the component doesn't have to:
//
// - A monotonically-increasing sequence number tags every load; a response is
//   applied only if it is still the newest request, so rapid navigation can
//   never leave folder A's contents rendered under folder B's URL.
// - The skeleton only appears when a load takes >150ms (the timer also clears
//   the previous folder's rows at that point, so fast loads swap in place).
// - A failed load sets `error` (surfaced as a retry state) instead of leaving
//   the cleared lists looking like an empty folder.

export interface FolderItem {
  id: string;
  name: string;
  project_id: string;
  parent_id: string | null;
  created_at: string;
}

type Role = "viewer" | "editor" | "admin" | "owner";

export interface DocItem {
  id: string;
  title: string;
  folder_id: string | null;
  updated_at: string;
  author_id?: string;
  author_name?: string;
  author_role?: Role | null;
  is_home?: number;
}

export interface FileItem {
  id: string;
  name: string;
  mime_type: string;
  size: number;
  folder_id: string | null;
  uploaded_by: string;
  created_at: string;
  updated_at?: string;
  uploader_name?: string;
  uploader_role?: Role | null;
}

export interface BreadcrumbEntry {
  id: string | null;
  name: string;
}

interface ContentsResponse {
  folders: FolderItem[];
  docs: DocItem[];
  files: FileItem[];
  // `files` is absent from responses of API deploys that predate the
  // docs/files count split - treat missing as 0.
  folderCounts: Record<string, { docs: number; files?: number; folders: number }>;
  ancestors: { id: string; name: string }[];
}

export function useFolderContents(projectId: string, folderId: string | null, projectName: string) {
  const [folders, setFolders] = useState<FolderItem[]>([]);
  const [docs, setDocs] = useState<DocItem[]>([]);
  const [files, setFiles] = useState<FileItem[]>([]);
  const [folderCounts, setFolderCounts] = useState<Map<string, FolderCounts>>(new Map());
  // Breadcrumb path is rebuilt from the API ancestors response on every load.
  // URL (folderId prop) is the source of truth for the current folder.
  const [path, setPath] = useState<BreadcrumbEntry[]>([{ id: null, name: projectName }]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadSeqRef = useRef(0);

  // projectName only feeds the breadcrumb label - read it through a ref so a
  // rename doesn't retrigger a full /contents refetch, and patch the root
  // crumb in place when it changes.
  const projectNameRef = useRef(projectName);
  useEffect(() => {
    projectNameRef.current = projectName;
    setPath(prev => [{ id: null, name: projectName }, ...prev.slice(1)]);
  }, [projectName]);

  const load = useCallback(async () => {
    const seq = ++loadSeqRef.current;
    setError(null);
    if (loadingTimerRef.current) clearTimeout(loadingTimerRef.current);
    loadingTimerRef.current = setTimeout(() => {
      setLoading(true);
      setFolders([]);
      setDocs([]);
      setFiles([]);
    }, 150);

    const folderParam = folderId ? `?folderId=${folderId}` : "";
    const result = await apiFetchJson<ContentsResponse>(`/api/projects/${projectId}/contents${folderParam}`);

    // A newer load started while this one was in flight - let it win.
    if (seq !== loadSeqRef.current) return;
    if (loadingTimerRef.current) { clearTimeout(loadingTimerRef.current); loadingTimerRef.current = null; }
    if (result.redirected) return;

    if (result.ok && result.data) {
      setFolders(result.data.folders);
      setDocs(result.data.docs);
      setFiles(result.data.files);
      const counts = new Map<string, FolderCounts>();
      for (const [id, c] of Object.entries(result.data.folderCounts)) {
        counts.set(id, { docs: c.docs, files: c.files ?? 0, folders: c.folders });
      }
      setFolderCounts(counts);
      const ancestorCrumbs: BreadcrumbEntry[] = (result.data.ancestors ?? []).map(a => ({ id: a.id, name: a.name }));
      setPath([{ id: null, name: projectNameRef.current }, ...ancestorCrumbs]);
    } else {
      setFolders([]);
      setDocs([]);
      setFiles([]);
      setError(result.error ?? "Failed to load this folder.");
    }
    setLoading(false);
  }, [projectId, folderId]);

  useEffect(() => {
    load();
  }, [load]);

  return { folders, setFolders, docs, setDocs, files, setFiles, folderCounts, path, loading, error, reload: load };
}
