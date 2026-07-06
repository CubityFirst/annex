import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetchJson } from "@/lib/apiFetch";
import { isDocImportName, stripDocImportExt } from "@/lib/fileManager";
import { EXCALIDRAW_MIME, EXCALIDRAW_EXT } from "@/lib/excalidraw";
import type { DocItem, FileItem } from "@/hooks/useFolderContents";

// Upload pipeline for the File Manager. Each dropped/picked file gets an
// UploadEntry rendered as an Attachment card; entries advance
// queued → uploading → (removed | error).
//
// - At most MAX_CONCURRENT_UPLOADS POSTs run at once; the rest wait in a FIFO
//   queue (a 300-file drop no longer fires 300 parallel requests).
// - Files over the server's 50MB cap fail immediately client-side instead of
//   uploading the whole payload just to be 413'd.
// - Uploads remember the folder they were dropped into; the success handler
//   only appends the new row when the user is still viewing that folder
//   (otherwise the row silently appears in whatever folder they navigated to).
//
// Uploads deliberately go through fetch (apiFetchJson), not XHR: the demo mode
// patches window.fetch, and apiFetch owns the auth header + forced-logout
// handling. The trade-off is no per-file progress percentage.

export interface UploadEntry {
  id: number;
  name: string;
  size: number;
  mime: string;
  status: "queued" | "uploading" | "error";
  error?: string;
}

const MAX_CONCURRENT_UPLOADS = 3;
const MAX_UPLOAD_SIZE = 50 * 1024 * 1024; // keep in sync with the API's MAX_SIZE

interface UseUploadsOptions {
  projectId: string;
  currentFolderId: string | null;
  onDocCreated: (doc: DocItem) => void;
  // Called on success while the user is still viewing the target folder.
  appendDoc: (doc: DocItem) => void;
  appendFile: (file: FileItem) => void;
}

export function useUploads({ projectId, currentFolderId, onDocCreated, appendDoc, appendFile }: UseUploadsOptions) {
  const [uploads, setUploads] = useState<UploadEntry[]>([]);
  const uploadIdRef = useRef(0);
  const activeRef = useRef(0);
  const queueRef = useRef<{ entryId: number; file: File; folderId: string | null }[]>([]);

  // Read the current folder through a ref so queued jobs compare against where
  // the user is *now*, not where they were when the job was enqueued.
  const currentFolderRef = useRef(currentFolderId);
  useEffect(() => { currentFolderRef.current = currentFolderId; }, [currentFolderId]);

  const runUpload = useCallback(async (entryId: number, file: File, folderId: string | null) => {
    setUploads(prev => prev.map(u => (u.id === entryId ? { ...u, status: "uploading" } : u)));
    let ok = false;
    let errorText: string | undefined;
    try {
      // .md / .txt files → import content as a new document. Everything else
      // (including dropped .excalidraw drawings) falls through to a file upload.
      if (isDocImportName(file.name)) {
        const content = await file.text();
        const title = stripDocImportExt(file.name) || "Untitled";
        const docResult = await apiFetchJson<DocItem & { id: string }>("/api/docs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title, content, projectId, folderId }),
        });
        if (docResult.ok && docResult.data) {
          onDocCreated(docResult.data);
          if (currentFolderRef.current === folderId) appendDoc(docResult.data);
          ok = true;
        } else {
          errorText = docResult.error;
        }
      } else {
        // Everything else → upload as a native file entry. Imported/dropped
        // .excalidraw files arrive with an empty or application/json MIME, so
        // re-type them to the vendor MIME - otherwise the API wouldn't treat them
        // as mutable drawings and saving edits would 400 (isMutableFile).
        const upload = file.name.toLowerCase().endsWith(EXCALIDRAW_EXT)
          ? new File([file], file.name, { type: EXCALIDRAW_MIME })
          : file;
        const form = new FormData();
        form.append("file", upload);
        form.append("projectId", projectId);
        if (folderId) form.append("folderId", folderId);
        const uploadResult = await apiFetchJson<FileItem>("/api/files", { method: "POST", body: form });
        if (uploadResult.ok && uploadResult.data) {
          if (currentFolderRef.current === folderId) appendFile(uploadResult.data);
          ok = true;
        } else {
          errorText = uploadResult.error;
        }
      }
    } catch (e) {
      // Network-level failure (offline, aborted) - surface what we have so the
      // card isn't just a bare "Upload failed".
      errorText = e instanceof Error ? e.message : undefined;
    } finally {
      // On success drop the card; on failure flip it to "error" so it lingers
      // (with a dismiss action and the server's reason) instead of vanishing.
      setUploads(prev =>
        ok
          ? prev.filter(u => u.id !== entryId)
          : prev.map(u => (u.id === entryId ? { ...u, status: "error", error: errorText } : u)),
      );
    }
  }, [projectId, onDocCreated, appendDoc, appendFile]);

  const pump = useCallback(() => {
    while (activeRef.current < MAX_CONCURRENT_UPLOADS && queueRef.current.length > 0) {
      const job = queueRef.current.shift()!;
      activeRef.current++;
      runUpload(job.entryId, job.file, job.folderId).finally(() => {
        activeRef.current--;
        pump();
      });
    }
  }, [runUpload]);

  // Enqueue a batch of files targeting the folder that is current *now* (the
  // drop-time folder, even if the user navigates away before the POST runs).
  const enqueueFiles = useCallback((files: File[]) => {
    const folderId = currentFolderRef.current;
    // Build all entries first and apply one state update - N per-file updater
    // passes would copy the growing array O(N²) times on a large drop.
    const entries: UploadEntry[] = [];
    for (const file of files) {
      const id = ++uploadIdRef.current;
      if (file.size > MAX_UPLOAD_SIZE) {
        entries.push({ id, name: file.name, size: file.size, mime: file.type, status: "error", error: "File too large. Maximum size is 50MB." });
        continue;
      }
      entries.push({ id, name: file.name, size: file.size, mime: file.type, status: "queued" });
      queueRef.current.push({ entryId: id, file, folderId });
    }
    if (entries.length > 0) setUploads(prev => [...prev, ...entries]);
    pump();
  }, [pump]);

  const dismissUpload = useCallback((id: number) => {
    setUploads(prev => prev.filter(u => u.id !== id));
  }, []);

  return { uploads, enqueueFiles, dismissUpload };
}
