import { useState, useEffect, useCallback, useMemo, useRef, lazy, Suspense } from "react";
import { useActiveHeading } from "@/hooks/useActiveHeading";
import { DocOutline } from "@/components/DocOutline";
import { useSwipeGesture } from "@/hooks/useSwipeGesture";
import { fileKind } from "@/lib/fileKind";
import { formatBytes } from "@/lib/fileManager";
import { SearchPalette } from "@/components/SearchPalette";
import { useParams, useNavigate, NavLink, Link, useLocation } from "react-router-dom";
import { parseFrontmatter } from "@/lib/frontmatter";
import { toHeadingId } from "@/lib/headingSlug";
import { useScrollToHeading } from "@/hooks/useScrollToHeading";
import { WysiwygEditor } from "@/components/wysiwyg/WysiwygEditor";
import { DocCoverImage } from "@/components/DocCoverImage";
import { GraphView, type GraphData } from "@/components/GraphView";
import { LinkedDocsPanel } from "@/components/LinkedDocsPanel";
import { NotFound404 } from "./NotFound404";
import { AudioVisualizer } from "@/components/AudioVisualizer";
import { FileTypeIcon } from "@/components/FileTypeIcon";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Spinner } from "@/components/ui/spinner";
import { getToken } from "@/lib/auth";
import { useSiteRoute, siteHref } from "@/lib/siteUrl";
import { cn } from "@/lib/utils";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { ArrowLeft, BookOpen, FileText, Flag, Folder, House, ChevronLeft, ChevronRight, Search, X, Download, Network, Menu, List, PanelLeftOpen } from "lucide-react";
import { ReportSiteDialog } from "@/components/ReportSiteDialog";

// Heavy chunk - only loaded when a published drawing is opened.
const ExcalidrawCanvas = lazy(() => import("@/components/ExcalidrawCanvas"));

interface Heading { level: number; text: string; id: string }

