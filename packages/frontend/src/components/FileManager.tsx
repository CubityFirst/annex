import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useNavigate, useOutletContext } from "react-router-dom";
import type { DocsLayoutContext } from "@/layouts/DocsLayout";
import { Folder, FileText, House, Plus, FolderPlus, Search, X, Download, Upload, Trash2, Pencil, Link, Sparkles, PenTool, MoreVertical, FolderInput, Code, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { ResizableTable, ResizableTableRow } from "@/components/ui/resizable-table";
import { Badge } from "@/components/ui/badge";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import { apiFetch, apiFetchJson } from "@/lib/apiFetch";
import { sortFolders, sortDocs, sortFiles, type SortDir } from "@/lib/fileSort";
import { formatBytes, formatRelativeTime, moveDestinations, folderPathLabel, shiftSelectionRange, folderCountLabel } from "@/lib/fileManager";
import { downloadStoredFile } from "@/lib/downloadStoredFile";
import { useFolderContents, type FolderItem, type DocItem, type FileItem } from "@/hooks/useFolderContents";
import { useUploads } from "@/hooks/useUploads";
import { emptyExcalidrawScene, EXCALIDRAW_MIME, EXCALIDRAW_EXT } from "@/lib/excalidraw";
import { UserProfileCard } from "@/components/UserProfileCard";
import { UserAvatar } from "@/components/UserAvatar";
import { FileTypeIcon } from "@/components/FileTypeIcon";
import { Spinner } from "@/components/ui/spinner";
import { Attachment, AttachmentMedia, AttachmentContent, AttachmentTitle, AttachmentDescription, AttachmentActions, AttachmentAction, AttachmentGroup } from "@/components/ui/attachment";
import { fileEmbedMarkdown } from "@/lib/fileMarkdown";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";

type Role = "viewer" | "editor" | "admin" | "owner";

const ROLE_LABELS: Record<Role, string> = {
  viewer: "Viewer",
  editor: "Editor",
  admin: "Admin",
  owner: "Owner",
};

function RoleBadge({ role }: { role: Role }) {
  const variants: Record<Role, string> = {
    owner: "bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-300",
    admin: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
    editor: "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300",
    viewer: "bg-muted text-muted-foreground",
  };
  return (
    <Badge variant="outline" className={`shrink-0 text-xs font-medium ${variants[role]}`}>
      {ROLE_LABELS[role]}
    </Badge>
  );
}

// "Created by" cell - the author/uploader name plus an optional role badge,
// linking to the user's profile card when we have an id. The name truncates in
// its own span while the badge stays `shrink-0`, so a long name never pushes
// the badge out of the (overflow-hidden) cell.
function AuthorCell({ userId, name, role }: { userId?: string; name?: string; role?: Role | null }) {
  if (userId && name) {
    return (
      <UserProfileCard userId={userId} name={name}>
        <div className="flex items-center gap-2 min-w-0 text-sm text-muted-foreground cursor-pointer hover:text-foreground transition-colors">
          <UserAvatar userId={userId} name={name} className="h-5 w-5 shrink-0 text-[10px]" />
          <span className="truncate">{name}</span>
          {role && <RoleBadge role={role} />}
        </div>
      </UserProfileCard>
    );
  }
  return (
    <div className="flex items-center gap-2 min-w-0 text-sm text-muted-foreground">
      <span className="truncate">{name ?? ""}</span>
      {role && <RoleBadge role={role} />}
    </div>
  );
}

// Module-scope so the array identity is stable across renders - the table keys
// its segment memo and auto-fit effect off this reference. "Name" and
// "Created by" are constrained (minWidth/maxWidth) so they auto-fit to content;
// "Size"/"Last updated" share the remaining resizable space.
const FILE_COLUMNS = [
  { label: "Name", defaultSize: 0, minWidth: 200, maxWidth: 500, sortable: true },
  { label: "Created by", defaultSize: 0, minWidth: 150, maxWidth: 400, sortable: true },
  { label: "Size", defaultSize: 15, minSize: 8, sortable: true },
  { label: "Last updated", defaultSize: 25, minSize: 12, sortable: true },
];

// The same five actions repeat across the desktop context menu, the desktop
// kebab, and the mobile kebab - render them once from a "kit" of menu-item
// components (ContextMenuItem vs DropdownMenuItem) so the sets can't drift.
interface MenuKit {
  Item: React.ElementType;
  Separator: React.ElementType;
}

// Stable empty arrays for search mode - fresh [] literals per render would
// defeat the sorted-list/measureKey memos below.
const EMPTY_FOLDERS: FolderItem[] = [];
const EMPTY_FILES: FileItem[] = [];

interface Props {
  projectId: string;
  projectName: string;
  folderId: string | null;
  myRole?: string | null;
  aiEnabled?: boolean;
  onDocCreated: (doc: DocItem) => void;
}

export function FileManager({ projectId, projectName, folderId, myRole, aiEnabled, onDocCreated }: Props) {
  const canEdit = myRole === "editor" || myRole === "admin" || myRole === "owner";
  const navigate = useNavigate();
  const { toast } = useToast();
  const { setBreadcrumbs } = useOutletContext<DocsLayoutContext>();

  const currentFolderId = folderId;
  const {
    folders, setFolders,
    docs, setDocs,
    files, setFiles,
    folderCounts, path, loading, error: loadError, reload,
  } = useFolderContents(projectId, currentFolderId, projectName);

  const [selectedDocs, setSelectedDocs] = useState<Set<string>>(new Set());
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const lastCheckedDocIndex = useRef<number | null>(null);
  const lastCheckedFileIndex = useRef<number | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<{ type: "folder" | "doc" | "file"; id: string } | null>(null);
  const [renameName, setRenameName] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [contextDeleteTarget, setContextDeleteTarget] = useState<{ type: "folder" | "doc" | "file"; id: string; name: string } | null>(null);
  const [contextDeleting, setContextDeleting] = useState(false);

  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<DocItem[] | null>(null);
  const searchSeqRef = useRef(0);
  const inSearch = searchResults !== null;

  // Column sort for the listing - applied within each group (folders, docs,
  // files). Defaults to Name ascending; clicking the active column toggles dir.
  const [sort, setSort] = useState<{ colIdx: number; dir: SortDir }>({ colIdx: 0, dir: "asc" });
  const handleSort = useCallback((colIdx: number) => {
    // A sort change reorders the lists, so the shift-select anchors point at
    // different rows than the user last clicked - drop them.
    lastCheckedDocIndex.current = null;
    lastCheckedFileIndex.current = null;
    setSort(prev => prev.colIdx === colIdx
      ? { colIdx, dir: prev.dir === "asc" ? "desc" : "asc" }
      : { colIdx, dir: "asc" });
  }, []);

  const [showNewFolder, setShowNewFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [creatingDrawing, setCreatingDrawing] = useState(false);

  const [summaryDoc, setSummaryDoc] = useState<DocItem | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [summarizing, setSummarizing] = useState(false);
  const summarySeqRef = useRef(0);

  // "Move to folder…" picker - a single-pointer / keyboard alternative to the
  // drag-and-drop move. Opening it loads every folder in the project so the user
  // can pick any destination (drag only reaches whatever is currently on screen).
  const [moveTarget, setMoveTarget] = useState<{ type: "folder" | "doc" | "file"; id: string; name: string } | null>(null);
  const [moveFolders, setMoveFolders] = useState<FolderItem[] | null>(null);
  const [moving, setMoving] = useState(false);

  // internal drag-to-reorder state
  const draggedItem = useRef<{ type: "doc" | "folder" | "file"; id: string } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | "root" | null>(null);

  // external file drop state
  const [externalDragOver, setExternalDragOver] = useState(false);

  const { uploads, enqueueFiles, dismissUpload } = useUploads({
    projectId,
    currentFolderId,
    onDocCreated,
    appendDoc: useCallback((doc: DocItem) => setDocs(prev => [...prev, doc]), [setDocs]),
    appendFile: useCallback((file: FileItem) => setFiles(prev => [...prev, file]), [setFiles]),
  });

  // Hidden <input> backing the explicit toolbar Upload button (touch devices
  // can't drag-and-drop). Reuses the same upload pipeline.
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Selections and shift-select anchors are scoped to what's on screen: leaving
  // the folder (or project) or entering/leaving search mode invalidates both.
  // Without this, "Delete (N)" can silently include items selected in a folder
  // the user is no longer looking at, and a stale anchor can index past the end
  // of a shorter list.
  useEffect(() => {
    setSelectedDocs(new Set());
    setSelectedFiles(new Set());
    lastCheckedDocIndex.current = null;
    lastCheckedFileIndex.current = null;
  }, [projectId, currentFolderId, inSearch]);

  useEffect(() => {
    if (!searchQuery.trim()) {
      // Invalidate any in-flight search too, or its late response would
      // re-enter search mode under an empty box.
      searchSeqRef.current++;
      setSearchResults(null);
      return;
    }
    const timer = setTimeout(async () => {
      const seq = ++searchSeqRef.current;
      const folderParam = currentFolderId ? `&rootFolderId=${currentFolderId}` : "";
      const result = await apiFetchJson<DocItem[]>(`/api/docs?projectId=${projectId}&q=${encodeURIComponent(searchQuery.trim())}${folderParam}`);
      // Only the newest in-flight search may write results - a slower older
      // response must not overwrite a fresher query's rows.
      if (seq !== searchSeqRef.current) return;
      if (result.ok && result.data) setSearchResults(result.data);
      else if (!result.redirected) {
        setSearchResults([]);
        toast({ title: "Search failed.", description: result.error, variant: "destructive" });
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [searchQuery, projectId, currentFolderId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync folder path to layout breadcrumbs
  useEffect(() => {
    setBreadcrumbs(path.map((crumb, i) => {
      const crumbKey = crumb.id ?? "root";
      const isLast = i === path.length - 1;
      return {
        id: crumb.id,
        name: crumb.name,
        onClick: isLast ? undefined : () => navigateToCrumb(i),
        onDragOver: (e: React.DragEvent) => onCrumbDragOver(e, crumb.id),
        onDragLeave: onCrumbDragLeave,
        onDrop: (e: React.DragEvent) => onCrumbDrop(e, crumb.id),
        isDropTarget: dropTarget === crumbKey,
      };
    }));
    return () => setBreadcrumbs([]);
  }, [path, dropTarget]); // eslint-disable-line react-hooks/exhaustive-deps

  function folderUrl(id: string | null) {
    return id ? `/projects/${projectId}/folders/${id}` : `/projects/${projectId}`;
  }

  function enterFolder(folder: FolderItem) {
    navigate(folderUrl(folder.id));
  }

  // Keyboard activation for rows rendered as `role="button"`. The
  // `e.target === e.currentTarget` guard means Enter/Space pressed while focus
  // is on a nested control (rename button, checkbox, kebab) doesn't also fire
  // the row's primary action.
  function activateOnKey(e: React.KeyboardEvent, fn: () => void) {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fn();
    }
  }

  function navigateToCrumb(index: number) {
    const target = path[index];
    navigate(folderUrl(target.id));
  }

  function openRename(type: "folder" | "doc" | "file", id: string, currentName: string) {
    setRenameTarget({ type, id });
    setRenameName(currentName);
  }

  // Doc rows can be visible in two stores at once - the folder list and the
  // search results. Route every doc mutation through this so neither goes
  // stale (deleted rows lingering / renamed rows keeping old titles in search).
  function updateDocLists(fn: (docs: DocItem[]) => DocItem[]) {
    setDocs(fn);
    setSearchResults(prev => (prev ? fn(prev) : prev));
  }

  async function handleCreateFolder(e: React.FormEvent) {
    e.preventDefault();
    if (!newFolderName.trim() || creatingFolder) return;
    setCreatingFolder(true);
    try {
      const result = await apiFetchJson<FolderItem>("/api/folders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newFolderName.trim(), projectId, parentId: currentFolderId, type: "docs" }),
      });
      if (result.ok && result.data) {
        // Display order comes from sortFolders - a plain append is enough here.
        setFolders(prev => [...prev, result.data!]);
        setNewFolderName("");
        setShowNewFolder(false);
      } else if (!result.redirected) {
        toast({ title: "Couldn't create the folder.", description: result.error, variant: "destructive" });
      }
    } finally {
      setCreatingFolder(false);
    }
  }

  function handleNewDoc() {
    // Nothing is created server-side yet - DocPage's new-document mode POSTs
    // the doc on first save, so cancelling out leaves no orphan behind.
    navigate(`/projects/${projectId}/docs/new`, { state: { folderId: currentFolderId, folderPath: path } });
  }

  async function handleNewDrawing() {
    if (creatingDrawing) return;
    setCreatingDrawing(true);
    try {
      // A drawing is just a file: POST an empty .excalidraw scene through the
      // normal upload path (same access check + folder validation), then open it.
      const blob = new Blob([emptyExcalidrawScene()], { type: EXCALIDRAW_MIME });
      const file = new File([blob], `Untitled${EXCALIDRAW_EXT}`, { type: EXCALIDRAW_MIME });
      const form = new FormData();
      form.append("file", file);
      form.append("projectId", projectId);
      if (currentFolderId) form.append("folderId", currentFolderId);
      const result = await apiFetchJson<FileItem>("/api/files", { method: "POST", body: form });
      if (result.ok && result.data) {
        navigate(`/projects/${projectId}/files/${result.data.id}`, { state: { isNew: true, folderPath: path } });
      } else if (!result.redirected) {
        toast({ title: "Couldn't create the drawing.", description: result.error, variant: "destructive" });
      }
    } finally {
      setCreatingDrawing(false);
    }
  }

  async function moveDoc(docId: string, targetFolderId: string | null) {
    if (targetFolderId === currentFolderId && !inSearch) return;
    updateDocLists(prev => prev.filter(d => d.id !== docId));
    setSelectedDocs(prev => { if (!prev.has(docId)) return prev; const next = new Set(prev); next.delete(docId); return next; });
    const result = await apiFetchJson(`/api/docs/${docId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folderId: targetFolderId }),
    });
    if (!result.ok && !result.redirected) {
      toast({ title: "Failed to move document.", description: result.error, variant: "destructive" });
      await reload();
    }
  }

  async function moveFolder(movedFolderId: string, targetParentId: string | null) {
    if (targetParentId === currentFolderId) return;
    setFolders(prev => prev.filter(f => f.id !== movedFolderId));
    const result = await apiFetchJson(`/api/folders/${movedFolderId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parentId: targetParentId }),
    });
    if (!result.ok && !result.redirected) {
      toast({ title: "Failed to move folder.", description: result.error, variant: "destructive" });
      await reload();
    }
  }

  async function downloadDoc(doc: DocItem) {
    const result = await apiFetchJson<{ content: string; title: string }>(`/api/docs/${doc.id}`);
    if (!result.ok || !result.data) {
      if (!result.redirected) toast({ title: "Download failed.", description: result.error, variant: "destructive" });
      return;
    }
    const content = result.data.content ?? "";
    const title = result.data.title || "Untitled";
    const filename = `${title.replace(/[<>:"/\\|?*]/g, "_")}.md`;
    const blob = new Blob([content], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleDownloadDoc(e: React.MouseEvent, doc: DocItem) {
    e.stopPropagation();
    await downloadDoc(doc);
  }

  async function handleSummarize(e: React.MouseEvent, doc: DocItem) {
    e.stopPropagation();
    // Sequence guard: opening a second summary while the first is in flight
    // must not let the slower response land under the newer doc's title.
    const seq = ++summarySeqRef.current;
    setSummaryDoc(doc);
    setSummary(null);
    setSummarizing(true);
    try {
      const result = await apiFetchJson<{ summary: string }>("/api/ai/summarize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ docId: doc.id }),
      });
      if (seq !== summarySeqRef.current) return;
      if (result.ok && result.data) setSummary(result.data.summary);
      else setSummary("Failed to generate summary.");
    } catch {
      if (seq === summarySeqRef.current) setSummary("Failed to generate summary.");
    } finally {
      if (seq === summarySeqRef.current) setSummarizing(false);
    }
  }

  function openFile(file: FileItem) {
    navigate(`/projects/${projectId}/files/${file.id}`, { state: { folderPath: path } });
  }

  async function downloadFile(file: FileItem) {
    if (!(await downloadStoredFile(file.id, file.name))) {
      toast({ title: "Download failed.", variant: "destructive" });
    }
  }

  async function moveFile(fileId: string, targetFolderId: string | null) {
    if (targetFolderId === currentFolderId) return;
    setFiles(prev => prev.filter(f => f.id !== fileId));
    setSelectedFiles(prev => { if (!prev.has(fileId)) return prev; const next = new Set(prev); next.delete(fileId); return next; });
    const result = await apiFetchJson(`/api/files/${fileId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folderId: targetFolderId }),
    });
    if (!result.ok && !result.redirected) {
      toast({ title: "Failed to move file.", description: result.error, variant: "destructive" });
      await reload();
    }
  }

  async function openMoveDialog(target: { type: "folder" | "doc" | "file"; id: string; name: string }) {
    setMoveTarget(target);
    setMoveFolders(null);
    const result = await apiFetchJson<FolderItem[]>(`/api/folders?projectId=${projectId}&all=1`);
    if (result.ok && result.data) setMoveFolders(result.data);
    else {
      setMoveFolders([]);
      if (!result.redirected) toast({ title: "Couldn't load folders.", description: result.error, variant: "destructive" });
    }
  }

  // Destinations with their full ancestry label, sorted by path so siblings
  // group together and duplicate names in different branches stay tellable
  // apart. Memoized - the O(n²) descendant exclusion used to run twice per
  // dialog render.
  const destinations = useMemo(() => {
    const all = moveFolders ?? [];
    const byId = new Map(all.map(f => [f.id, f]));
    return moveDestinations(all, moveTarget)
      .map(f => ({ folder: f, label: folderPathLabel(all, f, byId) }))
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: "base" }));
  }, [moveFolders, moveTarget]);

  async function handleMoveTo(targetFolderId: string | null) {
    if (!moveTarget || moving) return;
    setMoving(true);
    try {
      const { type, id } = moveTarget;
      if (type === "doc") await moveDoc(id, targetFolderId);
      else if (type === "file") await moveFile(id, targetFolderId);
      else await moveFolder(id, targetFolderId);
      setMoveTarget(null);
    } finally {
      setMoving(false);
    }
  }

  async function handleDeleteConfirmed() {
    if (deleting) return;
    setDeleting(true);
    setDeleteConfirmOpen(false);
    try {
      const docIds = [...selectedDocs];
      const fileIds = [...selectedFiles];
      const results = await Promise.all([
        ...docIds.map(async id => ({ kind: "doc" as const, id, ok: (await apiFetch(`/api/docs/${id}`, { method: "DELETE" })).ok })),
        ...fileIds.map(async id => ({ kind: "file" as const, id, ok: (await apiFetch(`/api/files/${id}`, { method: "DELETE" })).ok })),
      ]);
      const deletedDocs = new Set(results.filter(r => r.kind === "doc" && r.ok).map(r => r.id));
      const deletedFiles = new Set(results.filter(r => r.kind === "file" && r.ok).map(r => r.id));
      const failed = results.filter(r => !r.ok).length;
      updateDocLists(prev => prev.filter(d => !deletedDocs.has(d.id)));
      setFiles(prev => prev.filter(f => !deletedFiles.has(f.id)));
      setSelectedDocs(prev => { const next = new Set(prev); for (const id of deletedDocs) next.delete(id); return next; });
      setSelectedFiles(prev => { const next = new Set(prev); for (const id of deletedFiles) next.delete(id); return next; });
      if (failed > 0) {
        toast({ title: `${failed} item${failed === 1 ? "" : "s"} couldn't be deleted.`, variant: "destructive" });
      }
    } finally {
      setDeleting(false);
    }
  }

  async function handleRename(e: React.FormEvent) {
    e.preventDefault();
    if (!renameTarget || !renameName.trim() || renaming) return;
    setRenaming(true);
    try {
      const trimmed = renameName.trim();
      // Apply locally only after the server accepted the rename - a 403 or
      // validation failure keeps the dialog open with the error instead of
      // showing a name that silently reverts on the next load.
      let result;
      if (renameTarget.type === "folder") {
        result = await apiFetchJson(`/api/folders/${renameTarget.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: trimmed }),
        });
        if (result.ok) setFolders(prev => prev.map(f => f.id === renameTarget.id ? { ...f, name: trimmed } : f));
      } else if (renameTarget.type === "doc") {
        result = await apiFetchJson(`/api/docs/${renameTarget.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: trimmed }),
        });
        if (result.ok) {
          updateDocLists(prev => prev.map(d => d.id === renameTarget.id ? { ...d, title: trimmed } : d));
        }
      } else {
        result = await apiFetchJson(`/api/files/${renameTarget.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: trimmed }),
        });
        if (result.ok) setFiles(prev => prev.map(f => f.id === renameTarget.id ? { ...f, name: trimmed } : f));
      }
      if (result.ok) setRenameTarget(null);
      else if (!result.redirected) {
        toast({ title: "Rename failed.", description: result.error, variant: "destructive" });
      }
    } finally {
      setRenaming(false);
    }
  }

  async function handleContextDelete() {
    if (!contextDeleteTarget || contextDeleting) return;
    setContextDeleting(true);
    const { type, id } = contextDeleteTarget;
    try {
      const endpoint = type === "folder" ? `/api/folders/${id}` : type === "doc" ? `/api/docs/${id}` : `/api/files/${id}`;
      const result = await apiFetchJson(endpoint, { method: "DELETE" });
      if (result.ok) {
        if (type === "folder") setFolders(prev => prev.filter(f => f.id !== id));
        else if (type === "doc") updateDocLists(prev => prev.filter(d => d.id !== id));
        else setFiles(prev => prev.filter(f => f.id !== id));
        setContextDeleteTarget(null);
      } else if (!result.redirected) {
        toast({ title: "Delete failed.", description: result.error, variant: "destructive" });
        setContextDeleteTarget(null);
      }
    } finally {
      setContextDeleting(false);
    }
  }

  const handleExternalDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setExternalDragOver(false);
    if (draggedItem.current) return; // internal drag, not our concern
    enqueueFiles(Array.from(e.dataTransfer.files));
  }, [enqueueFiles]);

  function onDragStart(e: React.DragEvent, type: "doc" | "folder" | "file", id: string) {
    draggedItem.current = { type, id };
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", id);
  }

  function onDragEnd() {
    draggedItem.current = null;
    setDropTarget(null);
  }

  // Folder rows / crumbs are drop targets for *internal* drags only. An OS file
  // drag must not highlight them - dropped files always upload to the folder
  // being viewed (the full-page overlay is the affordance for that), so ringing
  // a row would promise a per-folder upload that doesn't happen.
  function onCrumbDragOver(e: React.DragEvent, crumbId: string | null) {
    if (!draggedItem.current) return;
    e.preventDefault();
    setDropTarget(crumbId ?? "root");
  }

  function onCrumbDragLeave() {
    setDropTarget(null);
  }

  async function onCrumbDrop(e: React.DragEvent, targetFolderId: string | null) {
    e.preventDefault();
    setDropTarget(null);
    const item = draggedItem.current;
    if (!item) return;
    if (item.type === "doc") await moveDoc(item.id, targetFolderId);
    else if (item.type === "file") await moveFile(item.id, targetFolderId);
    else {
      if (item.id === targetFolderId) return;
      await moveFolder(item.id, targetFolderId);
    }
  }

  // --- shared per-item action menus (context menu + desktop/mobile kebabs) ---

  const folderActionItems = (M: MenuKit, folder: FolderItem) => (
    <>
      <M.Item onClick={() => openRename("folder", folder.id, folder.name)}>
        <Pencil />
        Rename
      </M.Item>
      <M.Item onClick={() => openMoveDialog({ type: "folder", id: folder.id, name: folder.name })}>
        <FolderInput />
        Move to folder…
      </M.Item>
      <M.Separator />
      <M.Item variant="destructive" onClick={() => setContextDeleteTarget({ type: "folder", id: folder.id, name: folder.name })}>
        <Trash2 />
        Delete
      </M.Item>
    </>
  );

  const docActionItems = (M: MenuKit, doc: DocItem) => {
    const isHome = doc.is_home === 1;
    const title = doc.title || "Untitled";
    return (
      <>
        <M.Item onClick={() => { navigator.clipboard.writeText(`${window.location.origin}/projects/${projectId}/docs/${doc.id}`); toast({ title: "Link copied" }); }}>
          <Link />
          Copy link
        </M.Item>
        <M.Item onClick={() => downloadDoc(doc)}>
          <Download />
          Download
        </M.Item>
        {canEdit && <M.Separator />}
        {canEdit && (
          <M.Item onClick={() => openRename("doc", doc.id, title)}>
            <Pencil />
            Rename
          </M.Item>
        )}
        {canEdit && !isHome && (
          <M.Item onClick={() => openMoveDialog({ type: "doc", id: doc.id, name: title })}>
            <FolderInput />
            Move to folder…
          </M.Item>
        )}
        {canEdit && !isHome && (
          <M.Item variant="destructive" onClick={() => setContextDeleteTarget({ type: "doc", id: doc.id, name: title })}>
            <Trash2 />
            Delete
          </M.Item>
        )}
      </>
    );
  };

  const fileActionItems = (M: MenuKit, file: FileItem) => (
    <>
      <M.Item onClick={() => { navigator.clipboard.writeText(`${window.location.origin}/projects/${projectId}/files/${file.id}`); toast({ title: "Link copied" }); }}>
        <Link />
        Copy link
      </M.Item>
      <M.Item onClick={() => { navigator.clipboard.writeText(fileEmbedMarkdown(file)); toast({ title: "Markdown copied" }); }}>
        <Code />
        Copy markdown
      </M.Item>
      <M.Item onClick={() => downloadFile(file)}>
        <Download />
        Download
      </M.Item>
      {canEdit && <M.Separator />}
      {canEdit && (
        <M.Item onClick={() => openRename("file", file.id, file.name)}>
          <Pencil />
          Rename
        </M.Item>
      )}
      {canEdit && (
        <M.Item onClick={() => openMoveDialog({ type: "file", id: file.id, name: file.name })}>
          <FolderInput />
          Move to folder…
        </M.Item>
      )}
      {canEdit && (
        <M.Item variant="destructive" onClick={() => setContextDeleteTarget({ type: "file", id: file.id, name: file.name })}>
          <Trash2 />
          Delete
        </M.Item>
      )}
    </>
  );

  const contextKit: MenuKit = { Item: ContextMenuItem, Separator: ContextMenuSeparator };
  const dropdownKit: MenuKit = { Item: DropdownMenuItem, Separator: DropdownMenuSeparator };

  // Sort within each group; folders stay pinned above docs above files. In
  // search mode the doc results replace the folder view's lists. Memoized so a
  // checkbox toggle doesn't re-sort all three arrays.
  const displayFolders = inSearch ? EMPTY_FOLDERS : folders;
  const displayDocs = searchResults ?? docs;
  const displayFiles = inSearch ? EMPTY_FILES : files;
  const sortedFolders = useMemo(() => sortFolders(displayFolders, sort), [displayFolders, sort]);
  const sortedDocs = useMemo(() => sortDocs(displayDocs, sort), [displayDocs, sort]);
  const sortedFiles = useMemo(() => sortFiles(displayFiles, sort), [displayFiles, sort]);

  // Re-fit the auto-sizing columns ("Name", "Created by") whenever the text
  // shown in them changes - folder/doc/file names plus author/uploader names.
  // Deliberately excludes selection state, so checkbox toggles don't re-measure.
  const measureKey = useMemo(() => [
    ...sortedFolders.map(f => f.name),
    ...sortedDocs.map(d => `${d.title} ${d.author_name ?? ""}`),
    ...sortedFiles.map(f => `${f.name} ${f.uploader_name ?? ""}`),
  ].join("|"), [sortedFolders, sortedDocs, sortedFiles]);

  function renderTable() {
    // Mobile card helpers. The kebab mirrors the desktop ContextMenu exactly;
    // on desktop the same kebab renders in the row's last cell so keyboard
    // users can reach Move/Delete/Copy without a right-click.
    const toggleDocSel = (id: string) =>
      setSelectedDocs(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
    const toggleFileSel = (id: string) =>
      setSelectedFiles(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
    const renderKebab = (label: string, items: React.ReactNode, compact = false) => (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={label}
            title={label}
            onClick={e => e.stopPropagation()}
            className={compact
              ? "inline-flex items-center justify-center h-9 w-9 sm:h-auto sm:w-auto sm:p-1 sm:min-h-6 sm:min-w-6 -m-1.5 shrink-0 rounded text-muted-foreground hover:text-foreground hover:bg-muted"
              : "inline-flex items-center justify-center h-9 w-9 shrink-0 rounded text-muted-foreground hover:text-foreground hover:bg-muted"}
          >
            <MoreVertical className={compact ? "h-3.5 w-3.5" : "h-4 w-4"} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">{items}</DropdownMenuContent>
      </DropdownMenu>
    );

    return (
      <>
      {/* Desktop: resizable table (md+) */}
      <div className="hidden md:block">
      <ResizableTable columns={FILE_COLUMNS} checkboxColumn={canEdit} storageKey="file-columns" sort={sort} onSort={handleSort} measureKey={measureKey}>
        <>
          {sortedFolders.map(folder => {
            const isDropTarget = dropTarget === folder.id;
            const countLabel = folderCountLabel(folderCounts.get(folder.id));
            const folderRow = (
              <ResizableTableRow
                columns={FILE_COLUMNS}
                draggable
                  onDragStart={e => onDragStart(e, "folder", folder.id)}
                  onDragEnd={onDragEnd}
                  onDragOver={e => {
                    // Internal drags only - see onCrumbDragOver.
                    if (!draggedItem.current || draggedItem.current.id === folder.id) return;
                    e.preventDefault();
                    setDropTarget(folder.id);
                  }}
                  onDragLeave={() => setDropTarget(null)}
                  onDrop={async e => {
                    e.preventDefault();
                    setDropTarget(null);
                    const item = draggedItem.current;
                    if (!item || item.id === folder.id) return;
                    if (item.type === "doc") await moveDoc(item.id, folder.id);
                    else if (item.type === "file") await moveFile(item.id, folder.id);
                    else await moveFolder(item.id, folder.id);
                  }}
                  className={`cursor-pointer ${isDropTarget ? "bg-primary/10 ring-1 ring-inset ring-primary/40" : ""}`}
                  cells={[
                    {
                      content: (
                        <div
                          role="button"
                          tabIndex={0}
                          aria-label={`Open folder ${folder.name}`}
                          onKeyDown={e => activateOnKey(e, () => enterFolder(folder))}
                          className="group flex items-center w-full min-w-0 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                        >
                          <Folder className={`h-4 w-4 shrink-0 mr-2 ${isDropTarget ? "text-primary" : "text-primary/70"}`} aria-hidden="true" />
                          <span className="text-sm font-medium truncate">{folder.name}</span>
                          {countLabel && (
                            <Badge variant="outline" className="ml-2 shrink-0 text-xs text-muted-foreground">
                              {countLabel}
                            </Badge>
                          )}
                          {canEdit && (
                            <button
                              type="button"
                              aria-label={`Rename folder ${folder.name}`}
                              onClick={e => { e.stopPropagation(); openRename("folder", folder.id, folder.name); }}
                              className="ml-1.5 shrink-0 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 sm:focus-visible:opacity-100 inline-flex items-center justify-center h-9 w-9 sm:h-auto sm:w-auto sm:p-1 sm:min-h-6 sm:min-w-6 -m-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-opacity"
                              title="Rename"
                            >
                              <Pencil className="h-3 w-3" aria-hidden="true" />
                            </button>
                          )}
                        </div>
                      ),
                      onClick: () => enterFolder(folder),
                    },
                    { content: null },
                    { content: null },
                    {
                      content: canEdit ? (
                        <div className="flex items-center justify-end w-full">
                          {renderKebab(`Actions for folder ${folder.name}`, folderActionItems(dropdownKit, folder), true)}
                        </div>
                      ) : null,
                    },
                  ]}
                />
            );
            if (!canEdit) return <div key={folder.id}>{folderRow}</div>;
            return (
              <ContextMenu key={folder.id}>
                <ContextMenuTrigger asChild><div>{folderRow}</div></ContextMenuTrigger>
                <ContextMenuContent>{folderActionItems(contextKit, folder)}</ContextMenuContent>
              </ContextMenu>
            );
            })}
          {sortedDocs.map((doc, docIdx) => {
            const isHome = doc.is_home === 1;
            const navToDoc = () => navigate(`/projects/${projectId}/docs/${doc.id}`, { state: { folderPath: path } });
            const docRow = (
              <ResizableTableRow
                columns={FILE_COLUMNS}
                draggable
                  onDragStart={e => onDragStart(e, "doc", doc.id)}
                  onDragEnd={onDragEnd}
                  checkboxCell={!canEdit ? undefined : isHome ? null : (
                    <Checkbox
                      aria-label={`Select ${doc.title || "Untitled"}`}
                      checked={selectedDocs.has(doc.id)}
                      onClick={(e) => {
                        const willBeChecked = !selectedDocs.has(doc.id);
                        const range = e.shiftKey
                          ? shiftSelectionRange(lastCheckedDocIndex.current, docIdx, sortedDocs.length)
                          : null;
                        if (range) {
                          setSelectedDocs(prev => {
                            const next = new Set(prev);
                            for (let i = range.from; i <= range.to; i++) {
                              if (sortedDocs[i].is_home === 1) continue;
                              if (willBeChecked) next.add(sortedDocs[i].id);
                              else next.delete(sortedDocs[i].id);
                            }
                            return next;
                          });
                        } else {
                          setSelectedDocs(prev => {
                            const next = new Set(prev);
                            if (willBeChecked) next.add(doc.id);
                            else next.delete(doc.id);
                            return next;
                          });
                        }
                        lastCheckedDocIndex.current = docIdx;
                      }}
                    />
                  )}
                  cells={[
                    {
                      content: (
                        <div
                          role="button"
                          tabIndex={0}
                          aria-label={`Open ${doc.title || "Untitled"}`}
                          onKeyDown={e => activateOnKey(e, navToDoc)}
                          className="group flex items-center w-full min-w-0 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                        >
                          {isHome
                            ? <House className="h-4 w-4 shrink-0 mr-2 text-primary/70" aria-hidden="true" />
                            : <FileText className="h-4 w-4 shrink-0 mr-2 text-muted-foreground/60" aria-hidden="true" />
                          }
                          <span className="text-sm truncate">{doc.title || "Untitled"}</span>
                          {canEdit && (
                            <button
                              type="button"
                              aria-label={`Rename ${doc.title || "Untitled"}`}
                              onClick={e => { e.stopPropagation(); openRename("doc", doc.id, doc.title || "Untitled"); }}
                              className="ml-1.5 shrink-0 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 sm:focus-visible:opacity-100 inline-flex items-center justify-center h-9 w-9 sm:h-auto sm:w-auto sm:p-1 sm:min-h-6 sm:min-w-6 -m-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-opacity"
                              title="Rename"
                            >
                              <Pencil className="h-3 w-3" aria-hidden="true" />
                            </button>
                          )}
                        </div>
                      ),
                      className: "px-3 cursor-pointer",
                      onClick: navToDoc,
                    },
                    {
                      content: <AuthorCell userId={doc.author_id} name={doc.author_name} role={doc.author_role} />,
                    },
                    { content: null },
                    {
                      content: (
                        <div className="flex items-center justify-between gap-2 w-full">
                          <span className="text-sm text-muted-foreground truncate">{formatRelativeTime(doc.updated_at)}</span>
                          <div className="flex items-center gap-3.5">
                            {aiEnabled && (
                              <button
                                type="button"
                                aria-label={`Summarise ${doc.title || "Untitled"} with AI`}
                                onClick={e => handleSummarize(e, doc)}
                                className="shrink-0 inline-flex items-center justify-center h-9 w-9 sm:h-auto sm:w-auto sm:p-1 sm:min-h-6 sm:min-w-6 -m-1.5 rounded text-violet-400 hover:text-violet-300 hover:bg-muted"
                                title="Summarise with AI"
                              >
                                <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                              </button>
                            )}
                            <button
                              type="button"
                              aria-label={`Download ${doc.title || "Untitled"} as markdown`}
                              onClick={e => handleDownloadDoc(e, doc)}
                              className="shrink-0 inline-flex items-center justify-center h-9 w-9 sm:h-auto sm:w-auto sm:p-1 sm:min-h-6 sm:min-w-6 -m-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted"
                              title="Download as markdown"
                            >
                              <Download className="h-3.5 w-3.5" aria-hidden="true" />
                            </button>
                            {renderKebab(`Actions for ${doc.title || "Untitled"}`, docActionItems(dropdownKit, doc), true)}
                          </div>
                        </div>
                      ),
                    },
                  ]}
                />
            );
            return (
              <ContextMenu key={doc.id}>
                <ContextMenuTrigger asChild><div>{docRow}</div></ContextMenuTrigger>
                <ContextMenuContent>{docActionItems(contextKit, doc)}</ContextMenuContent>
              </ContextMenu>
            );
          })}
          {sortedFiles.map((file, fileIdx) => {
            const fileRow = (
              <ResizableTableRow
                columns={FILE_COLUMNS}
                draggable
                onDragStart={e => onDragStart(e, "file", file.id)}
                onDragEnd={onDragEnd}
                checkboxCell={canEdit ? (
                  <Checkbox
                    aria-label={`Select ${file.name}`}
                    checked={selectedFiles.has(file.id)}
                    onClick={(e) => {
                      const willBeChecked = !selectedFiles.has(file.id);
                      const range = e.shiftKey
                        ? shiftSelectionRange(lastCheckedFileIndex.current, fileIdx, sortedFiles.length)
                        : null;
                      if (range) {
                        setSelectedFiles(prev => {
                          const next = new Set(prev);
                          for (let i = range.from; i <= range.to; i++) {
                            if (willBeChecked) next.add(sortedFiles[i].id);
                            else next.delete(sortedFiles[i].id);
                          }
                          return next;
                        });
                      } else {
                        setSelectedFiles(prev => {
                          const next = new Set(prev);
                          if (willBeChecked) next.add(file.id);
                          else next.delete(file.id);
                          return next;
                        });
                      }
                      lastCheckedFileIndex.current = fileIdx;
                    }}
                  />
                ) : undefined}
                cells={[
                  {
                    content: (
                      <div
                        role="button"
                        tabIndex={0}
                        aria-label={`Open ${file.name}`}
                        onKeyDown={e => activateOnKey(e, () => openFile(file))}
                        className="group flex items-center w-full min-w-0 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                      >
                        <FileTypeIcon mimeType={file.mime_type} name={file.name} className="h-4 w-4 shrink-0 mr-2 text-muted-foreground/60" />
                        <span className="text-sm truncate">{file.name}</span>
                        {canEdit && (
                          <button
                            type="button"
                            aria-label={`Rename ${file.name}`}
                            onClick={e => { e.stopPropagation(); openRename("file", file.id, file.name); }}
                            className="ml-1.5 shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 inline-flex items-center justify-center min-h-6 min-w-6 p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-opacity"
                            title="Rename"
                          >
                            <Pencil className="h-3 w-3" aria-hidden="true" />
                          </button>
                        )}
                      </div>
                    ),
                    className: "px-3 cursor-pointer",
                    onClick: () => openFile(file),
                  },
                  {
                    content: <AuthorCell userId={file.uploaded_by} name={file.uploader_name} role={file.uploader_role} />,
                  },
                  {
                    content: <span className="text-sm text-muted-foreground">{formatBytes(file.size)}</span>,
                  },
                  {
                    content: (
                      <div className="flex items-center justify-between gap-2 w-full">
                        <span className="text-sm text-muted-foreground truncate">{formatRelativeTime(file.updated_at ?? file.created_at)}</span>
                        <div className="flex items-center gap-3.5">
                          <button
                            type="button"
                            aria-label={`Download ${file.name}`}
                            onClick={e => { e.stopPropagation(); downloadFile(file); }}
                            className="shrink-0 inline-flex items-center justify-center h-9 w-9 sm:h-auto sm:w-auto sm:p-1 sm:min-h-6 sm:min-w-6 -m-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted"
                            title="Download"
                          >
                            <Download className="h-3.5 w-3.5" aria-hidden="true" />
                          </button>
                          {renderKebab(`Actions for ${file.name}`, fileActionItems(dropdownKit, file), true)}
                        </div>
                      </div>
                    ),
                  },
                ]}
              />
            );
            return (
              <ContextMenu key={file.id}>
                <ContextMenuTrigger asChild><div>{fileRow}</div></ContextMenuTrigger>
                <ContextMenuContent>{fileActionItems(contextKit, file)}</ContextMenuContent>
              </ContextMenu>
            );
          })}
        </>
      </ResizableTable>
      </div>

      {/* Mobile: card list (below md) - same data, tappable rows + kebab actions */}
      <div className="md:hidden rounded-md border bg-background overflow-hidden">
        {sortedFolders.map(folder => {
          const countLabel = folderCountLabel(folderCounts.get(folder.id));
          return (
            <div
              key={folder.id}
              role="button"
              tabIndex={0}
              aria-label={`Open folder ${folder.name}`}
              onKeyDown={e => activateOnKey(e, () => enterFolder(folder))}
              className="flex items-center gap-3 min-h-12 px-3 py-2.5 border-b last:border-b-0 cursor-pointer active:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              onClick={() => enterFolder(folder)}
            >
              <Folder className="h-5 w-5 shrink-0 text-primary/70" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{folder.name}</div>
                {countLabel && (
                  <div className="truncate text-xs text-muted-foreground">{countLabel}</div>
                )}
              </div>
              {canEdit && renderKebab("Folder actions", folderActionItems(dropdownKit, folder))}
            </div>
          );
        })}
        {sortedDocs.map(doc => {
          const isHome = doc.is_home === 1;
          const navToDoc = () => navigate(`/projects/${projectId}/docs/${doc.id}`, { state: { folderPath: path } });
          return (
            <div
              key={doc.id}
              role="button"
              tabIndex={0}
              aria-label={`Open ${doc.title || "Untitled"}`}
              onKeyDown={e => activateOnKey(e, navToDoc)}
              className="flex items-center gap-3 min-h-12 px-3 py-2.5 border-b last:border-b-0 cursor-pointer active:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              onClick={navToDoc}
            >
              {canEdit && !isHome && (
                <div className="flex items-center justify-center min-w-10 min-h-10 -ml-1 shrink-0" onClick={e => e.stopPropagation()}>
                  <Checkbox aria-label={`Select ${doc.title || "Untitled"}`} checked={selectedDocs.has(doc.id)} onClick={() => toggleDocSel(doc.id)} />
                </div>
              )}
              {isHome
                ? <House className="h-5 w-5 shrink-0 text-primary/70" aria-hidden="true" />
                : <FileText className="h-5 w-5 shrink-0 text-muted-foreground/60" aria-hidden="true" />
              }
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm">{doc.title || "Untitled"}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {formatRelativeTime(doc.updated_at)}{doc.author_name ? ` · ${doc.author_name}` : ""}
                </div>
              </div>
              {renderKebab("Document actions", docActionItems(dropdownKit, doc))}
            </div>
          );
        })}
        {sortedFiles.map(file => (
          <div
            key={file.id}
            role="button"
            tabIndex={0}
            aria-label={`Open ${file.name}`}
            onKeyDown={e => activateOnKey(e, () => openFile(file))}
            className="flex items-center gap-3 min-h-12 px-3 py-2.5 border-b last:border-b-0 cursor-pointer active:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            onClick={() => openFile(file)}
          >
            {canEdit && (
              <div className="flex items-center justify-center min-w-10 min-h-10 -ml-1 shrink-0" onClick={e => e.stopPropagation()}>
                <Checkbox aria-label={`Select ${file.name}`} checked={selectedFiles.has(file.id)} onClick={() => toggleFileSel(file.id)} />
              </div>
            )}
            <FileTypeIcon mimeType={file.mime_type} name={file.name} className="h-5 w-5 shrink-0 text-muted-foreground/60" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm">{file.name}</div>
              <div className="truncate text-xs text-muted-foreground">
                {formatBytes(file.size)} · {formatRelativeTime(file.updated_at ?? file.created_at)}
              </div>
            </div>
            {renderKebab("File actions", fileActionItems(dropdownKit, file))}
          </div>
        ))}
      </div>
      </>
    );
  }

  return (
    <div
      className="relative flex min-h-full flex-col"
      onDragEnter={e => { if (!draggedItem.current && e.dataTransfer.types.includes("Files")) setExternalDragOver(true); }}
      onDragOver={e => { if (!draggedItem.current && e.dataTransfer.types.includes("Files")) { e.preventDefault(); setExternalDragOver(true); } }}
      onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setExternalDragOver(false); }}
      onDrop={handleExternalDrop}
    >
      {externalDragOver && (
        <div className="pointer-events-none absolute inset-3 z-20 flex flex-col items-center justify-center gap-2 rounded-lg bg-background/80 backdrop-blur-sm ring-2 ring-inset ring-primary/40">
          <Upload className="h-8 w-8 text-primary/60" aria-hidden="true" />
          <p className="text-sm font-medium text-muted-foreground">Drop to upload</p>
        </div>
      )}

      {/* In-flight / failed uploads, one Attachment card each, stacked in the
          corner so they don't block the listing behind them. */}
      {uploads.length > 0 && (
        <div
          role="status"
          aria-live="polite"
          aria-label="File uploads"
          className="pointer-events-auto absolute bottom-4 right-4 z-30 w-72 max-w-[calc(100%-2rem)]"
        >
          <AttachmentGroup className="flex-col">
            {uploads.map(u => (
              <Attachment key={u.id} size="sm" status={u.status === "queued" ? "uploading" : u.status} className="w-full bg-background shadow-md">
                <AttachmentMedia>
                  {u.status === "error"
                    ? <FileTypeIcon mimeType={u.mime} name={u.name} className="size-4" />
                    : <Spinner className="size-4" />}
                </AttachmentMedia>
                <AttachmentContent>
                  <AttachmentTitle>{u.name}</AttachmentTitle>
                  <AttachmentDescription className={u.status === "error" ? "text-destructive" : undefined}>
                    {u.status === "queued"
                      ? `Queued · ${formatBytes(u.size)}`
                      : u.status === "uploading"
                        ? `Uploading… · ${formatBytes(u.size)}`
                        : u.error ?? "Upload failed"}
                  </AttachmentDescription>
                </AttachmentContent>
                {u.status === "error" && (
                  <AttachmentActions>
                    <AttachmentAction
                      aria-label={`Dismiss ${u.name}`}
                      onClick={() => dismissUpload(u.id)}
                    >
                      <X />
                    </AttachmentAction>
                  </AttachmentActions>
                )}
              </Attachment>
            ))}
          </AttachmentGroup>
        </div>
      )}

      {/* Hidden file input backing the explicit Upload button (touch can't drag) */}
      <input
        type="file"
        multiple
        ref={fileInputRef}
        className="hidden"
        onChange={e => { enqueueFiles(Array.from(e.target.files ?? [])); e.target.value = ""; }}
      />

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 px-4 sm:px-6 py-3">
        <div className="relative w-full sm:w-auto sm:flex-1 sm:max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" aria-hidden="true" />
          <Input
            placeholder="Search documents…"
            aria-label="Search documents"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="pl-9 pr-8"
          />
          {searchQuery && (
            <button
              type="button"
              aria-label="Clear search"
              title="Clear search"
              onClick={() => setSearchQuery("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 h-8 w-8 sm:h-5 sm:w-5 flex items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {canEdit && (
            <Button size="sm" variant="outline" aria-label="New folder" title="New folder" className="gap-1.5 h-9 min-w-9 sm:w-auto" onClick={() => setShowNewFolder(true)}>
              <FolderPlus className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">New folder</span>
            </Button>
          )}
          {canEdit && (
            <Button size="sm" variant="outline" aria-label="Upload files" title="Upload files" className="gap-1.5 h-9 min-w-9 sm:w-auto" onClick={() => fileInputRef.current?.click()}>
              <Upload className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Upload</span>
            </Button>
          )}
          {canEdit && (
            <Button size="sm" variant="outline" aria-label="New drawing" title="New drawing" className="gap-1.5 h-9 min-w-9 sm:w-auto" onClick={handleNewDrawing} disabled={creatingDrawing}>
              <PenTool className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">{creatingDrawing ? "Creating…" : "New drawing"}</span>
            </Button>
          )}
          {canEdit && (
            <Button size="sm" aria-label="New document" title="New document" className="gap-1.5 h-9 min-w-9 sm:w-auto" onClick={handleNewDoc}>
              <Plus className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">New document</span>
            </Button>
          )}
          {canEdit && (selectedDocs.size > 0 || selectedFiles.size > 0) && (
            <Button size="sm" variant="destructive" aria-label={`Delete ${selectedDocs.size + selectedFiles.size} selected`} title="Delete selected" className="gap-1.5 h-9 min-w-9 sm:w-auto" onClick={() => setDeleteConfirmOpen(true)} disabled={deleting}>
              <Trash2 className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">{deleting ? "Deleting…" : `Delete (${selectedDocs.size + selectedFiles.size})`}</span>
            </Button>
          )}
        </div>
      </div>

      {/* Table */}
      <div className="px-6 pb-6">
        {loading ? (
          <div className="flex flex-col gap-1.5 pt-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : loadError && !inSearch ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <Folder className="mb-3 h-10 w-10 text-muted-foreground/30" />
            <p className="text-sm font-medium text-muted-foreground">Couldn't load this folder.</p>
            <p className="mt-1 text-xs text-muted-foreground">{loadError}</p>
            <Button size="sm" variant="outline" className="mt-4 gap-1.5" onClick={() => reload()}>
              <RefreshCw className="h-3.5 w-3.5" />
              Retry
            </Button>
          </div>
        ) : inSearch && sortedDocs.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <Search className="mb-3 h-10 w-10 text-muted-foreground/30" />
            <p className="text-sm font-medium text-muted-foreground">No documents found</p>
          </div>
        ) : !inSearch && folders.length === 0 && docs.length === 0 && files.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <Folder className="mb-3 h-10 w-10 text-muted-foreground/30" />
            <p className="text-sm font-medium text-muted-foreground">This folder is empty</p>
          </div>
        ) : renderTable()}
      </div>

      {/* New folder dialog */}
      <Dialog open={showNewFolder} onOpenChange={setShowNewFolder}>
        <DialogContent className="sm:max-w-xs">
          <DialogHeader>
            <DialogTitle>New folder</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleCreateFolder} className="flex flex-col gap-3">
            <Label htmlFor="new-folder-name" className="sr-only">Folder name</Label>
            <Input
              id="new-folder-name"
              placeholder="Folder name"
              aria-label="Folder name"
              value={newFolderName}
              onChange={e => setNewFolderName(e.target.value)}
              autoFocus
              required
            />
            <Button type="submit" disabled={creatingFolder || !newFolderName.trim()}>
              {creatingFolder ? "Creating…" : "Create"}
            </Button>
          </form>
        </DialogContent>
      </Dialog>

      {/* Rename dialog */}
      <Dialog open={!!renameTarget} onOpenChange={open => { if (!open) setRenameTarget(null); }}>
        <DialogContent className="sm:max-w-xs">
          <DialogHeader>
            <DialogTitle>Rename</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleRename} className="flex flex-col gap-3">
            <Label htmlFor="rename-name" className="sr-only">New name</Label>
            <Input
              id="rename-name"
              aria-label="New name"
              value={renameName}
              onChange={e => setRenameName(e.target.value)}
              autoFocus
              required
            />
            <Button type="submit" disabled={renaming || !renameName.trim()}>
              {renaming ? "Renaming…" : "Rename"}
            </Button>
          </form>
        </DialogContent>
      </Dialog>

      {/* Move-to-folder dialog - keyboard/single-pointer alternative to drag */}
      <Dialog open={!!moveTarget} onOpenChange={open => { if (!open) setMoveTarget(null); }}>
        <DialogContent className="sm:max-w-xs">
          <DialogHeader>
            <DialogTitle>Move "{moveTarget?.name}"</DialogTitle>
            <DialogDescription>Choose a destination folder.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1 max-h-72 overflow-y-auto">
            {moveFolders === null ? (
              <div className="flex flex-col gap-1.5 py-1">
                {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-9 w-full" />)}
              </div>
            ) : (
              <>
                <button
                  type="button"
                  disabled={moving || currentFolderId === null}
                  onClick={() => handleMoveTo(null)}
                  className="flex items-center gap-2 rounded-sm px-2 py-2 text-left text-sm hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  <House className="h-4 w-4 shrink-0 text-primary/70" aria-hidden="true" />
                  <span className="truncate">{projectName} (home)</span>
                </button>
                {destinations.map(({ folder: f, label }) => (
                  <button
                    key={f.id}
                    type="button"
                    disabled={moving || currentFolderId === f.id}
                    onClick={() => handleMoveTo(f.id)}
                    title={label}
                    className="flex items-center gap-2 rounded-sm px-2 py-2 text-left text-sm hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  >
                    <Folder className="h-4 w-4 shrink-0 text-primary/70" aria-hidden="true" />
                    <span className="truncate">{label}</span>
                  </button>
                ))}
                {destinations.length === 0 && currentFolderId !== null && (
                  <p className="px-2 py-2 text-sm text-muted-foreground">No other folders available.</p>
                )}
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation dialog */}
      <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {selectedDocs.size + selectedFiles.size} {selectedDocs.size + selectedFiles.size === 1 ? "item" : "items"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This action is irreversible and all data will be lost.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleDeleteConfirmed}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* AI summary dialog */}
      <Dialog open={!!summaryDoc} onOpenChange={open => { if (!open) { setSummaryDoc(null); setSummary(null); } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-violet-400" />
              {summaryDoc?.title || "Document"}
            </DialogTitle>
            <DialogDescription className="sr-only">AI-generated summary</DialogDescription>
          </DialogHeader>
          <div className="text-sm leading-relaxed min-h-[60px]">
            {summarizing ? (
              <div className="space-y-2 pt-3">
                <Skeleton className="h-3.5 w-full" />
                <Skeleton className="h-3.5 w-5/6" />
                <Skeleton className="h-3.5 w-4/6" />
              </div>
            ) : (
              <div className="prose prose-sm dark:prose-invert max-w-none text-muted-foreground [&_ul]:my-1 [&_li]:my-0">
                <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{summary ?? ""}</ReactMarkdown>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Context menu single-item delete confirmation */}
      <AlertDialog open={!!contextDeleteTarget} onOpenChange={open => { if (!open) setContextDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete "{contextDeleteTarget?.name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              This action is irreversible and all data will be lost.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleContextDelete}
              disabled={contextDeleting}
            >
              {contextDeleting ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

    </div>
  );
}
