import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useNavigate, useOutletContext } from "react-router-dom";
import type { DocsLayoutContext } from "@/layouts/DocsLayout";
import { Folder, FileText, FilePlus, House, Plus, FolderPlus, Search, X, Download, Upload, Trash2, Pencil, Link, Sparkles, PenTool, MoreVertical, FolderInput, Code, RefreshCw, SquareCheck, ChevronDown, Check, Minus } from "lucide-react";
import { Checkbox as CheckboxPrimitive } from "radix-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { ResizableTable, ResizableTableRow } from "@/components/ui/resizable-table";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import { apiFetch, apiFetchJson } from "@/lib/apiFetch";
import { sortFolders, sortDocs, sortFiles, type SortDir } from "@/lib/fileSort";
import { formatBytes, formatRelativeTime, moveDestinations, folderPathLabel, shiftSelectionRange, folderCountLabel, countedFolderFor, type FolderCounts } from "@/lib/fileManager";
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
import { restoreTrashEntry } from "@/lib/trash";
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


// The default avatar fallback (bg-accent) nearly vanishes against the table
// surface - give the initials a visible disc and hairline ring here.
const AUTHOR_AVATAR_CLASS =
  "h-6 w-6 shrink-0 ring-1 ring-border [&_[data-slot=avatar-fallback]]:bg-muted [&_[data-slot=avatar-fallback]]:text-[10px] [&_[data-slot=avatar-fallback]]:text-foreground/80";

// "Created by" cell - the author/uploader avatar and name (role in the
// tooltip), linking to the user's profile card when we have an id. The name
// truncates in its own span so it never overflows the cell.
function AuthorCell({ userId, name, role }: { userId?: string; name?: string; role?: Role | null }) {
  if (userId && name) {
    return (
      <UserProfileCard userId={userId} name={name}>
        <div className="flex items-center gap-2 min-w-0 text-sm text-muted-foreground cursor-pointer hover:text-foreground transition-colors">
          <UserAvatar userId={userId} name={name} className={AUTHOR_AVATAR_CLASS} />
          <span className="truncate" title={role ? `${name} · ${ROLE_LABELS[role]}` : name}>{name}</span>
        </div>
      </UserProfileCard>
    );
  }
  if (!name) return <EmptyCell label="Unknown author" />;
  return (
    <div className="flex items-center gap-2 min-w-0 text-sm text-muted-foreground">
      <span className="truncate" title={role ? `${name} · ${ROLE_LABELS[role]}` : name}>{name}</span>
    </div>
  );
}

// Muted em dash for a cell with no value - every row fills every column, so
// nothing reads as a rendering gap. The label is for screen readers.
// Folder size shown on its row/card: one total ("1 item", "7 items", "Empty")
// on desktop and mobile alike; the doc/file/folder breakdown rides in the
// tooltip (folderCountLabel).
function folderItemsLabel(c: FolderCounts | undefined): string {
  const n = c ? c.docs + c.files + c.folders : 0;
  return n === 0 ? "Empty" : `${n} ${n === 1 ? "item" : "items"}`;
}