function extractHeadings(content: string): Heading[] {
  const headings: Heading[] = [];
  const lines = content.split("\n");
  let inFrontmatter = false;
  let frontmatterDone = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (i === 0 && line.trimEnd() === "---") { inFrontmatter = true; continue; }
    if (inFrontmatter && !frontmatterDone) {
      if (line.trimEnd() === "---") { inFrontmatter = false; frontmatterDone = true; }
      continue;
    }
    const match = line.match(/^(#{1,6})\s+(.+)$/);
    if (match) {
      const text = match[2].trim();
      headings.push({ level: match[1].length, text, id: toHeadingId(text) });
    }
  }
  return headings;
}

interface NavDoc {
  id: string;
  // Custom URL segment from the doc's `slug:` frontmatter key; null/absent =
  // link by id.
  slug?: string | null;
  title: string;
  display_title?: string | null;
  folder_id: string | null;
  sidebar_position?: number | null;
  is_home?: number;
}

interface NavFolder {
  id: string;
  name: string;
  parent_id: string | null;
}

interface NavFile {
  id: string;
  name: string;
  mime_type: string;
  size: number;
  folder_id: string | null;
  content_stream_url?: string | null;
}

interface PublicData {
  doc: { id: string; slug?: string | null; title: string; display_title: string | null; hide_title: boolean | null; content: string; showHeading: boolean; showLastUpdated: boolean; updatedAt: string };
  sitePublished: boolean;
  // `description` only comes with the site payload (/public/projects/:id).
  project: { id: string; name: string; description?: string | null; vanity_slug: string | null; home_doc_id: string | null; graph_enabled: number; published_graph_enabled: number; logo_square_updated_at: string | null; logo_wide_updated_at: string | null };
  docs: NavDoc[] | null;
  folders: NavFolder[] | null;
  files: NavFile[] | null;
}

/** GET /public/projects/:id - the published site row plus its nav lists. */
type PublicProjectPayload = PublicData["project"] & { docs: NavDoc[]; folders: NavFolder[]; files: NavFile[] };

const EMPTY_DOC: PublicData["doc"] = { id: "", title: "", display_title: null, hide_title: null, content: "", showHeading: false, showLastUpdated: false, updatedAt: "" };

/** Page data for the doc-less views (site index, graph, file) from the site payload. */
function dataFromProject(p: PublicProjectPayload): PublicData {
  return {
    doc: EMPTY_DOC,
    sitePublished: true,
    project: { id: p.id, name: p.name, description: p.description ?? null, vanity_slug: p.vanity_slug, home_doc_id: p.home_doc_id, graph_enabled: p.graph_enabled, published_graph_enabled: p.published_graph_enabled, logo_square_updated_at: p.logo_square_updated_at, logo_wide_updated_at: p.logo_wide_updated_at },
    docs: p.docs ?? [],
    folders: p.folders ?? [],
    files: p.files ?? [],
  };
}

function flattenDocs(folders: NavFolder[], docs: NavDoc[], parentId: string | null = null): NavDoc[] {
  const childFolders = folders.filter(f => f.parent_id === parentId);
  const childDocs = docs.filter(d => d.folder_id === parentId);
  const result: NavDoc[] = [];
  for (const folder of childFolders) {
    result.push(...flattenDocs(folders, docs, folder.id));
  }
  result.push(...childDocs);
  return result;
}

function folderHasItems(folderId: string, folders: NavFolder[], docs: NavDoc[], files: NavFile[]): boolean {
  if (docs.some(d => d.folder_id === folderId)) return true;
  if (files.some(f => f.folder_id === folderId)) return true;
  return folders
    .filter(f => f.parent_id === folderId)
    .some(child => folderHasItems(child.id, folders, docs, files));
}

const HIDDEN_FOLDER_NAMES = ["hidden", "doc_assets"];

/** Folders the public nav shows under `parentId`: not hidden, not empty. */
function visibleChildFolders(parentId: string | null, folders: NavFolder[], docs: NavDoc[], files: NavFile[]): NavFolder[] {
  return folders
    .filter(f => f.parent_id === parentId)
    .filter(f => !HIDDEN_FOLDER_NAMES.includes(f.name.toLowerCase()))
    .filter(f => folderHasItems(f.id, folders, docs, files));
}

/** Files in `folderId` and every folder below it, in nav (tree) order. */
function filesInSubtree(folderId: string, folders: NavFolder[], files: NavFile[]): NavFile[] {
  return [
    ...folders.filter(f => f.parent_id === folderId).flatMap(f => filesInSubtree(f.id, folders, files)),
    ...files.filter(f => f.folder_id === folderId),
  ];
}

const pluralize = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Generated landing page for a published site with no home doc: the site's
 * name and description over its top-level pages, folders and files in sidebar
 * order. A folder links to its first page (or first file when it holds only
 * uploads), since folders have no page of their own.
 */
function SiteIndex({
  name,
  description,
  href,
  folders,
  docs,
  files,
}: {
  name: string;
  description: string | null;
  href: (id: string) => string;
  folders: NavFolder[];
  docs: NavDoc[];
  files: NavFile[];
}) {
  type Row = { key: string; to: string; label: string; meta?: string; icon: React.ReactNode };
  const iconClass = "h-4 w-4 shrink-0 text-muted-foreground";
  const rows: Row[] = [];
  for (const folder of visibleChildFolders(null, folders, docs, files)) {
    const folderDocs = flattenDocs(folders, docs, folder.id);
    const folderFiles = filesInSubtree(folder.id, folders, files);
    const target = folderDocs[0]?.id ?? folderFiles[0]?.id;
    if (!target) continue;
    const meta = [
      folderDocs.length > 0 ? pluralize(folderDocs.length, "page") : null,
      folderFiles.length > 0 ? pluralize(folderFiles.length, "file") : null,
    ].filter(Boolean).join(" · ");
    rows.push({ key: folder.id, to: href(target), label: folder.name, meta, icon: <Folder className={iconClass} aria-hidden /> });
  }
  for (const doc of docs.filter(d => d.folder_id === null)) {
    rows.push({ key: doc.id, to: href(doc.id), label: doc.display_title ?? doc.title, icon: <FileText className={iconClass} aria-hidden /> });
  }
  for (const file of files.filter(f => f.folder_id === null)) {
    rows.push({ key: file.id, to: href(file.id), label: file.name, meta: formatBytes(file.size), icon: <FileTypeIcon mimeType={file.mime_type} name={file.name} className={iconClass} /> });
  }

  return (
    <div>
      <article className="reading-prose prose prose-neutral dark:prose-invert max-w-none">
        <h1>{name}</h1>
        {description?.trim() && <p className="lead text-muted-foreground">{description}</p>}
      </article>
      {rows.length > 0 ? (
        <nav aria-label="Site contents" className="not-prose mt-10">
          <h2 className="mb-3 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/80">Contents</h2>
          <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
            {rows.map(r => (
              <li key={r.key}>
                <Link
                  to={r.to}
                  className="group flex min-h-12 items-center gap-3 px-4 py-3 text-sm transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                >
                  {r.icon}
                  <span className="min-w-0 flex-1 truncate font-medium text-foreground">{r.label}</span>
                  {r.meta && <span className="shrink-0 text-xs text-muted-foreground">{r.meta}</span>}
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/60 transition-colors group-hover:text-muted-foreground" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      ) : (
        <div className="not-prose mt-10 rounded-lg border border-dashed border-border px-6 py-10 text-center">
          <FileText className="mx-auto h-5 w-5 text-muted-foreground" aria-hidden />
          <p className="mt-3 text-sm font-medium">Nothing published here yet</p>
          <p className="mt-1 text-sm text-muted-foreground">Pages will appear here once the site has some.</p>
        </div>
      )}
    </div>
  );
}

// Nested rows sit 8px (ml-2) right of their parent's guide line (the children
// wrapper's border-l), and the elbow connector spans exactly that gap - it
// lives entirely OUTSIDE the row, so an active/hovered row's highlight starts
// after the connector instead of swallowing most of it and leaving a stub.
// When a folder or doc is the last child, we erase the guide below the item's
// midpoint so the vertical line terminates rather than running past the last
// item. The eraser covers exactly the guide's 1px column (inset + border = 9px
// left of the row), so it never notches the row's highlight.
// For folders, the midpoint is top-4 (16px = half of the 32px button row height).
// For docs, it's top-1/2 (50% of the single-row element height).
const NESTED_INSET = "ml-2";
const NESTED_ELBOW = "absolute -left-2 top-1/2 -translate-y-1/2 h-px w-2 bg-border";
const FOLDER_ERASE = "after:content-[''] after:absolute after:left-[-9px] after:top-4 after:bottom-0 after:w-px after:bg-sidebar";
const DOC_ERASE    = "after:content-[''] after:absolute after:left-[-9px] after:top-1/2 after:bottom-0 after:w-px after:bg-sidebar";

function FolderNode({
  folder,
  href,
  folders,
  docs,
  files,
  depth,
  isLast,
  onFileClick,
  onDocClick,
  selectedFileId,
}: {
  folder: NavFolder;
  href: (docId: string) => string;
  folders: NavFolder[];
  docs: NavDoc[];
  files: NavFile[];
  depth: number;
  isLast: boolean;
  onFileClick: (file: NavFile) => void;
  onDocClick: () => void;
  selectedFileId: string | null;
}) {
  const [open, setOpen] = useState(true);
  const childrenId = `folder-children-${folder.id}`;

  return (
    <div className={`relative ${depth > 0 ? NESTED_INSET : ""} ${isLast && depth > 0 ? FOLDER_ERASE : ""}`}>
      <button
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
        aria-controls={childrenId}
        className={`relative w-full flex h-8 items-center gap-1.5 rounded-md text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground ${depth > 0 ? "pl-2 pr-2" : "px-2"}`}
      >
        {depth > 0 && (
          <span aria-hidden className={NESTED_ELBOW} />
        )}
        <ChevronRight className={`h-3 w-3 shrink-0 transition-transform duration-150 ${open ? "rotate-90" : ""}`} />
        <Folder className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate font-medium">{folder.name}</span>
      </button>
      {open && (
        <div id={childrenId} className="ml-3 border-l border-border">
          <NavTree href={href} folders={folders} docs={docs} files={files} parentId={folder.id} depth={depth + 1} onFileClick={onFileClick} onDocClick={onDocClick} selectedFileId={selectedFileId} />
        </div>
      )}
    </div>
  );
}

function NavTree({
  href,
  folders,
  docs,
  files,
  parentId = null,
  depth = 0,
  onFileClick,
  onDocClick,
  selectedFileId,
}: {
  href: (docId: string) => string;
  folders: NavFolder[];
  docs: NavDoc[];
  files: NavFile[];
  parentId?: string | null;
  depth?: number;
  onFileClick: (file: NavFile) => void;
  onDocClick: () => void;
  selectedFileId: string | null;
}) {
  const childFolders = visibleChildFolders(parentId, folders, docs, files);
  const childDocs = docs.filter(d => d.folder_id === parentId);
  const childFiles = files.filter(f => f.folder_id === parentId);
  const hasLeafItems = childDocs.length > 0 || childFiles.length > 0;

  return (
    <>
      {childFolders.map((folder, i) => {
        const isLast = !hasLeafItems && i === childFolders.length - 1;
        return (
          <FolderNode
            key={folder.id}
            folder={folder}
            href={href}
            folders={folders}
            docs={docs}
            files={files}
            depth={depth}
            isLast={isLast}
            onFileClick={onFileClick}
            onDocClick={onDocClick}
            selectedFileId={selectedFileId}
          />
        );
      })}
      {childDocs.map((doc, i) => {
        const isLast = childFiles.length === 0 && i === childDocs.length - 1;
        return (
          <NavLink
            key={doc.id}
            to={href(doc.id)}
            onClick={onDocClick}
            className={({ isActive }) =>
              `relative flex h-8 items-center gap-2 rounded-md text-sm transition-colors hover:bg-accent hover:text-accent-foreground pr-2 ${
                depth > 0 ? `pl-2 ${NESTED_INSET}` : "pl-2"
              } ${isActive && !selectedFileId ? "bg-accent text-accent-foreground font-medium" : "text-foreground/80"} ${isLast && depth > 0 ? DOC_ERASE : ""}`
            }
          >
            {depth > 0 && (
              <span aria-hidden className={NESTED_ELBOW} />
            )}
            {doc.is_home === 1
              ? <House className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              : <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            }
            <span className="truncate">{doc.display_title ?? doc.title}</span>
          </NavLink>
        );
      })}
      {childFiles.map((file, i) => {
        const isLast = i === childFiles.length - 1;
        return (
          <button
            key={file.id}
            onClick={() => onFileClick(file)}
            className={`relative flex h-8 items-center gap-2 rounded-md text-sm transition-colors hover:bg-accent hover:text-accent-foreground pr-2 ${
              depth > 0 ? `pl-2 ${NESTED_INSET} w-[calc(100%-0.5rem)]` : "pl-2 w-full"
            } ${selectedFileId === file.id ? "bg-accent text-accent-foreground font-medium" : "text-foreground/80"} ${isLast && depth > 0 ? DOC_ERASE : ""}`}
          >
            {depth > 0 && (
              <span aria-hidden className={NESTED_ELBOW} />
            )}
            <FileTypeIcon mimeType={file.mime_type} name={file.name} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{file.name}</span>
          </button>
        );
      })}
    </>
  );
}

function PublicFileView({ file, projectId }: { file: NavFile; projectId: string }) {
  const [downloading, setDownloading] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);

  // Video src with a re-sign-on-expiry fallback. The presigned R2 URL baked in
  // at nav-load carries a 3h TTL and a published page can sit open longer, so on
  // the first playback error we re-sign once (stream-url endpoint), then fall
  // back to the in-Worker route. resignTriedRef caps it at one re-sign; the
  // parent renders this with key={file.id} so the state resets per file.
  const workerVideoSrc = `/api/public/files/${file.id}/content?projectId=${projectId}`;
  const [videoSrc, setVideoSrc] = useState(file.content_stream_url ?? workerVideoSrc);
  const resignTriedRef = useRef(false);

  async function handleVideoError() {
    if (videoSrc === workerVideoSrc) return; // already on the Worker fallback
    if (!resignTriedRef.current) {
      resignTriedRef.current = true;
      try {
        const res = await fetch(`/api/public/files/${file.id}/stream-url?projectId=${encodeURIComponent(projectId)}`);
        const json = (await res.json()) as { ok?: boolean; data?: { url?: string | null } };
        const fresh = json?.data?.url;
        if (fresh && fresh !== videoSrc) { setVideoSrc(fresh); return; }
      } catch { /* fall through to the Worker route */ }
    }
    setVideoSrc(workerVideoSrc);
  }

  async function handleDownload() {
    setDownloading(true);
    try {
      const res = await fetch(`/api/public/files/${file.id}/content?projectId=${projectId}`);
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

  return (
    <div className="mx-auto max-w-2xl px-6 py-10">
      <div className="flex items-center gap-4">
        <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl border border-border bg-muted">
          <FileTypeIcon mimeType={file.mime_type} name={file.name} className="h-7 w-7 text-muted-foreground" />
        </div>
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold truncate">{file.name}</h1>
          <p className="text-sm text-muted-foreground mt-0.5">{file.mime_type}</p>
        </div>
      </div>

      <Separator className="my-6" />

      <dl className="grid grid-cols-[auto_1fr] gap-x-8 gap-y-3 text-sm">
        <dt className="text-muted-foreground">Size</dt>
        <dd>{formatBytes(file.size)}</dd>
      </dl>

      {file.mime_type.startsWith("image/") && (
        <div className="mt-8 overflow-hidden rounded-xl border border-border bg-muted/30">
          <img
            src={`/api/public/files/${file.id}/content?projectId=${projectId}`}
            alt={file.name}
            className="max-h-[60vh] w-full object-contain"
          />
        </div>
      )}

      {file.mime_type.startsWith("audio/") && (
        <div className="mt-8 rounded-xl border border-border bg-muted/30 p-4">
          <AudioVisualizer audioRef={audioRef} className="mb-3 h-20 text-primary" />
          <audio ref={audioRef} controls src={`/api/public/files/${file.id}/content?projectId=${projectId}`} className="w-full" />
        </div>
      )}

      {file.mime_type.startsWith("video/") && (
        <div className="mt-8 overflow-hidden rounded-xl border border-border bg-black">
          <video
            controls
            preload="metadata"
            src={videoSrc}
            onError={handleVideoError}
            className="max-h-[70vh] w-full bg-black"
          >
            Your browser does not support embedded video playback.
          </video>
        </div>
      )}

      {file.mime_type === "application/pdf" && (
        <div className="mt-8 overflow-hidden rounded-xl border border-border bg-muted/30">
          <iframe
            src={`/api/public/files/${file.id}/content?projectId=${projectId}`}
            title={file.name}
            referrerPolicy="no-referrer"
            className="h-[75vh] w-full"
          />
        </div>
      )}

      <div className="mt-8">
        <Button onClick={handleDownload} disabled={downloading} className="gap-2">
          <Download className="h-4 w-4" />
          {downloading ? "Downloading…" : "Download"}
        </Button>
      </div>
    </div>
  );
}

export function PublicDocPage() {
  // In host mode (custom domain) the project comes from context and the site
  // lives at clean root URLs; otherwise projectId is the /s/:projectId param.
  const route = useSiteRoute();
  const params = useParams<{ projectId: string; docId: string }>();
  const hostMode = route.hostMode;
  const docId = params.docId;
  const projectId = hostMode ? route.slug : params.projectId;
  const isGraph = docId === "graph";
  const navigate = useNavigate();
  const location = useLocation();
  const [data, setData] = useState<PublicData | null>(null);
  const [graphData, setGraphData] = useState<GraphData | null>(null);
  const [loading, setLoading] = useState(true);
  // True while a doc/graph fetch is in flight on a *swap* (data already present,
  // so the full-page `loading` spinner is skipped). Used to show an inline
  // spinner in the article area instead of flashing the stale empty-doc
  // placeholder when moving from a file/graph view to a doc.
  const [fetching, setFetching] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedFile, setSelectedFile] = useState<NavFile | null>(null);
  // Only signed-in *members* get the back-to-project shortcut; a signed-in
  // visitor who isn't on the site would just hit a 404 in the app.
  const [isMember, setIsMember] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth >= 768);
  const [reportOpen, setReportOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [graphExpanded, setGraphExpanded] = useState(false);
  const openSearch = useCallback(() => { if (data?.sitePublished && projectId) setSearchOpen(true); }, [data?.sitePublished, projectId]);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        openSearch();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openSearch]);

  // Allow dismissing the open mobile sidebar overlay with Escape. Scoped to the
  // mobile breakpoint so it never collapses the persistent desktop sidebar.
  useEffect(() => {
    if (!sidebarOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && window.innerWidth < 768) {
        setSidebarOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sidebarOpen]);

  useSwipeGesture({
    onSwipeLeft: () => setSidebarOpen(false),
    onSwipeRight: () => setSidebarOpen(true),
  });

  // Canonical in-site link builder. Path mode → /s/<slug>/<docId> (slug prefers
  // the vanity slug once loaded); host mode → /<docId> at the domain root.
  // The doc segment prefers the doc's custom frontmatter slug when it has one.
  const linkSlug = data?.project.vanity_slug ?? data?.project.id ?? projectId ?? "";
  const docSlugById = useMemo(() => {
    const m = new Map<string, string>();
    for (const d of data?.docs ?? []) if (d.slug) m.set(d.id, d.slug);
    return m;
  }, [data?.docs]);
  const href = useCallback(
    (id: string, anchor?: string) => siteHref(route, linkSlug, docSlugById.get(id) ?? id, anchor),
    [route, linkSlug, docSlugById],
  );

  // The URL's doc segment may be a custom slug, so identity comparisons (nav
  // highlighting, prev/next, linked docs) must use the loaded doc's real id.
  const currentDocId = data?.doc.id || docId;

  const wysiwygCtx = useMemo(() => ({
    projectId: data?.project.id,
    isPublic: true,
    currentDocId,
    revealOnCursor: false,
    hideFrontmatter: true,
    docs: data?.docs ?? [],
    folders: data?.folders ?? [],
    buildUrl: (id: string, anchor?: string) => href(id, anchor),
  }), [docId, data, href]);

  const memberCheckId = hostMode ? null : data?.project.id ?? null;
  useEffect(() => {
    setIsMember(false);
    const token = getToken();
    if (!token || !memberCheckId) return;
    let cancelled = false;
    // Plain fetch, not apiFetch: a stale token on a public page must not
    // bounce the reader to /login - it just means no back button.
    fetch(`/api/projects/${encodeURIComponent(memberCheckId)}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => { if (!cancelled && r.ok) setIsMember(true); })
      .catch(() => { /* not a member / offline - keep it hidden */ });
    return () => { cancelled = true; };
  }, [memberCheckId]);

  useEffect(() => {
    if (!projectId) return;

    // Site root: a site with a home doc redirects to it; one without gets a
    // generated index page (site name, description, top-level pages) instead
    // of an arbitrary first doc.
    if (!docId) {
      setNotFound(false);
      setSelectedFile(null);
      fetch(`/api/public/projects/${projectId}`)
        .then(r => r.json() as Promise<{ ok: boolean; data?: PublicProjectPayload }>)
        .then(json => {
          const p = json.ok ? json.data : undefined;
          if (!p) {
            setNotFound(true);
            setLoading(false);
            return;
          }
          const homeDoc = p.home_doc_id ? p.docs.find(d => d.id === p.home_doc_id) : null;
          if (homeDoc) {
            const slug = p.vanity_slug ?? projectId;
            const docSeg = homeDoc.slug ?? homeDoc.id;
            navigate(hostMode ? `/${docSeg}` : `/s/${slug}/${docSeg}`, { replace: true });
            return;
          }
          setData(dataFromProject(p));
          setLoading(false);
        })
        .catch(() => { setNotFound(true); setLoading(false); });
      return;
    }

    if (isGraph) {
      if (!data) setLoading(true);
      setFetching(true);
      setNotFound(false);
      setSelectedFile(null);
      Promise.all([
        fetch(`/api/public/projects/${projectId}`).then(r => r.json() as Promise<{ ok: boolean; data?: PublicProjectPayload }>),
        fetch(`/api/public/projects/${projectId}/graph`).then(r => r.json() as Promise<{ ok: boolean; data?: GraphData }>),
      ])
        .then(([projJson, graphJson]) => {
          if (projJson.ok && projJson.data) {
            const p = projJson.data;
            if (p.published_graph_enabled !== 1) {
              setNotFound(true);
              return;
            }
            setData(dataFromProject(p));
          } else {
            setNotFound(true);
          }
          setGraphData(graphJson.ok && graphJson.data ? graphJson.data : { nodes: [], edges: [] });
        })
        .catch(() => setNotFound(true))
        .finally(() => { setLoading(false); setFetching(false); });
      return;
    }

    if (!data) setLoading(true);
    setFetching(true);
    setNotFound(false);
    setSelectedFile(null);
    fetch(`/api/public/docs/${projectId}/${docId}`)
      .then(r => (r.status === 404 ? null : r.json() as Promise<{ ok: boolean; data?: PublicData }>))
      .then(async json => {
        if (json && json.ok && json.data) { setData(json.data); return; }
        // Not a doc - the id may be a published FILE (files/videos/audio/drawings
        // are directly linkable too). Load the site nav and, if it matches a file,
        // show the file view; otherwise it's a genuine 404.
        const projJson = await fetch(`/api/public/projects/${projectId}`)
          .then(r => r.json() as Promise<{ ok: boolean; data?: PublicProjectPayload }>)
          .catch(() => null);
        const p = projJson?.ok ? projJson.data : undefined;
        const file = p?.files?.find(f => f.id === docId);
        if (p && file) {
          setData(dataFromProject(p));
          setSelectedFile(file);
        } else {
          setNotFound(true);
        }
      })
      .catch(() => setNotFound(true))
      .finally(() => { setLoading(false); setFetching(false); });
  }, [projectId, docId, isGraph, navigate]);

  // Canonicalize raw UUIDs to slugs once we know them: the project segment to
  // the vanity slug (path mode only - on a custom domain the project isn't in
  // the URL) and the doc segment to the doc's custom frontmatter slug.
  useEffect(() => {
    if (!data || !docId) return;
    // URL used the doc's id but it has a slug → prefer the slug. Graph/file
    // views load with doc.id = "" and are left alone.
    const docSeg = data.doc.id === docId && data.doc.slug ? data.doc.slug : docId;
    if (hostMode) {
      if (docSeg !== docId) navigate(`/${docSeg}${location.hash}`, { replace: true });
      return;
    }
    const slug = data.project.vanity_slug;
    if ((slug && projectId !== slug) || docSeg !== docId) {
      navigate(`/s/${slug ?? projectId}/${docSeg}${location.hash}`, { replace: true });
    }
  }, [hostMode, data, projectId, docId, navigate, location.hash]);

  // Shared scroll-to-heading helper used by both the URL-hash effect below and
  // the outline buttons. See useScrollToHeading for why this resolves the
  // heading's line position from the markdown source instead of the DOM.
  const scrollToHash = useScrollToHeading(data?.doc.content);
  const activeHeadingId = useActiveHeading(
    data?.doc.content,
    data?.doc.content ? extractHeadings(data.doc.content).map(h => h.id) : [],
  );

  // Scroll to #heading anchor when one is present in the URL.
  useEffect(() => {
    if (!data || isGraph) return;
    const raw = location.hash.slice(1);
    if (!raw) return;
    let hash: string;
    try { hash = decodeURIComponent(raw); } catch { hash = raw; }
    scrollToHash(hash);
  }, [data, docId, isGraph, location.hash, scrollToHash]);

  // Fetch graph once when viewing a doc on a project with the published graph enabled
  useEffect(() => {
    if (isGraph) return;
    if (!projectId) return;
    if (!data || data.project.published_graph_enabled !== 1) return;
    if (graphData) return;
    fetch(`/api/public/projects/${projectId}/graph`)
      .then(r => r.json() as Promise<{ ok: boolean; data?: GraphData }>)
      .then(json => { if (json.ok && json.data) setGraphData(json.data); })
      .catch(() => { /* non-fatal */ });
  }, [isGraph, projectId, data, graphData]);

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center gap-2 text-sm text-muted-foreground">
        <Spinner /> Loading…
      </div>
    );
  }

  if (notFound || !data) {
    return (
      <NotFound404
        subtitle="No published document exists at this location. The document may be unpublished, moved, or the link mistyped."
        primaryLabel="Go home"
        primaryHref="/"
        secondary={{ label: "Report a broken link", href: "mailto:cubity@cubityfir.st?subject=Annex%20Broken%20Link" }}
      />
    );
  }

  const headings = extractHeadings(data.doc.content);
  const showNav = data.sitePublished && data.docs && (data.docs.length > 0 || (data.files && data.files.length > 0));

  // Desktop top bar breadcrumb: site name (links to the home doc, or the
  // generated site index when there is none) › current page.
  const homeDocId = data.docs?.find(d => d.is_home === 1)?.id ?? null;
  const currentNavDoc = data.docs?.find(d => d.id === data.doc.id);
  const pageTitle = isGraph
    ? "Graph"
    : selectedFile
      ? selectedFile.name
      : (currentNavDoc?.display_title ?? currentNavDoc?.title ?? data.doc.display_title ?? data.doc.title) || null;
  const searchShortcut = /Mac|iPhone|iPad|iPod/.test(navigator.userAgent) ? "⌘K" : "Ctrl+K";
  // Folder ancestry of the current page (outermost first) so the breadcrumb
  // mirrors the sidebar tree: Site › Guides › Editor tour.
  const crumbFolders: NavFolder[] = (() => {
    if (isGraph) return [];
    const startId = selectedFile ? selectedFile.folder_id : currentNavDoc?.folder_id ?? null;
    const byId = new Map((data.folders ?? []).map(f => [f.id, f]));
    const chain: NavFolder[] = [];
    let cur = startId ? byId.get(startId) : undefined;
    while (cur && chain.length < 8) {
      chain.unshift(cur);
      cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
    }
    return chain;
  })();

  // Bare site root (no home doc - one with a home doc redirected to it).
  const isSiteIndex = !docId;

  const publishedWithAnnex = (
    <footer className="not-prose mt-16 border-t border-border pt-6 text-xs text-muted-foreground">
      {hostMode ? (
        <a
          href="https://docs.cubityfir.st/"
          target="_blank"
          rel="noopener noreferrer"
          className="transition-colors hover:text-foreground"
        >
          Published with Annex
        </a>
      ) : (
        <Link to="/" className="transition-colors hover:text-foreground">
          Published with Annex
        </Link>
      )}
    </footer>
  );

  const filteredDocs = searchQuery.trim()
    ? (data.docs ?? []).filter(d => (d.display_title ?? d.title).toLowerCase().includes(searchQuery.toLowerCase()))
    : null;

  return (
    <div className="flex h-screen bg-background text-foreground">
      {/* Mobile sidebar backdrop */}
      {showNav && sidebarOpen && (
        <div className="fixed inset-0 z-30 bg-black/20 md:hidden" onClick={() => setSidebarOpen(false)} aria-hidden="true" />
      )}
      {/* Sidebar - only shown when the entire site is published */}
      {showNav && (
        <div className={cn(
          "group/sidebar fixed inset-y-0 left-0 z-40 transition-transform duration-200",
          "md:relative md:inset-auto md:z-auto md:transition-none md:shrink-0",
          sidebarOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"
        )}>
        <aside className={cn("flex h-full flex-col border-r border-border bg-sidebar overflow-hidden w-64 md:transition-[width] md:duration-200", !sidebarOpen && "md:w-0")}>
          <div className="flex h-14 shrink-0 items-center gap-2 px-4">
            {data.project.logo_wide_updated_at ? (
              <img
                src={`/api/public/projects/${data.project.vanity_slug ?? data.project.id}/logo/wide?v=${encodeURIComponent(data.project.logo_wide_updated_at)}`}
                alt={data.project.name}
                title={data.project.name}
                className="h-12 w-auto max-w-[12rem] object-contain"
              />
            ) : data.project.logo_square_updated_at ? (
              <>
                <img
                  src={`/api/public/projects/${data.project.vanity_slug ?? data.project.id}/logo/square?v=${encodeURIComponent(data.project.logo_square_updated_at)}`}
                  alt=""
                  className="h-10 w-10 shrink-0 rounded object-cover"
                />
                <span className="text-lg font-semibold tracking-tight">{data.project.name}</span>
              </>
            ) : (
              <>
                <BookOpen className="h-6 w-6 text-primary" />
                <span className="text-lg font-semibold tracking-tight">{data.project.name}</span>
              </>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="ml-auto h-10 w-10 shrink-0 md:hidden"
              aria-label="Close navigation"
              onClick={() => setSidebarOpen(false)}
            >
              <X className="h-5 w-5" />
            </Button>
          </div>
          <Separator />
          <div className="flex items-center gap-2 px-3 pt-3 pb-2">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
              <Input
                aria-label="Filter titles"
                placeholder="Filter pages…"
                title={
                  typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches
                    ? undefined
                    : `Press ${searchShortcut} for full-text search`
                }
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                className="pl-8 pr-7 h-9 text-base md:h-8 md:text-sm"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery("")}
                  aria-label="Clear filter"
                  className="absolute right-1 top-1/2 -translate-y-1/2 h-6 w-6 flex items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
                >
                  <X className="h-3 w-3" aria-hidden />
                </button>
              )}
            </div>
            {data.project.published_graph_enabled === 1 && (
              <NavLink
                to={href("graph")}
                title="Graph"
                className={({ isActive }) =>
                  `shrink-0 flex items-center justify-center rounded-md h-8 w-8 transition-colors hover:bg-accent hover:text-accent-foreground ${
                    isActive ? "bg-accent text-accent-foreground" : "text-muted-foreground"
                  }`
                }
              >
                <Network className="h-3.5 w-3.5" />
              </NavLink>
            )}
          </div>
          <ScrollArea className="flex-1 px-2 pb-2">
            <nav className="flex flex-col gap-0.5">
              {filteredDocs !== null ? (
                filteredDocs.length === 0 ? (
                  <p className="px-2 py-4 text-center text-xs text-muted-foreground">No results</p>
                ) : (
                  filteredDocs.map(doc => (
                    <NavLink
                      key={doc.id}
                      to={href(doc.id)}
                      onClick={() => setSelectedFile(null)}
                      className={({ isActive }) =>
                        `flex h-8 items-center gap-2 rounded-md px-2 text-sm transition-colors hover:bg-accent hover:text-accent-foreground ${
                          isActive ? "bg-accent text-accent-foreground font-medium" : "text-foreground/80"
                        }`
                      }
                    >
                      {doc.is_home === 1
                        ? <House className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        : <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      }
                      <span className="truncate">{doc.display_title ?? doc.title}</span>
                    </NavLink>
                  ))
                )
              ) : (() => {
                const homeDoc = data.docs!.find(d => d.is_home === 1);
                const restDocs = homeDoc ? data.docs!.filter(d => d.id !== homeDoc.id) : data.docs!;
                return (
                  <>
                    {homeDoc && (
                      <NavLink
                        to={href(homeDoc.id)}
                        onClick={() => setSelectedFile(null)}
                        className={({ isActive }) =>
                          `flex h-8 items-center gap-2 rounded-md px-2 text-sm transition-colors hover:bg-accent hover:text-accent-foreground ${
                            isActive ? "bg-accent text-accent-foreground font-medium" : "text-foreground/80"
                          }`
                        }
                      >
                        <House className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span className="truncate">{homeDoc.display_title ?? homeDoc.title}</span>
                      </NavLink>
                    )}
                    <NavTree
                      href={href}
                      folders={data.folders ?? []}
                      docs={restDocs}
                      files={data.files ?? []}
                      onFileClick={(file) => navigate(href(file.id))}
                      onDocClick={() => setSelectedFile(null)}
                      selectedFileId={selectedFile?.id ?? null}
                    />
                  </>
                );
              })()}
            </nav>
          </ScrollArea>
          <div className="flex flex-col gap-0.5 border-t border-border px-3 py-2">
            {/* Signed-in members only (isMember is never set for visitors):
                back to this site in the app, labelled so it doesn't read as
                browser-style "back". */}
            {isMember && (
              <Button asChild variant="ghost" size="sm" className="w-full justify-start gap-2 text-muted-foreground hover:text-foreground">
                <Link to={`/projects/${data.project.id}`}>
                  <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
                  Back to app
                </Link>
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-start gap-2 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              onClick={() => setReportOpen(true)}
            >
              <Flag className="h-3.5 w-3.5" />
              Report this site
            </Button>
          </div>
        </aside>
        <button
          onClick={() => setSidebarOpen(v => !v)}
          aria-label={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
          className={cn(
            "absolute top-1/2 -translate-y-1/2 -right-3 z-10 hidden md:flex h-10 w-3 items-center justify-center rounded-r-full border border-l-0 border-border bg-sidebar text-muted-foreground hover:bg-accent hover:text-foreground transition-[color,background-color,opacity] after:absolute after:content-[''] after:inset-y-0 after:-left-3 after:right-0",
            // Only shown on sidebar hover/focus while open (as in the app).
            sidebarOpen && "md:opacity-0 md:group-hover/sidebar:opacity-100 md:hover:opacity-100 md:focus-visible:opacity-100",
          )}
        >
          <ChevronLeft className={cn("h-2.5 w-2.5 transition-transform duration-200", !sidebarOpen && "rotate-180")} />
        </button>
        <ReportSiteDialog
          projectIdOrSlug={data.project.vanity_slug ?? data.project.id}
          siteName={data.project.name}
          docId={data.doc?.id ?? null}
          open={reportOpen}
          onOpenChange={setReportOpen}
        />
        </div>
      )}

      {/* Main content - stays put; the sidebar overlays it on mobile instead of pushing it */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {showNav && (
          <header className="flex md:hidden h-14 shrink-0 items-center gap-2 border-b border-border px-4">
            <Button
              variant="ghost"
              size="icon"
              className="h-10 w-10"
              aria-label="Open navigation"
              onClick={() => setSidebarOpen(true)}
            >
              <Menu className="h-5 w-5" />
            </Button>
            {data.project.logo_wide_updated_at ? (
              <img
                src={`/api/public/projects/${data.project.vanity_slug ?? data.project.id}/logo/wide?v=${encodeURIComponent(data.project.logo_wide_updated_at)}`}
                alt={data.project.name}
                title={data.project.name}
                className="h-8 w-auto max-w-[10rem] object-contain"
              />
            ) : data.project.logo_square_updated_at ? (
              <>
                <img
                  src={`/api/public/projects/${data.project.vanity_slug ?? data.project.id}/logo/square?v=${encodeURIComponent(data.project.logo_square_updated_at)}`}
                  alt=""
                  className="h-5 w-5 shrink-0 rounded object-cover"
                />
                <span className="text-sm font-semibold text-foreground truncate">{data.project.name}</span>
              </>
            ) : (
              <>
                <BookOpen className="h-4 w-4 text-primary shrink-0" />
                <span className="text-sm font-semibold text-foreground truncate">{data.project.name}</span>
              </>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="h-10 w-10 ml-auto"
              aria-label="Search"
              onClick={openSearch}
            >
              <Search className="h-5 w-5" />
            </Button>
            {headings.length > 0 && (
              <Button
                variant="ghost"
                size="icon"
                className="h-10 w-10 lg:hidden"
                aria-label="Outline"
                onClick={() => setSheetOpen(true)}
              >
                <List className="h-5 w-5" />
              </Button>
            )}
          </header>
        )}
        {showNav && (
          // Desktop top bar. Same 56px height and 24px inset as the app's top
          // bar; box-content h-14 + border-b puts its rule level with the
          // sidebar header's Separator.
          <header className="hidden md:flex box-content h-14 shrink-0 items-center gap-2 border-b border-border px-6">
            {!sidebarOpen && (
              <Button
                variant="ghost"
                size="icon"
                className="-ml-1 h-8 w-8"
                aria-label="Expand sidebar"
                title="Expand sidebar"
                onClick={() => setSidebarOpen(true)}
              >
                <PanelLeftOpen className="h-4 w-4" />
              </Button>
            )}
            <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-sm">
              {pageTitle ? (
                <Link
                  to={homeDocId ? href(homeDocId) : hostMode ? "/" : `/s/${linkSlug}`}
                  onClick={() => setSelectedFile(null)}
                  className="shrink-0 truncate text-muted-foreground transition-colors hover:text-foreground"
                >
                  {data.project.name}
                </Link>
              ) : (
                <span className={cn("truncate", pageTitle ? "shrink-0 text-muted-foreground" : "font-medium text-foreground")}>
                  {data.project.name}
                </span>
              )}
              {pageTitle && crumbFolders.map(f => (
                <span key={f.id} className="flex min-w-0 shrink items-center gap-1.5">
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" aria-hidden />
                  <span className="truncate text-muted-foreground">{f.name}</span>
                </span>
              ))}
              {pageTitle && (
                <>
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" aria-hidden />
                  <span aria-current="page" className="truncate font-medium text-foreground">{pageTitle}</span>
                </>
              )}
            </nav>
            <Button
              variant="outline"
              size="sm"
              className="ml-auto h-8 shrink-0 gap-2 pr-1.5 text-muted-foreground hover:text-foreground"
              onClick={openSearch}
            >
              <Search className="h-3.5 w-3.5" aria-hidden />
              Search
              <Kbd className="ml-2 text-muted-foreground">{searchShortcut}</Kbd>
            </Button>
          </header>
        )}
        {!showNav && (
          <header className="flex h-14 shrink-0 items-center border-b border-border px-6 gap-2">
            {data.project.logo_wide_updated_at ? (
              <img
                src={`/api/public/projects/${data.project.vanity_slug ?? data.project.id}/logo/wide?v=${encodeURIComponent(data.project.logo_wide_updated_at)}`}
                alt={data.project.name}
                title={data.project.name}
                className="h-8 w-auto max-w-[12rem] object-contain"
              />
            ) : data.project.logo_square_updated_at ? (
              <>
                <img
                  src={`/api/public/projects/${data.project.vanity_slug ?? data.project.id}/logo/square?v=${encodeURIComponent(data.project.logo_square_updated_at)}`}
                  alt=""
                  className="h-5 w-5 shrink-0 rounded object-cover"
                />
                <h1 className="text-sm font-semibold text-foreground truncate">{data.project.name}</h1>
              </>
            ) : (
              <>
                <BookOpen className="h-4 w-4 text-primary shrink-0" />
                <h1 className="text-sm font-semibold text-foreground truncate">{data.project.name}</h1>
              </>
            )}
          </header>
        )}
        {isGraph ? (
          <div className="flex-1 min-h-0">
            {graphData && graphData.nodes.length > 0 ? (
              <GraphView
                showControls
                data={graphData}
                onNodeClick={id => navigate(href(id))}
              />
            ) : (
              <div className="flex h-full items-center justify-center">
                <p className="text-sm text-muted-foreground">
                  {graphData ? "No documents to graph yet." : "Loading graph…"}
                </p>
              </div>
            )}
          </div>
        ) : selectedFile && fileKind(selectedFile.mime_type, selectedFile.name) === "drawing" ? (
          // Drawings fill the entire right pane (full-bleed, not boxed) - a live
          // read-only canvas the visitor can pan/zoom.
          <div className="flex-1 min-h-0">
            <Suspense fallback={<div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground"><Spinner /> Loading drawing…</div>}>
              <ExcalidrawCanvas
                contentUrl={`/api/public/files/${selectedFile.id}/content?projectId=${projectId ?? ""}`}
                fetcher={(u, init) => fetch(u, init)}
                readOnly
                name={selectedFile.name}
                theme={typeof document !== "undefined" && document.documentElement.classList.contains("dark") ? "dark" : "light"}
              />
            </Suspense>
          </div>
        ) : (
        // Thin, low-contrast reading scrollbar (the Radix bar replaces the native
        // one): a border-toned thumb, shown only while the reader hovers or
        // scrolls the page (type="hover"), firming up under the pointer.
        <ScrollArea
          type="hover"
          scrollHideDelay={400}
          className="flex-1 public-doc-scroller [&>[data-orientation=vertical]]:w-2 [&>[data-orientation=vertical]>div]:bg-border [&>[data-orientation=vertical]>div:hover]:bg-muted-foreground/40"
        >
          {selectedFile ? (
            <PublicFileView key={selectedFile.id} file={selectedFile} projectId={projectId ?? ""} />
          ) : isSiteIndex ? (
            // Same column + empty rail as a doc page, so the index and docs
            // share one left edge.
            <div className="flex min-h-full">
            <div className="flex-1 min-w-0 px-4 pt-6 pb-24 sm:px-6 md:pt-12">
              <div className="mx-auto max-w-[44rem]">
                <SiteIndex
                  name={data.project.name}
                  description={data.project.description ?? null}
                  href={href}
                  folders={data.folders ?? []}
                  docs={data.docs ?? []}
                  files={data.files ?? []}
                />
                {publishedWithAnnex}
              </div>
            </div>
            <div className="hidden w-56 shrink-0 xl:block" aria-hidden="true" />
            </div>
          ) : (
            <div className="flex min-h-full">
              {/* Article */}
              <div className="flex-1 min-w-0 px-4 pt-6 pb-24 sm:px-6 md:pt-12">
                {(() => {
                  const cover = parseFrontmatter(data.doc.content).cover;
                  return cover ? <DocCoverImage src={cover} projectId={projectId ?? ""} isPublic /> : null;
                })()}
                <div className="mx-auto max-w-[44rem]">
                  <article className="reading-prose prose prose-neutral dark:prose-invert max-w-none">
                    {(() => {
                      const fm = parseFrontmatter(data.doc.content);
                      const showHeading = fm.hide_title !== undefined ? !fm.hide_title : data.doc.showHeading;
                      const headingTitle = fm.title ?? data.doc.title;
                      return showHeading && <h1 className="text-balance">{headingTitle}</h1>;
                    })()}
                    {data.doc.showLastUpdated && (
                      <p className="not-prose -mt-2 mb-1 text-[13px] text-muted-foreground sm:mb-3 sm:text-sm">
                        Last updated {new Date(data.doc.updatedAt).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })}
                      </p>
                    )}
                    {data.doc.content.trim() ? (
                      <div className={cn(
                        "not-prose",
                        "max-sm:[&_.cm-line.cm-h1]:!pt-[0.2em]",
                        "max-sm:[&_.cm-line:is(.cm-h1,.cm-h2,.cm-h3)+.cm-line:has(>br:only-child)]:!h-[0.5em]",
                      )}>
                        <WysiwygEditor
                          mode="reading"
                          value={data.doc.content}
                          rendererCtx={wysiwygCtx}
                        />
                      </div>
                    ) : fetching ? (
                      <div className="not-prose flex justify-center py-10 text-muted-foreground">
                        <Spinner />
                      </div>
                    ) : (
                      <p className="not-prose text-sm italic text-muted-foreground">
                        This page has no content yet.
                      </p>
                    )}
                  </article>

                  {(() => {
                    if (!data.docs || data.docs.length < 2) return null;
                    const homeDoc = data.docs.find(d => d.is_home === 1);
                    const restDocs = homeDoc ? data.docs.filter(d => d.id !== homeDoc.id) : data.docs;
                    const orderedDocs: NavDoc[] = [
                      ...(homeDoc ? [homeDoc] : []),
                      ...flattenDocs(data.folders ?? [], restDocs),
                    ];
                    const idx = orderedDocs.findIndex(d => d.id === currentDocId);
                    if (idx === -1) return null;
                    const prevDoc = idx > 0 ? orderedDocs[idx - 1] : null;
                    const nextDoc = idx < orderedDocs.length - 1 ? orderedDocs[idx + 1] : null;
                    return (
                      <div className="not-prose mt-12 flex justify-between gap-4">
                        {prevDoc ? (
                          <button
                            onClick={() => navigate(href(prevDoc.id))}
                            className="group flex flex-col gap-0.5 rounded-lg border border-border bg-card p-4 text-left transition-colors hover:bg-accent w-[calc(50%-8px)]"
                          >
                            <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                              <ChevronLeft className="h-3.5 w-3.5" /> Previous
                            </span>
                            <span className="text-sm font-medium text-foreground truncate">{prevDoc.display_title ?? prevDoc.title}</span>
                          </button>
                        ) : <div />}
                        {nextDoc ? (
                          <button
                            onClick={() => navigate(href(nextDoc.id))}
                            className="group flex flex-col gap-0.5 rounded-lg border border-border bg-card p-4 text-right transition-colors hover:bg-accent w-[calc(50%-8px)] items-end ml-auto"
                          >
                            <span className="flex items-center justify-end gap-1.5 text-xs font-medium text-muted-foreground">
                              Next <ChevronRight className="h-3.5 w-3.5" />
                            </span>
                            <span className="text-sm font-medium text-foreground truncate">{nextDoc.display_title ?? nextDoc.title}</span>
                          </button>
                        ) : <div />}
                      </div>
                    );
                  })()}

                  {publishedWithAnnex}
                </div>
              </div>

              {/* Right rail: linked-docs preview + outline */}
              {(() => {
                const showLinkedDocs = data.project.published_graph_enabled === 1 && !!currentDocId && !!graphData;
                if (!showLinkedDocs && headings.length === 0) return null;
                return (
                  <aside className="hidden xl:block w-56 shrink-0 pt-12 pb-10 pl-4 pr-6">
                    <div className="sticky top-8">
                      {showLinkedDocs && currentDocId && graphData && (
                        <LinkedDocsPanel
                          data={graphData}
                          currentDocId={currentDocId}
                          onExpand={() => setGraphExpanded(true)}
                          onNodeClick={id => navigate(href(id))}
                        />
                      )}
                      {headings.length > 0 && (
                        <>
                          <p className="mb-3 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/80">
                            Outline
                          </p>
                          {/* pr-3 keeps the hover scrollbar (absolute, right edge) off the entries */}
                          <ScrollArea className="max-h-[calc(100vh-8rem)] pr-3">
                            <DocOutline
                              headings={headings}
                              activeId={activeHeadingId}
                              onSelect={id => {
                                try { window.history.replaceState(null, "", `#${id}`); } catch { /* */ }
                                scrollToHash(id);
                              }}
                            />
                          </ScrollArea>
                        </>
                      )}
                    </div>
                  </aside>
                );
              })()}
            </div>
          )}
        </ScrollArea>
        )}
      </div>
      {data?.sitePublished && projectId && (
        <SearchPalette
          open={searchOpen}
          onOpenChange={setSearchOpen}
          projectId={projectId}
          isPublic
        />
      )}
      {headings.length > 0 && (
        <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
          <SheetContent side="bottom" className="lg:hidden max-h-[70vh] p-0">
            <SheetTitle className="px-4 pt-5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/80">
              Outline
            </SheetTitle>
            <ScrollArea className="max-h-[calc(70vh-3rem)] pl-4 pr-3 pb-6">
              <DocOutline
                headings={headings}
                activeId={activeHeadingId}
                className="[&>button]:min-h-10 [&>button]:text-sm"
                onSelect={id => {
                  try { window.history.replaceState(null, "", `#${id}`); } catch { /* */ }
                  scrollToHash(id);
                  setSheetOpen(false);
                }}
              />
            </ScrollArea>
          </SheetContent>
        </Sheet>
      )}
      <Dialog open={graphExpanded} onOpenChange={setGraphExpanded}>
        <DialogContent className="max-w-[90vw] w-[90vw] h-[85vh] p-0 overflow-hidden">
          <DialogTitle className="sr-only">Document graph</DialogTitle>
          <div className="h-full w-full">
            {graphData && data && graphData.nodes.length > 0 && (
              <GraphView
                showControls
                data={graphData}
                onNodeClick={id => {
                  setGraphExpanded(false);
                  navigate(href(id));
                }}
              />
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
