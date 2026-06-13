import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate, useOutletContext } from "react-router-dom";
import type { DocsLayoutContext } from "@/layouts/DocsLayout";
import { Folder, FileText, House, Plus, FolderPlus, Search, X, Download, Upload, Image, FileCode, FileArchive, File, Music, Trash2, Pencil, Link, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { ResizableTable, ResizableTableRow } from "@/components/ui/resizable-table";
import { Badge } from "@/components/ui/badge";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { useToast } from "@/hooks/use-toast";
import { apiFetch, apiFetchJson } from "@/lib/apiFetch";
import { sortFolders, sortDocs, sortFiles, type SortDir } from "@/lib/fileSort";
import { UserProfileCard } from "@/components/UserProfileCard";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";

interface FolderItem {
  id: string;
  name: string;
  project_id: string;
  parent_id: string | null;
  created_at: string;
}

type Role = "viewer" | "editor" | "admin" | "owner";

interface DocItem {
  id: string;
  title: string;
  folder_id: string | null;
  updated_at: string;
  author_id?: string;
  author_name?: string;
  author_role?: Role | null;
  is_home?: number;
}

interface FileItem {
  id: string;
  name: string;
  mime_type: string;
  size: number;
  folder_id: string | null;
  uploaded_by: string;
  created_at: string;
  uploader_name?: string;
  uploader_role?: Role | null;
}

function FileIcon({ mimeType, className }: { mimeType: string; className?: string }) {
  if (mimeType.startsWith("image/")) return <Image className={className} />;
  if (mimeType.startsWith("audio/")) return <Music className={className} />;
  if (mimeType === "application/json" || mimeType.startsWith("text/")) return <FileCode className={className} />;
  if (mimeType.includes("zip") || mimeType.includes("tar") || mimeType.includes("gzip") || mimeType.includes("archive")) return <FileArchive className={className} />;
  return <File className={className} />;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface BreadcrumbEntry {
  id: string | null;
  name: string;
}

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

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

// "Created by" cell — the author/uploader name plus an optional role badge,
// linking to the user's profile card when we have an id. The name truncates in
// its own span while the badge stays `shrink-0`, so a long name never pushes
// the badge out of the (overflow-hidden) cell.
function AuthorCell({ userId, name, role }: { userId?: string; name?: string; role?: Role | null }) {
  if (userId && name) {
    return (
      <UserProfileCard userId={userId} name={name}>
        <div className="flex items-center gap-2 min-w-0 text-sm text-muted-foreground cursor-pointer hover:text-foreground transition-colors">
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

// Module-scope so the array identity is stable across renders — the table keys
// its segment memo and auto-fit effect off this reference. "Name" and
// "Created by" are constrained (minWidth/maxWidth) so they auto-fit to content;
// "Size"/"Last updated" share the remaining resizable space.
const FILE_COLUMNS = [
  { label: "Name", defaultSize: 0, minWidth: 200, maxWidth: 500, sortable: true },
  { label: "Created by", defaultSize: 0, minWidth: 150, maxWidth: 400, sortable: true },
  { label: "Size", defaultSize: 15, minSize: 8, sortable: true },
  { label: "Last updated", defaultSize: 25, minSize: 12, sortable: true },
];

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

  const [folders, setFolders] = useState<FolderItem[]>([]);
  const [docs, setDocs] = useState<DocItem[]>([]);
  const [files, setFiles] = useState<FileItem[]>([]);
  // Breadcrumb path is rebuilt from the API ancestors response on every load.
  // URL (folderId prop) is the source of truth for the current folder.
  const [path, setPath] = useState<BreadcrumbEntry[]>([{ id: null, name: projectName }]);
  const currentFolderId = folderId;

  const [selectedDocs, setSelectedDocs] = useState<Set<string>>(new Set());
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const lastCheckedDocIndex = useRef<number | null>(null);
  const lastCheckedFileIndex = useRef<number | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<{ type: "folder" | "doc" | "file"; id: string; currentName: string } | null>(null);
  const [renameName, setRenameName] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [contextDeleteTarget, setContextDeleteTarget] = useState<{ type: "folder" | "doc" | "file"; id: string; name: string } | null>(null);
  const [contextDeleting, setContextDeleting] = useState(false);
  const [folderCounts, setFolderCounts] = useState<Map<string, { files: number; folders: number }>>(new Map());

  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<DocItem[] | null>(null);

  // Column sort for the listing — applied within each group (folders, docs,
  // files). Defaults to Name ascending; clicking the active column toggles dir.
  const [sort, setSort] = useState<{ colIdx: number; dir: SortDir }>({ colIdx: 0, dir: "asc" });
  const handleSort = useCallback((colIdx: number) => {
    setSort(prev => prev.colIdx === colIdx
      ? { colIdx, dir: prev.dir === "asc" ? "desc" : "asc" }
      : { colIdx, dir: "asc" });
  }, []);

  const [showNewFolder, setShowNewFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [creatingDoc, setCreatingDoc] = useState(false);

  const [loading, setLoading] = useState(true);
  const loadingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [summaryDoc, setSummaryDoc] = useState<DocItem | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [summarizing, setSummarizing] = useState(false);

  // internal drag-to-reorder state
  const draggedItem = useRef<{ type: "doc" | "folder" | "file"; id: string } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | "root" | null>(null);

  // external file drop state
  const [externalDragOver, setExternalDragOver] = useState(false);
  const [uploadingCount, setUploadingCount] = useState(0);

  useEffect(() => {
    loadContents();
  }, [currentFolderId, projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!searchQuery.trim()) {
      setSearchResults(null);
      return;
    }
    const timer = setTimeout(async () => {
      const folderParam = currentFolderId ? `&rootFolderId=${currentFolderId}` : "";
      const result = await apiFetchJson<DocItem[]>(`/api/docs?projectId=${projectId}&q=${encodeURIComponent(searchQuery.trim())}${folderParam}`);
      if (result.ok && result.data) setSearchResults(result.data);
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

  async function loadContents() {
    if (loadingTimerRef.current) clearTimeout(loadingTimerRef.current);
    loadingTimerRef.current = setTimeout(() => {
      setLoading(true);
      setFolders([]);
      setDocs([]);
      setFiles([]);
    }, 150);

    const folderParam = currentFolderId ? `?folderId=${currentFolderId}` : "";
    const result = await apiFetchJson<{
      folders: FolderItem[];
      docs: DocItem[];
      files: FileItem[];
      folderCounts: Record<string, { docs: number; folders: number }>;
      ancestors: { id: string; name: string }[];
    }>(`/api/projects/${projectId}/contents${folderParam}`);

    if (loadingTimerRef.current) { clearTimeout(loadingTimerRef.current); loadingTimerRef.current = null; }
    if (result.ok && result.data) {
      setFolders(result.data.folders);
      setDocs(result.data.docs);
      setFiles(result.data.files);
      const counts = new Map<string, { files: number; folders: number }>();
      for (const [id, c] of Object.entries(result.data.folderCounts)) {
        counts.set(id, { files: c.docs, folders: c.folders });
      }
      setFolderCounts(counts);
      const ancestorCrumbs: BreadcrumbEntry[] = (result.data.ancestors ?? []).map(a => ({ id: a.id, name: a.name }));
      setPath([{ id: null, name: projectName }, ...ancestorCrumbs]);
    }
    setLoading(false);
  }

  function folderUrl(id: string | null) {
    return id ? `/projects/${projectId}/folders/${id}` : `/projects/${projectId}`;
  }

  function enterFolder(folder: FolderItem) {
    navigate(folderUrl(folder.id));
  }

  function navigateToCrumb(index: number) {
    const target = path[index];
    navigate(folderUrl(target.id));
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
        setFolders(prev => [...prev, result.data!].sort((a, b) => a.name.localeCompare(b.name)));
        setNewFolderName("");
        setShowNewFolder(false);
      }
    } finally {
      setCreatingFolder(false);
    }
  }

  async function handleNewDoc() {
    if (creatingDoc) return;
    setCreatingDoc(true);
    try {
      const result = await apiFetchJson<DocItem & { id: string }>("/api/docs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Untitled", content: "", projectId, folderId: currentFolderId }),
      });
      if (result.ok && result.data) {
        onDocCreated(result.data);
        navigate(`/projects/${projectId}/docs/${result.data.id}`, { state: { isNew: true, folderPath: path } });
      }
    } finally {
      setCreatingDoc(false);
    }
  }

  async function moveDoc(docId: string, targetFolderId: string | null) {
    if (targetFolderId === currentFolderId) return;
    setDocs(prev => prev.filter(d => d.id !== docId));
    setSelectedDocs(prev => { if (!prev.has(docId)) return prev; const next = new Set(prev); next.delete(docId); return next; });
    const result = await apiFetchJson(`/api/docs/${docId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folderId: targetFolderId }),
    });
    if (!result.ok) {
      toast({ title: "Failed to move document.", variant: "destructive" });
      await loadContents();
    }
  }

  async function moveFolder(folderId: string, targetParentId: string | null) {
    if (targetParentId === currentFolderId) return;
    setFolders(prev => prev.filter(f => f.id !== folderId));
    const result = await apiFetchJson(`/api/folders/${folderId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parentId: targetParentId }),
    });
    if (!result.ok) {
      toast({ title: "Failed to move folder.", variant: "destructive" });
      await loadContents();
    }
  }

  async function downloadDoc(doc: DocItem) {
    const result = await apiFetchJson<{ content: string; title: string }>(`/api/docs/${doc.id}`);
    if (!result.ok || !result.data) return;
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
    setSummaryDoc(doc);
    setSummary(null);
    setSummarizing(true);
    try {
      const result = await apiFetchJson<{ summary: string }>("/api/ai/summarize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ docId: doc.id }),
      });
      if (result.ok && result.data) setSummary(result.data.summary);
      else setSummary("Failed to generate summary.");
    } catch {
      setSummary("Failed to generate summary.");
    } finally {
      setSummarizing(false);
    }
  }

  function openFile(file: FileItem) {
    navigate(`/projects/${projectId}/files/${file.id}`, { state: { folderPath: path } });
  }

  async function downloadFile(file: FileItem) {
    const res = await apiFetch(`/api/files/${file.id}/content`);
    if (!res.ok) return;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = file.name;
    a.click();
    URL.revokeObjectURL(url);
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
    if (!result.ok) {
      toast({ title: "Failed to move file.", variant: "destructive" });
      await loadContents();
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
      setDocs(prev => prev.filter(d => !deletedDocs.has(d.id)));
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
      if (renameTarget.type === "folder") {
        await apiFetch(`/api/folders/${renameTarget.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: trimmed }),
        });
        setFolders(prev => prev.map(f => f.id === renameTarget.id ? { ...f, name: trimmed } : f));
      } else if (renameTarget.type === "doc") {
        await apiFetch(`/api/docs/${renameTarget.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: trimmed }),
        });
        setDocs(prev => prev.map(d => d.id === renameTarget.id ? { ...d, title: trimmed } : d));
      } else {
        await apiFetch(`/api/files/${renameTarget.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: trimmed }),
        });
        setFiles(prev => prev.map(f => f.id === renameTarget.id ? { ...f, name: trimmed } : f));
      }
      setRenameTarget(null);
    } finally {
      setRenaming(false);
    }
  }

  async function handleContextDelete() {
    if (!contextDeleteTarget || contextDeleting) return;
    setContextDeleting(true);
    const { type, id } = contextDeleteTarget;
    try {
      if (type === "folder") {
        await apiFetch(`/api/folders/${id}`, { method: "DELETE" });
        setFolders(prev => prev.filter(f => f.id !== id));
      } else if (type === "doc") {
        await apiFetch(`/api/docs/${id}`, { method: "DELETE" });
        setDocs(prev => prev.filter(d => d.id !== id));
      } else {
        await apiFetch(`/api/files/${id}`, { method: "DELETE" });
        setFiles(prev => prev.filter(f => f.id !== id));
      }
      setContextDeleteTarget(null);
    } finally {
      setContextDeleting(false);
    }
  }

  const uploadFileAndCreateDoc = useCallback(async (file: File) => {
    setUploadingCount(c => c + 1);
    try {
      // .md / .txt files → import content as a new document
      if (file.name.endsWith(".md") || file.name.endsWith(".txt")) {
        const content = await file.text();
        const title = file.name.replace(/\.(md|txt)$/i, "") || "Untitled";
        const docResult = await apiFetchJson<DocItem & { id: string }>("/api/docs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title, content, projectId, folderId: currentFolderId }),
        });
        if (docResult.ok && docResult.data) {
          onDocCreated(docResult.data);
          setDocs(prev => [...prev, docResult.data!].sort((a, b) => a.title.localeCompare(b.title)));
        }
        return;
      }

      // Everything else → upload as a native file entry
      const form = new FormData();
      form.append("file", file);
      form.append("projectId", projectId);
      if (currentFolderId) form.append("folderId", currentFolderId);
      const uploadResult = await apiFetchJson<FileItem>("/api/files", { method: "POST", body: form });
      if (uploadResult.ok && uploadResult.data) {
        setFiles(prev => [...prev, uploadResult.data!].sort((a, b) => a.name.localeCompare(b.name)));
      }
    } finally {
      setUploadingCount(c => c - 1);
    }
  }, [projectId, currentFolderId, onDocCreated]);

  const handleExternalDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setExternalDragOver(false);
    if (draggedItem.current) return; // internal drag, not our concern
    Array.from(e.dataTransfer.files).forEach(uploadFileAndCreateDoc);
  }, [uploadFileAndCreateDoc]);

  function onDragStart(e: React.DragEvent, type: "doc" | "folder" | "file", id: string) {
    draggedItem.current = { type, id };
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", id);
  }

  function onDragEnd() {
    draggedItem.current = null;
    setDropTarget(null);
  }

  function onCrumbDragOver(e: React.DragEvent, crumbId: string | null) {
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

  function renderTable(folderRows: FolderItem[], docRows: DocItem[], fileRows: FileItem[] = []) {
    // Sort within each group; folders stay pinned above docs above files.
    const sortedFolders = sortFolders(folderRows, sort);
    const sortedDocs = sortDocs(docRows, sort);
    const sortedFiles = sortFiles(fileRows, sort);
    // Re-fit the auto-sizing columns ("Name", "Created by") whenever the text
    // shown in them changes — folder/doc/file names plus author/uploader names.
    // Deliberately excludes selection state, so checkbox toggles don't re-measure.
    const measureKey = [
      ...sortedFolders.map(f => f.name),
      ...sortedDocs.map(d => `${d.title} ${d.author_name ?? ""}`),
      ...sortedFiles.map(f => `${f.name} ${f.uploader_name ?? ""}`),
    ].join("|");
    return (
      <ResizableTable columns={FILE_COLUMNS} checkboxColumn={canEdit} storageKey="file-columns" sort={sort} onSort={handleSort} measureKey={measureKey}>
        <>
          {sortedFolders.map(folder => {
            const isDropTarget = dropTarget === folder.id;
            const folderRow = (
              <ResizableTableRow
                columns={FILE_COLUMNS}
                draggable
                  onDragStart={e => onDragStart(e, "folder", folder.id)}
                  onDragEnd={onDragEnd}
                  onDragOver={e => {
                    if (draggedItem.current?.id === folder.id) return;
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
                        <div className="group flex items-center w-full min-w-0">
                          <Folder className={`h-4 w-4 shrink-0 mr-2 ${isDropTarget ? "text-primary" : "text-primary/70"}`} />
                          <span className="text-sm font-medium truncate">{folder.name}</span>
                          {folderCounts.has(folder.id) && (() => {
                            const c = folderCounts.get(folder.id)!;
                            const parts = [];
                            if (c.files > 0) parts.push(`${c.files} ${c.files === 1 ? "file" : "files"}`);
                            if (c.folders > 0) parts.push(`${c.folders} ${c.folders === 1 ? "folder" : "folders"}`);
                            return parts.length > 0 ? (
                              <Badge variant="outline" className="ml-2 shrink-0 text-xs text-muted-foreground">
                                {parts.join(", ")}
                              </Badge>
                            ) : null;
                          })()}
                          {canEdit && (
                            <button
                              onClick={e => { e.stopPropagation(); setRenameTarget({ type: "folder", id: folder.id, currentName: folder.name }); setRenameName(folder.name); }}
                              className="ml-1.5 shrink-0 opacity-0 group-hover:opacity-100 p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-opacity"
                              title="Rename"
                            >
                              <Pencil className="h-3 w-3" />
                            </button>
                          )}
                        </div>
                      ),
                      onClick: () => enterFolder(folder),
                    },
                    { content: null },
                    { content: null },
                    { content: null },
                  ]}
                />
            );
            if (!canEdit) return <div key={folder.id}>{folderRow}</div>;
            return (
              <ContextMenu key={folder.id}>
                <ContextMenuTrigger asChild><div>{folderRow}</div></ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem onClick={() => { setRenameTarget({ type: "folder", id: folder.id, currentName: folder.name }); setRenameName(folder.name); }}>
                    <Pencil />
                    Rename
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem variant="destructive" onClick={() => setContextDeleteTarget({ type: "folder", id: folder.id, name: folder.name })}>
                    <Trash2 />
                    Delete
                  </ContextMenuItem>
                </ContextMenuContent>
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
                      checked={selectedDocs.has(doc.id)}
                      onClick={(e) => {
                        const willBeChecked = !selectedDocs.has(doc.id);
                        if (e.shiftKey && lastCheckedDocIndex.current !== null) {
                          const from = Math.min(lastCheckedDocIndex.current, docIdx);
                          const to = Math.max(lastCheckedDocIndex.current, docIdx);
                          setSelectedDocs(prev => {
                            const next = new Set(prev);
                            for (let i = from; i <= to; i++) {
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
                        <div className="group flex items-center w-full min-w-0">
                          {isHome
                            ? <House className="h-4 w-4 shrink-0 mr-2 text-primary/70" />
                            : <FileText className="h-4 w-4 shrink-0 mr-2 text-muted-foreground/60" />
                          }
                          <span className="text-sm truncate">{doc.title || "Untitled"}</span>
                          {canEdit && (
                            <button
                              onClick={e => { e.stopPropagation(); setRenameTarget({ type: "doc", id: doc.id, currentName: doc.title || "Untitled" }); setRenameName(doc.title || "Untitled"); }}
                              className="ml-1.5 shrink-0 opacity-0 group-hover:opacity-100 p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-opacity"
                              title="Rename"
                            >
                              <Pencil className="h-3 w-3" />
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
                          <div className="flex items-center gap-0.5">
                            {aiEnabled && (
                              <button
                                onClick={e => handleSummarize(e, doc)}
                                className="shrink-0 p-1 rounded text-violet-400 hover:text-violet-300 hover:bg-muted"
                                title="Summarise with AI"
                              >
                                <Sparkles className="h-3.5 w-3.5" />
                              </button>
                            )}
                            <button
                              onClick={e => handleDownloadDoc(e, doc)}
                              className="shrink-0 p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted"
                              title="Download as markdown"
                            >
                              <Download className="h-3.5 w-3.5" />
                            </button>
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
                <ContextMenuContent>
                  <ContextMenuItem onClick={() => { navigator.clipboard.writeText(`${window.location.origin}/projects/${projectId}/docs/${doc.id}`); toast({ title: "Link copied" }); }}>
                    <Link />
                    Copy link
                  </ContextMenuItem>
                  <ContextMenuItem onClick={() => downloadDoc(doc)}>
                    <Download />
                    Download
                  </ContextMenuItem>
                  {canEdit && <ContextMenuSeparator />}
                  {canEdit && (
                    <ContextMenuItem onClick={() => { setRenameTarget({ type: "doc", id: doc.id, currentName: doc.title || "Untitled" }); setRenameName(doc.title || "Untitled"); }}>
                      <Pencil />
                      Rename
                    </ContextMenuItem>
                  )}
                  {canEdit && !isHome && (
                    <ContextMenuItem variant="destructive" onClick={() => setContextDeleteTarget({ type: "doc", id: doc.id, name: doc.title || "Untitled" })}>
                      <Trash2 />
                      Delete
                    </ContextMenuItem>
                  )}
                </ContextMenuContent>
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
                    checked={selectedFiles.has(file.id)}
                    onClick={(e) => {
                      const willBeChecked = !selectedFiles.has(file.id);
                      if (e.shiftKey && lastCheckedFileIndex.current !== null) {
                        const from = Math.min(lastCheckedFileIndex.current, fileIdx);
                        const to = Math.max(lastCheckedFileIndex.current, fileIdx);
                        setSelectedFiles(prev => {
                          const next = new Set(prev);
                          for (let i = from; i <= to; i++) {
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
                      <div className="group flex items-center w-full min-w-0">
                        <FileIcon mimeType={file.mime_type} className="h-4 w-4 shrink-0 mr-2 text-muted-foreground/60" />
                        <span className="text-sm truncate">{file.name}</span>
                        {canEdit && (
                          <button
                            onClick={e => { e.stopPropagation(); setRenameTarget({ type: "file", id: file.id, currentName: file.name }); setRenameName(file.name); }}
                            className="ml-1.5 shrink-0 opacity-0 group-hover:opacity-100 p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-opacity"
                            title="Rename"
                          >
                            <Pencil className="h-3 w-3" />
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
                        <span className="text-sm text-muted-foreground truncate">{formatRelativeTime(file.created_at)}</span>
                        <button
                          onClick={e => { e.stopPropagation(); downloadFile(file); }}
                          className="shrink-0 p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted"
                          title="Download"
                        >
                          <Download className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ),
                  },
                ]}
              />
            );
            return (
              <ContextMenu key={file.id}>
                <ContextMenuTrigger asChild><div>{fileRow}</div></ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem onClick={() => { navigator.clipboard.writeText(`${window.location.origin}/projects/${projectId}/files/${file.id}`); toast({ title: "Link copied" }); }}>
                    <Link />
                    Copy link
                  </ContextMenuItem>
                  <ContextMenuItem onClick={() => downloadFile(file)}>
                    <Download />
                    Download
                  </ContextMenuItem>
                  {canEdit && <ContextMenuSeparator />}
                  {canEdit && (
                    <ContextMenuItem onClick={() => { setRenameTarget({ type: "file", id: file.id, currentName: file.name }); setRenameName(file.name); }}>
                      <Pencil />
                      Rename
                    </ContextMenuItem>
                  )}
                  {canEdit && (
                    <ContextMenuItem variant="destructive" onClick={() => setContextDeleteTarget({ type: "file", id: file.id, name: file.name })}>
                      <Trash2 />
                      Delete
                    </ContextMenuItem>
                  )}
                </ContextMenuContent>
              </ContextMenu>
            );
          })}
        </>
      </ResizableTable>
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
      {(externalDragOver || uploadingCount > 0) && (
        <div className="pointer-events-none absolute inset-3 z-20 flex flex-col items-center justify-center gap-2 rounded-lg bg-background/80 backdrop-blur-sm ring-2 ring-inset ring-primary/40">
          <Upload className="h-8 w-8 text-primary/60" />
          <p className="text-sm font-medium text-muted-foreground">
            {uploadingCount > 0 ? `Uploading ${uploadingCount} ${uploadingCount === 1 ? "file" : "files"}…` : "Drop to upload"}
          </p>
        </div>
      )}

      {/* Toolbar */}
      <div className="flex items-center gap-2 px-6 py-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            placeholder="Search files…"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="pl-9 pr-8"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 h-5 w-5 flex items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        {canEdit && (
          <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setShowNewFolder(true)}>
            <FolderPlus className="h-3.5 w-3.5" />
            New folder
          </Button>
        )}
        {canEdit && (
          <Button size="sm" className="gap-1.5" onClick={handleNewDoc} disabled={creatingDoc}>
            <Plus className="h-3.5 w-3.5" />
            {creatingDoc ? "Creating…" : "New document"}
          </Button>
        )}
        {canEdit && (selectedDocs.size > 0 || selectedFiles.size > 0) && (
          <Button size="sm" variant="destructive" className="gap-1.5" onClick={() => setDeleteConfirmOpen(true)} disabled={deleting}>
            <Trash2 className="h-3.5 w-3.5" />
            {deleting ? "Deleting…" : `Delete (${selectedDocs.size + selectedFiles.size})`}
          </Button>
        )}
      </div>

      {/* Table */}
      <div className="px-6 pb-6">
        {loading ? (
          <div className="flex flex-col gap-1.5 pt-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : searchResults !== null ? (
          searchResults.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <Search className="mb-3 h-10 w-10 text-muted-foreground/30" />
              <p className="text-sm font-medium text-muted-foreground">No files found</p>
            </div>
          ) : renderTable([], searchResults)
        ) : folders.length === 0 && docs.length === 0 && files.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <Folder className="mb-3 h-10 w-10 text-muted-foreground/30" />
            <p className="text-sm font-medium text-muted-foreground">This folder is empty</p>
          </div>
        ) : renderTable(folders, docs, files)}
      </div>

      {/* New folder dialog */}
      <Dialog open={showNewFolder} onOpenChange={setShowNewFolder}>
        <DialogContent className="sm:max-w-xs">
          <DialogHeader>
            <DialogTitle>New folder</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleCreateFolder} className="flex flex-col gap-3">
            <Input
              placeholder="Folder name"
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
            <Input
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