function EmptyCell({ label }: { label: string }) {
  return (
    <span className="text-sm text-muted-foreground/50">
      <span aria-hidden="true">&mdash;</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

// Module-scope so the array identity is stable across renders - the table keys
// its segment memo off this reference. Every column is a proportional share of
// the table width (no content auto-fit), so the columns sit in the same place
// in every folder; row actions live in a fixed trailing column.
const FILE_COLUMNS = [
  { label: "Name", defaultSize: 42, minSize: 20, sortable: true },
  { label: "Created by", defaultSize: 22, minSize: 12, sortable: true },
  { label: "Size", defaultSize: 14, minSize: 8, sortable: true },
  { label: "Last updated", defaultSize: 22, minSize: 10, sortable: true },
];
// Bumped from "file-columns" when the layout above changed, so stale persisted
// px widths from the old auto-fit columns don't carry over.
const FILE_COLUMNS_STORAGE_KEY = "file-columns-v2";

// Higher-contrast checkbox border for the listing (the shared default is too
// faint against the table surface): the same full-strength grey as the
// row action icons.
const ROW_CHECKBOX_CLASS = "border-muted-foreground data-[state=checked]:border-primary";

// Header select-all box. A local primitive rather than the shared Checkbox
// because the shared one always draws a check - the indeterminate (partial
// selection) state needs a dash. Styles mirror the shared box + row override.
function SelectAllCheckbox({ checked, onCheckedChange, disabled }: {
  checked: boolean | "indeterminate";
  onCheckedChange: () => void;
  disabled?: boolean;
}) {
  return (
    <CheckboxPrimitive.Root
      aria-label={checked === true ? "Deselect all" : "Select all"}
      title={checked === true ? "Deselect all" : "Select all"}
      checked={checked}
      disabled={disabled}
      onCheckedChange={onCheckedChange}
      className="peer size-4 shrink-0 rounded-[4px] border border-muted-foreground shadow-xs transition-shadow outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30 data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground data-[state=indeterminate]:border-primary data-[state=indeterminate]:bg-primary data-[state=indeterminate]:text-primary-foreground"
    >
      <CheckboxPrimitive.Indicator className="grid place-content-center text-current transition-none">
        {checked === "indeterminate" ? <Minus className="size-3.5" /> : <Check className="size-3.5" />}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

// A row stays highlighted while its right-click menu (the ContextMenuTrigger
// wrapper, `group/rowmenu`) or its kebab (`data-row-menu`) is open, so it's
// clear which item the menu acts on once the pointer moves into the menu.
const ROW_MENU_OPEN_CLASS =
  "group-data-[state=open]/rowmenu:bg-accent has-[[data-row-menu][data-state=open]]:bg-accent";
// Checked rows get a quiet tint so a multi-selection reads at a glance.
const ROW_SELECTED_CLASS = "bg-accent/50";

// Dropdown menu items carry no icon sizing of their own (context menu items
// do) - match them: 16px muted icons, the destructive item keeping its red.
const MENU_ICON_CLASS =
  "[&_svg:not([class*='size-'])]:size-4 [&_[role=menuitem]:not([data-variant=destructive])_svg]:text-muted-foreground";

// Trailing actions column: up to three (with AI) / two 32px buttons, 4px
// gaps, and the cell's 8px right padding.
const ACTIONS_COL = 2 * 32 + 4 + 8;
const ACTIONS_COL_WITH_AI = 3 * 32 + 2 * 4 + 8;

// Shared sizing for the per-row menus (context menu + kebabs).
const ROW_MENU_CLASS = `min-w-[200px] [&_[role=menuitem]]:pr-4 ${MENU_ICON_CLASS}`;

// Square 32px icon button for the desktop row actions column - 16px icons in
// full-strength muted grey so the actions read without hovering the row.
const ROW_ICON_BUTTON_CLASS =
  "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

// The same five actions repeat across the desktop context menu, the desktop
// kebab, and the mobile kebab - render them once from a "kit" of menu-item
// components (ContextMenuItem vs DropdownMenuItem) so the sets can't drift.
interface MenuKit {
  Item: React.ElementType;
  Separator: React.ElementType;
}

// Toggle one row's checkbox in a selection set - or, with Shift held and an
// anchor set, every row from the anchor to it (all on or all off, following
// the clicked row). Rows matching `skip` (the home doc) never join.
function applyCheck<T extends { id: string }>(
  prev: Set<string>,
  list: T[],
  idx: number,
  anchor: number | null,
  shift: boolean,
  skip?: (item: T) => boolean,
): Set<string> {
  const willBeChecked = !prev.has(list[idx].id);
  const range = shift ? shiftSelectionRange(anchor, idx, list.length) : null;
  const next = new Set(prev);
  for (let i = range ? range.from : idx; i <= (range ? range.to : idx); i++) {
    if (skip?.(list[i])) continue;
    if (willBeChecked) next.add(list[i].id);
    else next.delete(list[i].id);
  }
  return next;
}

// Search matches for the current folder's own folders/files (the server-side
// search covers docs only). Case-insensitive substring on the name.
function nameMatches(name: string, query: string): boolean {
  return name.toLocaleLowerCase().includes(query.toLocaleLowerCase());
}

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
    folderCounts, bumpFolderCount, path, loading, error: loadError, reload,
  } = useFolderContents(projectId, currentFolderId, projectName);

  const [selectedFolders, setSelectedFolders] = useState<Set<string>>(new Set());
  const [selectedDocs, setSelectedDocs] = useState<Set<string>>(new Set());
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const lastCheckedFolderIndex = useRef<number | null>(null);
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
    lastCheckedFolderIndex.current = null;
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

  // Latest listed child folders, for the upload callback below - it must stay
  // referentially stable (queued uploads hold on to the closure they started
  // with), so it can't close over `folders` directly.
  const foldersRef = useRef(folders);
  useEffect(() => { foldersRef.current = folders; }, [folders]);

  const { uploads, enqueueFiles, dismissUpload } = useUploads({
    projectId,
    currentFolderId,
    onDocCreated,
    appendDoc: useCallback((doc: DocItem) => setDocs(prev => [...prev, doc]), [setDocs]),
    appendFile: useCallback((file: FileItem) => setFiles(prev => [...prev, file]), [setFiles]),
    // The user left the folder mid-upload; if they went up to its parent, that
    // folder is now a child row and its badge should count the new item.
    onUploadedElsewhere: useCallback((kind: "docs" | "files", folderId: string | null) => {
      if (folderId && foldersRef.current.some(f => f.id === folderId)) bumpFolderCount(folderId, { [kind]: 1 });
    }, [bumpFolderCount]),
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
    setSelectedFolders(new Set());
    setSelectedDocs(new Set());
    setSelectedFiles(new Set());
    lastCheckedFolderIndex.current = null;
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
  }, [path, dropTarget, canEdit]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // Keep the child-folder count badges in step with a local move/delete rather
  // than refetching. Badges are subtree totals, so this resolves which listed
  // folder covers `folderId` - the folder itself, or (once the Move dialog has
  // loaded the full tree) its nearest listed ancestor. Moves within the current
  // folder or into its ancestors resolve to nothing: those have no badge.
  function bumpCountFor(folderId: string | null, delta: Partial<FolderCounts>) {
    const target = countedFolderFor(folderId, new Set(folders.map(f => f.id)), moveFolders);
    if (target) bumpFolderCount(target, delta);
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
    // The home doc is pinned: its menu hides "Move to folder…" and its row isn't
    // draggable, and this backstops any other route into a move.
    const doc = searchResults?.find(d => d.id === docId) ?? docs.find(d => d.id === docId);
    if (doc?.is_home === 1) return;
    // A search hit can live in a nested folder, so its source may be a listed
    // child whose badge has to drop as well.
    const sourceFolderId = doc ? doc.folder_id : currentFolderId;
    updateDocLists(prev => prev.filter(d => d.id !== docId));
    setSelectedDocs(prev => { if (!prev.has(docId)) return prev; const next = new Set(prev); next.delete(docId); return next; });
    const result = await apiFetchJson(`/api/docs/${docId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folderId: targetFolderId }),
    });
    if (result.ok) {
      if (sourceFolderId !== targetFolderId) {
        bumpCountFor(sourceFolderId, { docs: -1 });
        bumpCountFor(targetFolderId, { docs: 1 });
      }
    } else if (!result.redirected) {
      toast({ title: "Failed to move document.", description: result.error, variant: "destructive" });
      await reload();
    }
  }

  async function moveFolder(movedFolderId: string, targetParentId: string | null) {
    if (targetParentId === currentFolderId) return;
    // The moved folder carries its whole subtree into the destination's totals.
    const moved = folderCounts.get(movedFolderId);
    setFolders(prev => prev.filter(f => f.id !== movedFolderId));
    setSelectedFolders(prev => { if (!prev.has(movedFolderId)) return prev; const next = new Set(prev); next.delete(movedFolderId); return next; });
    const result = await apiFetchJson(`/api/folders/${movedFolderId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parentId: targetParentId }),
    });
    if (result.ok) {
      bumpCountFor(targetParentId, { folders: 1 + (moved?.folders ?? 0), docs: moved?.docs ?? 0, files: moved?.files ?? 0 });
    } else if (!result.redirected) {
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
    if (result.ok) {
      bumpCountFor(targetFolderId, { files: 1 });
    } else if (!result.redirected) {
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
      const folderIds = [...selectedFolders];
      const docIds = [...selectedDocs];
      const fileIds = [...selectedFiles];
      const results = await Promise.all([
        // Folder deletes report whether the site's home doc had to be left
        // behind at the top level (it can't be binned with its folder).
        ...folderIds.map(async id => {
          const r = await apiFetchJson<{ homeDocMoved?: boolean }>(`/api/folders/${id}`, { method: "DELETE" });
          return { kind: "folder" as const, id, ok: r.ok, homeDocMoved: !!r.data?.homeDocMoved };
        }),
        ...docIds.map(async id => ({ kind: "doc" as const, id, ok: (await apiFetch(`/api/docs/${id}`, { method: "DELETE" })).ok, homeDocMoved: false })),
        ...fileIds.map(async id => ({ kind: "file" as const, id, ok: (await apiFetch(`/api/files/${id}`, { method: "DELETE" })).ok, homeDocMoved: false })),
      ]);
      const deletedFolders = new Set(results.filter(r => r.kind === "folder" && r.ok).map(r => r.id));
      const deletedDocs = new Set(results.filter(r => r.kind === "doc" && r.ok).map(r => r.id));
      const deletedFiles = new Set(results.filter(r => r.kind === "file" && r.ok).map(r => r.id));
      const homeDocMoved = results.some(r => r.ok && r.homeDocMoved);
      const failed = results.filter(r => !r.ok).length;
      // Search hits deleted from inside a listed child folder shrink its badge.
      for (const d of searchResults ?? []) if (deletedDocs.has(d.id)) bumpCountFor(d.folder_id, { docs: -1 });
      setFolders(prev => prev.filter(f => !deletedFolders.has(f.id)));
      updateDocLists(prev => prev.filter(d => !deletedDocs.has(d.id)));
      setFiles(prev => prev.filter(f => !deletedFiles.has(f.id)));
      setSelectedFolders(prev => { const next = new Set(prev); for (const id of deletedFolders) next.delete(id); return next; });
      setSelectedDocs(prev => { const next = new Set(prev); for (const id of deletedDocs) next.delete(id); return next; });
      setSelectedFiles(prev => { const next = new Set(prev); for (const id of deletedFiles) next.delete(id); return next; });
      if (homeDocMoved && currentFolderId === null) void reload();
      if (failed > 0) {
        toast({ title: `${failed} item${failed === 1 ? "" : "s"} couldn't be deleted.`, variant: "destructive" });
      }
      const moved = deletedFolders.size + deletedDocs.size + deletedFiles.size;
      if (moved > 0) {
        toast({
          title: `Moved ${moved} item${moved === 1 ? "" : "s"} to the recycle bin.`,
          description: homeDocMoved ? "The site's home document was moved to the top level." : undefined,
          action: { label: "View bin", onClick: () => navigate(`/projects/${projectId}/settings#recycle-bin`) },
        });
      }
    } finally {
      setDeleting(false);
    }
  }

  // "Undo" on the moved-to-bin toast: restore the entry, then refetch so the
  // item (and any folder badge it affects) reappears where the server put it.
  async function undoDelete(entryId: string, name: string) {
    const result = await restoreTrashEntry(projectId, entryId);
    if (result.ok) await reload();
    else if (!result.redirected) toast({ title: `Couldn't restore "${name}".`, description: result.error, variant: "destructive" });
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
    const { type, id, name } = contextDeleteTarget;
    try {
      const endpoint = type === "folder" ? `/api/folders/${id}` : type === "doc" ? `/api/docs/${id}` : `/api/files/${id}`;
      const result = await apiFetchJson<{ trashEntryId?: string; homeDocMoved?: boolean }>(endpoint, { method: "DELETE" });
      if (result.ok) {
        const entryId = result.data?.trashEntryId;
        toast({
          title: `Moved "${name}" to the recycle bin.`,
          // The home doc can't be binned, so a folder holding it leaves it behind.
          description: result.data?.homeDocMoved ? "The site's home document was moved to the top level." : undefined,
          action: entryId ? { label: "Undo", onClick: () => { void undoDelete(entryId, name); } } : undefined,
        });
        if (result.data?.homeDocMoved && currentFolderId === null) void reload();
        // Docs/files also leave the bulk selection - otherwise the toolbar keeps
        // counting them and a later bulk delete reports them as failures.
        if (type === "folder") {
          setFolders(prev => prev.filter(f => f.id !== id));
          setSelectedFolders(prev => { if (!prev.has(id)) return prev; const next = new Set(prev); next.delete(id); return next; });
        } else if (type === "doc") {
          const hit = searchResults?.find(d => d.id === id);
          if (hit) bumpCountFor(hit.folder_id, { docs: -1 });
          updateDocLists(prev => prev.filter(d => d.id !== id));
          setSelectedDocs(prev => { if (!prev.has(id)) return prev; const next = new Set(prev); next.delete(id); return next; });
        } else {
          setFiles(prev => prev.filter(f => f.id !== id));
          setSelectedFiles(prev => { if (!prev.has(id)) return prev; const next = new Set(prev); next.delete(id); return next; });
        }
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
    // Rows are only `draggable` for editors, but a native drag of something
    // inside a row still bubbles here - never arm an internal move for a
    // viewer (it would 403, or for a doc-share editor silently not move).
    if (!canEdit) return;
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
    if (!canEdit || !draggedItem.current) return;
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
    if (!canEdit || !item) return;
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
        {canEdit && !isHome && <M.Separator />}
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
      <M.Item title="Copy markdown to embed this file in a doc" onClick={() => { navigator.clipboard.writeText(fileEmbedMarkdown(file)); toast({ title: "Embed copied", description: "Paste it into a doc to embed this file." }); }}>
        <Code />
        Copy embed
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
      {canEdit && <M.Separator />}
      {canEdit && (
        <M.Item variant="destructive" onClick={() => setContextDeleteTarget({ type: "file", id: file.id, name: file.name })}>
          <Trash2 />
          Delete
        </M.Item>
      )}
    </>
  );

  // Folder delete dialog: say what goes to the bin with it (badge counts are
  // full-subtree totals).
  const contextDeleteCountLabel = contextDeleteTarget?.type === "folder"
    ? folderCountLabel(folderCounts.get(contextDeleteTarget.id))
    : "";

  const contextKit: MenuKit = { Item: ContextMenuItem, Separator: ContextMenuSeparator };
  const dropdownKit: MenuKit = { Item: DropdownMenuItem, Separator: DropdownMenuSeparator };

  // Sort within each group; folders stay pinned above docs above files. In
  // search mode the doc results replace the folder view's lists. Memoized so a
  // checkbox toggle doesn't re-sort all three arrays.
  // Search mode: the server's doc hits (whole subtree) plus this folder's own
  // folders/files whose names match.
  const trimmedQuery = searchQuery.trim();
  const displayFolders = useMemo(
    () => (inSearch ? folders.filter(f => nameMatches(f.name, trimmedQuery)) : folders),
    [inSearch, folders, trimmedQuery],
  );
  const displayDocs = searchResults ?? docs;
  const displayFiles = useMemo(
    () => (inSearch ? files.filter(f => nameMatches(f.name, trimmedQuery)) : files),
    [inSearch, files, trimmedQuery],
  );
  const sortedFolders = useMemo(() => sortFolders(displayFolders, sort), [displayFolders, sort]);
  const sortedDocs = useMemo(() => sortDocs(displayDocs, sort), [displayDocs, sort]);
  const sortedFiles = useMemo(() => sortFiles(displayFiles, sort), [displayFiles, sort]);

  const selectedCount = selectedFolders.size + selectedDocs.size + selectedFiles.size;

  function renderTable() {
    // Mobile card helpers. The kebab mirrors the desktop ContextMenu exactly;
    // on desktop the same kebab renders in the row's last cell so keyboard
    // users can reach Move/Delete/Copy without a right-click.
    const toggleIn = (set: React.Dispatch<React.SetStateAction<Set<string>>>) => (id: string) =>
      set(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
    const toggleFolderSel = toggleIn(setSelectedFolders);
    const toggleDocSel = toggleIn(setSelectedDocs);
    const toggleFileSel = toggleIn(setSelectedFiles);
    // Desktop checkbox click: plain toggle, or a Shift range from the last
    // checkbox clicked in the same group.
    const checkClick = <T extends { id: string }>(
      list: T[],
      idx: number,
      anchorRef: React.MutableRefObject<number | null>,
      set: React.Dispatch<React.SetStateAction<Set<string>>>,
      skip?: (item: T) => boolean,
    ) => (e: React.MouseEvent) => {
      const anchor = anchorRef.current;
      const shift = e.shiftKey;
      set(prev => applyCheck(prev, list, idx, anchor, shift, skip));
      anchorRef.current = idx;
    };
    const isHomeDoc = (d: DocItem) => d.is_home === 1;
    const rowClass = (selected: boolean, extra?: string) =>
      [ROW_MENU_OPEN_CLASS, selected ? ROW_SELECTED_CLASS : "", extra ?? ""].filter(Boolean).join(" ");
    const renderKebab = (label: string, items: React.ReactNode, compact = false) => (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            data-row-menu=""
            aria-label={label}
            title={label}
            onClick={e => e.stopPropagation()}
            className={compact
              ? ROW_ICON_BUTTON_CLASS
              : "inline-flex items-center justify-center h-10 w-10 -mr-1.5 shrink-0 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent"}
          >
            <MoreVertical className="h-4 w-4" />
          </button>
        </DropdownMenuTrigger>
        {/* Menu items render in a portal, but React still bubbles their clicks
            through the component tree - stop them before they reach the row's
            own onClick (which would also open the item). */}
        <DropdownMenuContent align="end" className={ROW_MENU_CLASS} onClick={e => e.stopPropagation()}>{items}</DropdownMenuContent>
      </DropdownMenu>
    );

    // Mobile: row checkboxes stay hidden until a selection is started from a
    // row's "Select" menu item; then every row reserves the checkbox slot so
    // the icons stay in one column.
    const mobileSelecting = canEdit && selectedCount > 0;
    const mobileCheckSlot = (control?: React.ReactNode) => mobileSelecting ? (
      <div className="flex items-center justify-center min-w-10 min-h-10 -ml-1 shrink-0" onClick={e => e.stopPropagation()}>
        {control}
      </div>
    ) : null;
    const selectItem = (onSelect: () => void) => (
      <>
        <DropdownMenuItem onClick={onSelect}>
          <SquareCheck />
          Select
        </DropdownMenuItem>
        <DropdownMenuSeparator />
      </>
    );

    // Header select-all: every visible folder/doc/file except the home doc
    // (which can't be binned or moved). Partial selection shows a dash.
    const selectableDocs = sortedDocs.filter(d => !isHomeDoc(d));
    const selectableTotal = sortedFolders.length + selectableDocs.length + sortedFiles.length;
    const visibleSelected =
      sortedFolders.filter(f => selectedFolders.has(f.id)).length +
      selectableDocs.filter(d => selectedDocs.has(d.id)).length +
      sortedFiles.filter(f => selectedFiles.has(f.id)).length;
    const allSelected = selectableTotal > 0 && visibleSelected === selectableTotal;
    const headerChecked: boolean | "indeterminate" = allSelected ? true : visibleSelected > 0 ? "indeterminate" : false;
    const toggleSelectAll = () => {
      if (allSelected) {
        setSelectedFolders(new Set());
        setSelectedDocs(new Set());
        setSelectedFiles(new Set());
      } else {
        setSelectedFolders(new Set(sortedFolders.map(f => f.id)));
        setSelectedDocs(new Set(selectableDocs.map(d => d.id)));
        setSelectedFiles(new Set(sortedFiles.map(f => f.id)));
      }
      lastCheckedFolderIndex.current = null;
      lastCheckedDocIndex.current = null;
      lastCheckedFileIndex.current = null;
    };

    return (
      <>
      {/* Desktop: resizable table (md+) */}
      <div className="hidden md:block">
      <ResizableTable
        columns={FILE_COLUMNS}
        checkboxColumn={canEdit}
        headerCheckbox={canEdit ? (
          <SelectAllCheckbox checked={headerChecked} onCheckedChange={toggleSelectAll} disabled={selectableTotal === 0} />
        ) : undefined}
        storageKey={FILE_COLUMNS_STORAGE_KEY} sort={sort} onSort={handleSort} actionsColumn={aiEnabled ? ACTIONS_COL_WITH_AI : ACTIONS_COL}>
        <>
          {sortedFolders.map((folder, folderIdx) => {
            const isDropTarget = dropTarget === folder.id;
            const counts = folderCounts.get(folder.id);
            const folderRow = (
              <ResizableTableRow
                columns={FILE_COLUMNS}
                draggable={canEdit}
                  checkboxCell={canEdit ? (
                    <Checkbox
                      aria-label={`Select folder ${folder.name}`}
                      className={ROW_CHECKBOX_CLASS}
                      checked={selectedFolders.has(folder.id)}
                      onClick={checkClick(sortedFolders, folderIdx, lastCheckedFolderIndex, setSelectedFolders)}
                    />
                  ) : undefined}
                  onDragStart={e => onDragStart(e, "folder", folder.id)}
                  onDragEnd={onDragEnd}
                  onDragOver={e => {
                    // Internal drags only - see onCrumbDragOver.
                    if (!canEdit || !draggedItem.current || draggedItem.current.id === folder.id) return;
                    e.preventDefault();
                    setDropTarget(folder.id);
                  }}
                  onDragLeave={() => setDropTarget(null)}
                  onDrop={async e => {
                    e.preventDefault();
                    setDropTarget(null);
                    const item = draggedItem.current;
                    if (!canEdit || !item || item.id === folder.id) return;
                    if (item.type === "doc") await moveDoc(item.id, folder.id);
                    else if (item.type === "file") await moveFile(item.id, folder.id);
                    else await moveFolder(item.id, folder.id);
                  }}
                  className={rowClass(selectedFolders.has(folder.id), isDropTarget ? "bg-primary/10 ring-1 ring-inset ring-primary/40" : undefined)}
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
                          <span className="ml-1.5 shrink-0 whitespace-nowrap text-sm text-muted-foreground" title={folderCountLabel(counts) || "Empty folder"}>
                            <span aria-hidden="true">· </span>{folderItemsLabel(counts)}
                          </span>
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
                      className: "px-3 cursor-pointer",
                      onClick: () => enterFolder(folder),
                    },
                    // Folders carry no author or edit time of their own.
                    { content: <EmptyCell label="No author" /> },
                    // Folders have no byte size - what's inside (full-subtree
                    // totals) rides after the name instead.
                    { content: <EmptyCell label="No size" /> },
                    { content: <EmptyCell label="No update time" /> },
                  ]}
                  actionsCell={canEdit ? renderKebab(`Actions for folder ${folder.name}`, folderActionItems(dropdownKit, folder), true) : null}
                />
            );
            if (!canEdit) return <div key={folder.id}>{folderRow}</div>;
            return (
              <ContextMenu key={folder.id}>
                <ContextMenuTrigger asChild><div className="group/rowmenu">{folderRow}</div></ContextMenuTrigger>
                <ContextMenuContent className={ROW_MENU_CLASS}>{folderActionItems(contextKit, folder)}</ContextMenuContent>
              </ContextMenu>
            );
            })}
          {sortedDocs.map((doc, docIdx) => {
            const isHome = doc.is_home === 1;
            const navToDoc = () => navigate(`/projects/${projectId}/docs/${doc.id}`, { state: { folderPath: path } });
            const docRow = (
              <ResizableTableRow
                columns={FILE_COLUMNS}
                // The home doc can't be moved (see moveDoc), so don't offer a drag.
                draggable={canEdit && !isHome}
                  onDragStart={e => onDragStart(e, "doc", doc.id)}
                  onDragEnd={onDragEnd}
                  checkboxCell={!canEdit ? undefined : isHome ? (
                    // The home doc can't be binned or moved, so it can't join a
                    // bulk selection - a disabled box keeps the column intact.
                    <Checkbox
                      disabled
                      aria-label={`${doc.title || "Untitled"} is the home document and can't be selected`}
                      title="The home document can't be deleted or moved"
                      className={ROW_CHECKBOX_CLASS}
                    />
                  ) : (
                    <Checkbox
                      aria-label={`Select ${doc.title || "Untitled"}`}
                      className={ROW_CHECKBOX_CLASS}
                      checked={selectedDocs.has(doc.id)}
                      onClick={checkClick(sortedDocs, docIdx, lastCheckedDocIndex, setSelectedDocs, isHomeDoc)}
                    />
                  )}
                  className={rowClass(selectedDocs.has(doc.id))}
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
                    { content: <EmptyCell label="No size" /> },
                    {
                      content: <span className="text-sm text-muted-foreground truncate">{formatRelativeTime(doc.updated_at)}</span>,
                    },
                  ]}
                  actionsCell={
                    <>
                      {aiEnabled && (
                        <button
                          type="button"
                          aria-label={`Summarise ${doc.title || "Untitled"} with AI`}
                          onClick={e => handleSummarize(e, doc)}
                          className={ROW_ICON_BUTTON_CLASS}
                          title="Summarise with AI"
                        >
                          <Sparkles className="h-4 w-4" aria-hidden="true" />
                        </button>
                      )}
                      <button
                        type="button"
                        aria-label={`Download ${doc.title || "Untitled"} as markdown`}
                        onClick={e => handleDownloadDoc(e, doc)}
                        className={ROW_ICON_BUTTON_CLASS}
                        title="Download as markdown"
                      >
                        <Download className="h-4 w-4" aria-hidden="true" />
                      </button>
                      {renderKebab(`Actions for ${doc.title || "Untitled"}`, docActionItems(dropdownKit, doc), true)}
                    </>
                  }
                />
            );
            return (
              <ContextMenu key={doc.id}>
                <ContextMenuTrigger asChild><div className="group/rowmenu">{docRow}</div></ContextMenuTrigger>
                <ContextMenuContent className={ROW_MENU_CLASS}>{docActionItems(contextKit, doc)}</ContextMenuContent>
              </ContextMenu>
            );
          })}
          {sortedFiles.map((file, fileIdx) => {
            const fileRow = (
              <ResizableTableRow
                columns={FILE_COLUMNS}
                draggable={canEdit}
                onDragStart={e => onDragStart(e, "file", file.id)}
                onDragEnd={onDragEnd}
                checkboxCell={canEdit ? (
                  <Checkbox
                    aria-label={`Select ${file.name}`}
                    className={ROW_CHECKBOX_CLASS}
                    checked={selectedFiles.has(file.id)}
                    onClick={checkClick(sortedFiles, fileIdx, lastCheckedFileIndex, setSelectedFiles)}
                  />
                ) : undefined}
                className={rowClass(selectedFiles.has(file.id))}
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
                            className="ml-1.5 shrink-0 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 sm:focus-visible:opacity-100 inline-flex items-center justify-center h-9 w-9 sm:h-auto sm:w-auto sm:p-1 sm:min-h-6 sm:min-w-6 -m-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-opacity"
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
                    content: <span className="text-sm text-muted-foreground truncate">{formatRelativeTime(file.updated_at ?? file.created_at)}</span>,
                  },
                ]}
                actionsCell={
                  <>
                    <button
                      type="button"
                      aria-label={`Download ${file.name}`}
                      onClick={e => { e.stopPropagation(); downloadFile(file); }}
                      className={ROW_ICON_BUTTON_CLASS}
                      title="Download"
                    >
                      <Download className="h-4 w-4" aria-hidden="true" />
                    </button>
                    {renderKebab(`Actions for ${file.name}`, fileActionItems(dropdownKit, file), true)}
                  </>
                }
              />
            );
            return (
              <ContextMenu key={file.id}>
                <ContextMenuTrigger asChild><div className="group/rowmenu">{fileRow}</div></ContextMenuTrigger>
                <ContextMenuContent className={ROW_MENU_CLASS}>{fileActionItems(contextKit, file)}</ContextMenuContent>
              </ContextMenu>
            );
          })}
        </>
      </ResizableTable>
      </div>

      {/* Mobile: card list (below md) - same data, tappable rows + kebab actions */}
      <div className="md:hidden rounded-lg border border-border bg-background overflow-hidden">
        {sortedFolders.map(folder => {
          const counts = folderCounts.get(folder.id);
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
              {mobileCheckSlot(
                <Checkbox aria-label={`Select folder ${folder.name}`} className={ROW_CHECKBOX_CLASS} checked={selectedFolders.has(folder.id)} onClick={() => toggleFolderSel(folder.id)} />
              )}
              <Folder className="h-5 w-5 shrink-0 text-primary/70" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{folder.name}</div>
                <div className="truncate text-xs text-muted-foreground" title={folderCountLabel(counts) || "Empty folder"}>
                  {folderItemsLabel(counts)}
                </div>
              </div>
              {canEdit && renderKebab("Folder actions", (
                <>
                  {!selectedFolders.has(folder.id) && selectItem(() => toggleFolderSel(folder.id))}
                  {folderActionItems(dropdownKit, folder)}
                </>
              ))}
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
              {mobileCheckSlot(isHome ? undefined : (
                <Checkbox aria-label={`Select ${doc.title || "Untitled"}`} className={ROW_CHECKBOX_CLASS} checked={selectedDocs.has(doc.id)} onClick={() => toggleDocSel(doc.id)} />
              ))}
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
              {renderKebab("Document actions", (
                <>
                  {canEdit && !isHome && !selectedDocs.has(doc.id) && selectItem(() => toggleDocSel(doc.id))}
                  {docActionItems(dropdownKit, doc)}
                </>
              ))}
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
            {mobileCheckSlot(
              <Checkbox aria-label={`Select ${file.name}`} className={ROW_CHECKBOX_CLASS} checked={selectedFiles.has(file.id)} onClick={() => toggleFileSel(file.id)} />
            )}
            <FileTypeIcon mimeType={file.mime_type} name={file.name} className="h-5 w-5 shrink-0 text-muted-foreground/60" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm">{file.name}</div>
              <div className="truncate text-xs text-muted-foreground">
                {formatBytes(file.size)} · {formatRelativeTime(file.updated_at ?? file.created_at)}
              </div>
            </div>
            {renderKebab("File actions", (
              <>
                {canEdit && !selectedFiles.has(file.id) && selectItem(() => toggleFileSel(file.id))}
                {fileActionItems(dropdownKit, file)}
              </>
            ))}
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

      {/* Toolbar - search on the left, actions right-aligned so the primary
          "New document" sits above the table's trailing columns. Below sm the
          secondary create actions fold into one "New" menu. */}
      <div className="flex flex-wrap items-center gap-2 px-4 sm:px-6 py-3">
        <div className="relative w-full sm:w-auto sm:flex-1 sm:max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" aria-hidden="true" />
          <Input
            placeholder="Search files and documents…"
            aria-label="Search files and documents"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="h-11 pl-9 pr-10 sm:h-9 sm:pr-8"
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
        {canEdit && (
          <div className="flex w-full items-center justify-end gap-2 sm:ml-auto sm:w-auto">
            {selectedCount > 0 && (
              <Button variant="destructive" aria-label={`Delete ${selectedCount} selected`} title="Delete selected" className="mr-auto h-11 gap-1.5 px-3 sm:mr-0 sm:h-9" onClick={() => setDeleteConfirmOpen(true)} disabled={deleting}>
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                {deleting ? "Deleting…" : `Delete (${selectedCount})`}
              </Button>
            )}
            <Button variant="outline" aria-label="Upload files" title="Upload files" className="hidden h-9 gap-1.5 px-3 sm:inline-flex" onClick={() => fileInputRef.current?.click()}>
              <Upload className="h-3.5 w-3.5" aria-hidden="true" />
              Upload
            </Button>
            {/* "New ▾" holds the secondary create actions. Two triggers so the
                touch menu can also carry Upload (no drag-and-drop there)
                without the desktop menu repeating the Upload button. */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" className="hidden h-9 gap-1.5 px-3 sm:inline-flex" disabled={creatingDrawing}>
                  <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                  {creatingDrawing ? "Creating…" : "New"}
                  <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className={`min-w-[180px] ${MENU_ICON_CLASS}`}>
                <DropdownMenuItem onClick={() => setShowNewFolder(true)}>
                  <FolderPlus />
                  New folder
                </DropdownMenuItem>
                <DropdownMenuItem onClick={handleNewDrawing}>
                  <PenTool />
                  New drawing
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" className="h-11 gap-1.5 px-3 sm:hidden" disabled={creatingDrawing}>
                  <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                  {creatingDrawing ? "Creating…" : "New"}
                  <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className={`min-w-[180px] ${MENU_ICON_CLASS} [&_[role=menuitem]]:min-h-11`}>
                <DropdownMenuItem onClick={() => setShowNewFolder(true)}>
                  <FolderPlus />
                  New folder
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => fileInputRef.current?.click()}>
                  <Upload />
                  Upload files
                </DropdownMenuItem>
                <DropdownMenuItem onClick={handleNewDrawing}>
                  <PenTool />
                  New drawing
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button aria-label="New document" title="New document" className="h-11 gap-1.5 px-4 sm:h-9 sm:px-3" onClick={handleNewDoc}>
              <FilePlus className="h-3.5 w-3.5" aria-hidden="true" />
              <span className="sm:hidden">New doc</span>
              <span className="hidden sm:inline">New document</span>
            </Button>
          </div>
        )}
      </div>

      {/* Table - same 16px mobile gutter as the toolbar above */}
      <div className="px-4 pb-6 sm:px-6">
        {loading ? (
          <div className="flex flex-col gap-1.5 pt-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : loadError && !inSearch ? (
          <div className="rounded-lg border border-dashed border-border px-6 py-10 text-center">
            <Folder className="mx-auto mb-3 h-5 w-5 text-muted-foreground" aria-hidden="true" />
            <p className="text-sm font-medium">Couldn't load this folder.</p>
            <p className="mt-1 text-sm text-muted-foreground">{loadError}</p>
            <Button size="sm" variant="outline" className="mt-4 gap-1.5" onClick={() => reload()}>
              <RefreshCw className="h-3.5 w-3.5" />
              Retry
            </Button>
          </div>
        ) : inSearch && sortedDocs.length === 0 && sortedFolders.length === 0 && sortedFiles.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border px-6 py-10 text-center">
            <Search className="mx-auto mb-3 h-5 w-5 text-muted-foreground" aria-hidden="true" />
            <p className="text-sm font-medium">No results</p>
            <p className="mt-1 text-sm text-muted-foreground">Nothing matches “{searchQuery.trim()}”. Try a different search.</p>
          </div>
        ) : !inSearch && folders.length === 0 && docs.length === 0 && files.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border px-6 py-10 text-center">
            <Folder className="mx-auto mb-3 h-5 w-5 text-muted-foreground" aria-hidden="true" />
            <p className="text-sm font-medium">This folder is empty</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {canEdit
                ? "Create a document, add a folder, or drop files here to upload."
                : "Nothing has been added here yet."}
            </p>
          </div>
        ) : renderTable()}
      </div>

      {/* New folder dialog */}
      <Dialog open={showNewFolder} onOpenChange={setShowNewFolder}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>New folder</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleCreateFolder} className="flex flex-col">
            <div className="grid gap-2">
              <Label htmlFor="new-folder-name">Folder name</Label>
              <Input
                id="new-folder-name"
                placeholder="e.g. Meeting notes"
                value={newFolderName}
                onChange={e => setNewFolderName(e.target.value)}
                autoFocus
                required
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setShowNewFolder(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={creatingFolder}>
                {creatingFolder ? "Creating…" : "Create"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Rename dialog */}
      <Dialog open={!!renameTarget} onOpenChange={open => { if (!open) setRenameTarget(null); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Rename</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleRename} className="flex flex-col">
            <div className="grid gap-2">
              <Label htmlFor="rename-name">Name</Label>
              <Input
                id="rename-name"
                value={renameName}
                onChange={e => setRenameName(e.target.value)}
                autoFocus
                required
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setRenameTarget(null)}>
                Cancel
              </Button>
              <Button type="submit" disabled={renaming}>
                {renaming ? "Renaming…" : "Rename"}
              </Button>
            </DialogFooter>
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
              Delete {selectedCount} {selectedCount === 1 ? "item" : "items"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {selectedCount === 1 ? "It" : "They"} will be moved to the recycle bin, where {selectedCount === 1 ? "it" : "they"} can be restored for 30 days.
              {selectedFolders.size > 0 && " Folders go with everything in them."}
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
              {contextDeleteTarget?.type === "folder"
                ? `The folder${contextDeleteCountLabel ? ` and everything in it (${contextDeleteCountLabel})` : ""} will be moved to the recycle bin, where it can be restored for 30 days.`
                : "It will be moved to the recycle bin, where it can be restored for 30 days."}
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
