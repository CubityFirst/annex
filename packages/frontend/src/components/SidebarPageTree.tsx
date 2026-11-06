// Compact, collapsible page tree for the in-app project sidebar (DocsLayout).
// The in-app counterpart of the public site's NavTree (PublicDocPage): folders
// expand/collapse (state remembered per site in localStorage), docs and files
// link to their app routes, and the folders holding the open doc/file are
// auto-expanded so the active row is always visible.
//
// Data is owned by DocsLayout (it already loads the site's docs/folders for
// the outlet context); this component only indexes and renders it. Pages that
// mutate the tree without navigating can call `notifySiteTreeChanged()` to
// make the layout refetch.

import { useEffect, useMemo, useRef, useState } from "react";
import { NavLink, useMatch } from "react-router-dom";
import { ChevronRight, FileText, Folder, FolderOpen, House } from "lucide-react";
import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";
import { FileTypeIcon } from "@/components/FileTypeIcon";

export interface TreeDoc {
  id: string;
  title: string;
  display_title?: string | null;
  folder_id?: string | null;
  is_home?: number;
  sidebar_position?: number | null;
}

export interface TreeFolder {
  id: string;
  name: string;
  parent_id: string | null;
}

export interface TreeFile {
  id: string;
  name: string;
  mime_type: string;
  folder_id: string | null;
}

// ── "tree changed" bus ──────────────────────────────────────────────────────

const TREE_CHANGED_EVENT = "cd:site-tree-changed";

/** Ask the project sidebar to refetch its page tree (e.g. after a rename, move
 *  or delete that didn't change the route). */
export function notifySiteTreeChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(TREE_CHANGED_EVENT));
}

export function onSiteTreeChanged(callback: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(TREE_CHANGED_EVENT, callback);
  return () => window.removeEventListener(TREE_CHANGED_EVENT, callback);
}

// ── expanded-folder persistence ─────────────────────────────────────────────

const EXPANDED_KEY = "cd_sidebar_tree_expanded";
const MAX_STORED_PER_SITE = 200;

function readExpandedStore(): Record<string, string[]> {
  try {
    const raw = localStorage.getItem(EXPANDED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, string[]> : {};
  } catch {
    return {};
  }
}

function readExpanded(projectId: string): Set<string> {
  const ids = readExpandedStore()[projectId];
  return new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : []);
}

function writeExpanded(projectId: string, ids: Set<string>): void {
  try {
    const store = readExpandedStore();
    if (ids.size === 0) delete store[projectId];
    else store[projectId] = [...ids].slice(-MAX_STORED_PER_SITE);
    localStorage.setItem(EXPANDED_KEY, JSON.stringify(store));
  } catch {
    // storage disabled / quota - expanded state just won't persist
  }
}

// ── rendering ───────────────────────────────────────────────────────────────

/** Rows rendered per folder level before a "Show more" button - keeps huge
 *  flat sites from mounting thousands of links at once. */
const LEVEL_LIMIT = 50;

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

type Row =
  | { kind: "folder"; folder: TreeFolder }
  | { kind: "doc"; doc: TreeDoc }
  | { kind: "file"; file: TreeFile };

// 32px rows on desktop; 40px touch targets in the mobile drawer (below md).
const ROW_CLASS = "h-8 max-md:h-10 w-full justify-start gap-1.5 px-2 text-sm font-normal";
const rowTone = (active: boolean) => (active ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground");

export function SidebarPageTree({
  projectId,
  docs,
  folders,
  files,
}: {
  projectId: string;
  docs: TreeDoc[];
  folders: TreeFolder[];
  files: TreeFile[];
}) {
  const docMatch = useMatch("/projects/:projectId/docs/:docId");
  const fileMatch = useMatch("/projects/:projectId/files/:fileId");
  const activeDocId = docMatch?.params.docId ?? null;
  const activeFileId = fileMatch?.params.fileId ?? null;
  // File manager folder views (/folders/:id) mark that folder as the
  // current location and open it, so the sidebar mirrors the breadcrumb.
  const folderMatch = useMatch("/projects/:projectId/folders/:folderId");
  const activeFolderId = folderMatch?.params.folderId ?? null;

  // Children per parent, sorted once per data change (not per node render).
  // Items whose parent folder isn't in the list (e.g. a limited viewer's
  // partial view) fall back to the root so they stay reachable.
  const index = useMemo(() => {
    const folderIds = new Set(folders.map(f => f.id));
    const parentOf = (id: string | null | undefined) => (id && folderIds.has(id) ? id : null);
    const children = new Map<string | null, Row[]>();
    const push = (parent: string | null, row: Row) => {
      const list = children.get(parent);
      if (list) list.push(row); else children.set(parent, [row]);
    };
    const parentById = new Map<string, string | null>();
    for (const f of [...folders].sort((a, b) => byName(a.name, b.name))) {
      const parent = f.parent_id && f.parent_id !== f.id ? parentOf(f.parent_id) : null;
      parentById.set(f.id, parent);
      push(parent, { kind: "folder", folder: f });
    }
    const sortedDocs = [...docs].sort((a, b) =>
      (b.is_home ?? 0) - (a.is_home ?? 0)
      || (a.sidebar_position ?? Infinity) - (b.sidebar_position ?? Infinity)
      || byName(a.display_title ?? a.title, b.display_title ?? b.title));
    for (const d of sortedDocs) push(parentOf(d.folder_id), { kind: "doc", doc: d });
    for (const f of [...files].sort((a, b) => byName(a.name, b.name))) push(parentOf(f.folder_id), { kind: "file", file: f });
    return { children, parentById };
  }, [docs, folders, files]);

  // Folder chain (nearest first) holding the open doc/file; null while the
  // item itself hasn't loaded yet, [] when it sits at the root.
  const activeAncestors = useMemo((): string[] | null => {
    if (activeFolderId) {
      // The open folder itself plus its parents.
      if (!index.parentById.has(activeFolderId)) return null;
      const chain: string[] = [];
      let cur: string | null = activeFolderId;
      while (cur && index.parentById.has(cur) && !chain.includes(cur)) {
        chain.push(cur);
        cur = index.parentById.get(cur) ?? null;
      }
      return chain;
    }
    const item = activeDocId
      ? docs.find(d => d.id === activeDocId)
      : activeFileId ? files.find(f => f.id === activeFileId) : undefined;
    if (!item) return null;
    const chain: string[] = [];
    let cur = item.folder_id ?? null;
    while (cur && index.parentById.has(cur) && !chain.includes(cur)) {
      chain.push(cur);
      cur = index.parentById.get(cur) ?? null;
    }
    return chain;
  }, [activeDocId, activeFileId, activeFolderId, docs, files, index]);

  const [expanded, setExpanded] = useState<Set<string>>(() => readExpanded(projectId));
  const [levelLimits, setLevelLimits] = useState<Record<string, number>>({});

  // Auto-expand the active item's ancestors once per active item, so a folder
  // the user collapses afterwards stays collapsed across refetches.
  const autoExpandedFor = useRef<string | null>(null);
  useEffect(() => {
    const key = activeDocId ? `doc:${activeDocId}` : activeFileId ? `file:${activeFileId}` : activeFolderId ? `folder:${activeFolderId}` : null;
    if (!key || autoExpandedFor.current === key || activeAncestors === null) return;
    autoExpandedFor.current = key;
    if (activeAncestors.every(id => expanded.has(id))) return;
    const next = new Set(expanded);
    for (const id of activeAncestors) next.add(id);
    setExpanded(next);
    writeExpanded(projectId, next);
  }, [activeDocId, activeFileId, activeFolderId, activeAncestors, expanded, projectId]);

  function toggle(folderId: string) {
    const next = new Set(expanded);
    if (next.has(folderId)) next.delete(folderId); else next.add(folderId);
    setExpanded(next);
    writeExpanded(projectId, next);
  }

  function renderLevel(parentId: string | null) {
    const rows = index.children.get(parentId) ?? [];
    const levelKey = parentId ?? "";
    // Never hide the active row (or the folder leading to it) behind the cap.
    const activeIdx = rows.findIndex(r =>
      (r.kind === "doc" && r.doc.id === activeDocId)
      || (r.kind === "file" && r.file.id === activeFileId)
      || (r.kind === "folder" && !!activeAncestors?.includes(r.folder.id)));
    const limit = Math.max(levelLimits[levelKey] ?? LEVEL_LIMIT, activeIdx + 1);
    const hidden = rows.length - limit;

    return (
      <>
        {rows.slice(0, limit).map(row => {
          if (row.kind === "folder") {
            const { folder } = row;
            const open = expanded.has(folder.id);
            const current = folder.id === activeFolderId;
            const childrenId = `sidebar-tree-${folder.id}`;
            return (
              <div key={`f:${folder.id}`}>
                <button
                  type="button"
                  onClick={() => toggle(folder.id)}
                  aria-expanded={open}
                  aria-controls={open ? childrenId : undefined}
                  aria-current={current ? "location" : undefined}
                  className={cn(buttonVariants({ variant: "ghost", size: "sm" }), ROW_CLASS, rowTone(current))}
                >
                  <ChevronRight aria-hidden className={cn("size-3 -ml-0.5 transition-transform duration-150", open && "rotate-90")} />
                  {open
                    ? <FolderOpen aria-hidden className="size-3.5" />
                    : <Folder aria-hidden className="size-3.5" />}
                  <span className="truncate">{folder.name}</span>
                </button>
                {open && (
                  <div id={childrenId} role="group" className="ml-3 flex flex-col gap-px border-l border-border pl-1">
                    {(index.children.get(folder.id)?.length ?? 0) > 0
                      ? renderLevel(folder.id)
                      : <p className="px-2 py-1 text-xs text-muted-foreground/70">No items</p>}
                  </div>
                )}
              </div>
            );
          }
          if (row.kind === "doc") {
            const { doc } = row;
            const label = doc.display_title || doc.title || "Untitled";
            return (
              <NavLink
                key={`d:${doc.id}`}
                to={`/projects/${projectId}/docs/${doc.id}`}
                title={label}
                className={({ isActive }) => cn(buttonVariants({ variant: "ghost", size: "sm" }), ROW_CLASS, rowTone(isActive))}
              >
                {/* Spacer keeps leaf icons aligned with folder icons (chevron column). */}
                <span aria-hidden className="w-2.5 shrink-0" />
                {doc.is_home === 1
                  ? <House aria-hidden className="size-3.5" />
                  : <FileText aria-hidden className="size-3.5" />}
                <span className="truncate">{label}</span>
              </NavLink>
            );
          }
          const { file } = row;
          return (
            <NavLink
              key={`a:${file.id}`}
              to={`/projects/${projectId}/files/${file.id}`}
              title={file.name}
              className={({ isActive }) => cn(buttonVariants({ variant: "ghost", size: "sm" }), ROW_CLASS, rowTone(isActive))}
            >
              <span aria-hidden className="w-2.5 shrink-0" />
              <FileTypeIcon mimeType={file.mime_type} name={file.name} className="size-3.5 shrink-0" />
              <span className="truncate">{file.name}</span>
            </NavLink>
          );
        })}
        {hidden > 0 && (
          <button
            type="button"
            onClick={() => setLevelLimits(prev => ({ ...prev, [levelKey]: limit + LEVEL_LIMIT }))}
            className={cn(buttonVariants({ variant: "ghost", size: "sm" }), ROW_CLASS, "text-xs text-muted-foreground/80 hover:text-foreground")}
          >
            <span aria-hidden className="w-2.5 shrink-0" />
            Show {Math.min(hidden, LEVEL_LIMIT)} more
          </button>
        )}
      </>
    );
  }

  if (docs.length === 0 && folders.length === 0 && files.length === 0) return null;

  return (
    <div className="mt-4">
      <p className="px-2 pb-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/80">
        Contents
      </p>
      <nav aria-label="Site contents" className="flex flex-col gap-px">
        {renderLevel(null)}
      </nav>
    </div>
  );
}
