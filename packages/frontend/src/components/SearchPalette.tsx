import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandItem,
  CommandGroup,
} from "@/components/ui/command";
import { Kbd } from "@/components/ui/kbd";
import { getToken } from "@/lib/auth";
import { apiFetchJson } from "@/lib/apiFetch";
import { useSiteRoute, siteHref } from "@/lib/siteUrl";
import { readRecentItems, type RecentItem } from "@/lib/recentDocs";
import { FileText, Hash, Loader2, Folder, Image, Music, FileCode, FileArchive, File, Clock, Plus, Users, SlidersHorizontal, House, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface DocHit {
  doc_id: string;
  title: string;
  excerpt?: string;
  tags?: string[];
  folder: string | null;
  updated_at: string;
}

interface FileHit {
  file_id: string;
  name: string;
  mime_type: string;
  folder: string | null;
  updated_at: string;
}

interface FolderHit {
  folder_id: string;
  name: string;
  parent: string | null;
}

interface QuickAction {
  id: string;
  label: string;
  icon: LucideIcon;
  /** Extra match terms beyond the label, so e.g. "invite" finds Members. */
  keywords: string;
  run: () => void | Promise<void>;
}

function timeAgo(ms: number): string {
  const seconds = Math.floor((Date.now() - ms) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

const MARK_CLASS = "bg-yellow-200/80 dark:bg-yellow-700/50 text-foreground rounded-[2px] px-px not-italic";

/** Highlights every query word inside plain text (used for titles/filenames). */
function HighlightedText({ text, term }: { text: string; term: string }) {
  const words = term.trim().split(/\s+/).filter(Boolean)
    .map(w => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!words.length) return <>{text}</>;
  const pattern = new RegExp(`(${words.join("|")})`, "gi");
  const probe = new RegExp(`^(${words.join("|")})$`, "i");
  return (
    <>
      {text.split(pattern).map((part, i) =>
        probe.test(part) ? <mark key={i} className={MARK_CLASS}>{part}</mark> : part,
      )}
    </>
  );
}

function SearchSnippet({ html }: { html: string }) {
  const parts = html.split(/(<mark>[\s\S]*?<\/mark>)/g);
  return (
    <span className="text-xs text-muted-foreground line-clamp-2">
      {parts.map((part, i) =>
        part.startsWith("<mark>") ? (
          <mark key={i} className={MARK_CLASS}>{part.slice(6, -7)}</mark>
        ) : (
          part
        ),
      )}
    </span>
  );
}

function TagChips({ tags, highlight }: { tags: string[]; highlight?: string }) {
  return (
    <span className="flex flex-nowrap gap-1 shrink-0">
      {tags.map(tag => {
        const isMatch = highlight && tag.toLowerCase().includes(highlight.toLowerCase());
        return (
          <span
            key={tag}
            className={cn(
              "inline-flex items-center gap-0.5 text-[10px] px-1.5 py-px rounded-full border",
              isMatch
                ? "bg-primary/10 text-primary border-primary/30 font-medium"
                : "text-muted-foreground border-border",
            )}
          >
            <Hash className="h-2.5 w-2.5" />
            {tag}
          </span>
        );
      })}
    </span>
  );
}

function FileKindIcon({ mime, className }: { mime: string; className?: string }) {
  if (mime.startsWith("image/")) return <Image className={className} />;
  if (mime.startsWith("audio/")) return <Music className={className} />;
  if (mime === "application/pdf") return <FileText className={className} />;
  if (mime === "application/json" || mime.startsWith("text/")) return <FileCode className={className} />;
  if (mime.includes("zip") || mime.includes("tar") || mime.includes("gzip") || mime.includes("archive")) return <FileArchive className={className} />;
  return <File className={className} />;
}

/** Right-aligned "folder · 2d ago" context shown on every hit row. */
function HitMeta({ folder, updatedAt }: { folder: string | null; updatedAt?: string }) {
  if (!folder && !updatedAt) return null;
  return (
    <span className="ml-auto flex items-center gap-1 shrink-0 text-[10px] text-muted-foreground whitespace-nowrap">
      {folder && (
        <span className="flex items-center gap-0.5 max-w-28 truncate">
          <Folder className="h-2.5 w-2.5 shrink-0" />
          {folder}
        </span>
      )}
      {folder && updatedAt && <span aria-hidden="true">·</span>}
      {updatedAt && <span>{timeAgo(new Date(updatedAt).getTime())}</span>}
    </span>
  );
}

interface SearchPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  isPublic?: boolean;
  /** Caller's effective role on the site; gates the quick actions. */
  role?: string | null;
}

export function SearchPalette({ open, onOpenChange, projectId, isPublic = false, role = null }: SearchPaletteProps) {
  const [query, setQuery] = useState("");
  const [docs, setDocs] = useState<DocHit[]>([]);
  const [files, setFiles] = useState<FileHit[]>([]);
  const [folders, setFolders] = useState<FolderHit[]>([]);
  const [recent, setRecent] = useState<RecentItem[]>([]);
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const navigate = useNavigate();
  const route = useSiteRoute();

  const tagMode = query.startsWith("#");
  const searchTerm = tagMode ? query.slice(1) : query;
  const resultCount = docs.length + files.length + folders.length;

  const search = useCallback(
    async (q: string) => {
      const isTag = q.startsWith("#");
      const term = isTag ? q.slice(1) : q;
      if (!term.trim()) { setDocs([]); setFiles([]); setFolders([]); setLoading(false); return; }
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      const param = isTag
        ? `tag=${encodeURIComponent(term)}`
        : `q=${encodeURIComponent(term)}`;
      const url = isPublic
        ? `/api/public/search?projectId=${encodeURIComponent(projectId)}&${param}`
        : `/api/search?projectId=${encodeURIComponent(projectId)}&${param}`;
      const headers: HeadersInit = {};
      if (!isPublic) {
        const token = getToken();
        if (token) headers["Authorization"] = `Bearer ${token}`;
      }
      try {
        const res = await fetch(url, { headers, signal: ctrl.signal });
        const json = await res.json() as { ok: boolean; data?: { docs: DocHit[]; files?: FileHit[]; folders?: FolderHit[] } };
        if (ctrl.signal.aborted) return;
        if (json.ok && json.data) {
          setDocs(json.data.docs ?? []);
          setFiles(json.data.files ?? []);
          setFolders(json.data.folders ?? []);
        } else {
          setDocs([]); setFiles([]); setFolders([]);
        }
        setLoading(false);
      } catch {
        if (ctrl.signal.aborted) return;
        setDocs([]); setFiles([]); setFolders([]); setLoading(false);
      }
    },
    [projectId, isPublic],
  );

  useEffect(() => {
    if (!open) {
      abortRef.current?.abort();
      setQuery(""); setDocs([]); setFiles([]); setFolders([]); setLoading(false);
      return;
    }
    setRecent(isPublic ? [] : readRecentItems(projectId));
  }, [open, isPublic, projectId]);

  useEffect(() => {
    if (!open) return;
    if (!searchTerm.trim()) {
      abortRef.current?.abort();
      setDocs([]); setFiles([]); setFolders([]); setLoading(false);
      return;
    }
    // Stale results stay on screen while the next query is in flight - the
    // footer spinner is the only loading signal, so the list never flickers.
    setLoading(true);
    const timer = setTimeout(() => { search(query); }, 250);
    return () => clearTimeout(timer);
  }, [query, open, search, searchTerm]);

  function close() {
    onOpenChange(false);
  }

  function openDoc(docId: string) {
    close();
    if (isPublic) {
      // Host mode (custom domain) → clean root URL; otherwise /s/<slug>/<docId>.
      navigate(siteHref(route, projectId, docId));
    } else {
      navigate(`/projects/${projectId}/docs/${docId}`);
    }
  }

  function openFile(fileId: string) {
    close();
    navigate(`/projects/${projectId}/files/${fileId}`);
  }

  function openFolder(folderId: string) {
    close();
    navigate(`/projects/${projectId}/folders/${folderId}`);
  }

  function openRecent(item: RecentItem) {
    if (item.kind === "doc") openDoc(item.id);
    else openFile(item.id);
  }

  async function createDoc() {
    const result = await apiFetchJson<{ id: string }>("/api/docs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Untitled", content: "", projectId, folderId: null }),
    });
    if (result.ok && result.data) {
      close();
      navigate(`/projects/${projectId}/docs/${result.data.id}`, { state: { isNew: true } });
    }
  }

  function toggleTagMode() {
    setQuery(tagMode ? searchTerm : "#" + query);
  }

  const canEdit = role === "owner" || role === "admin" || role === "editor";
  const isAdmin = role === "owner" || role === "admin";
  const actions: QuickAction[] = isPublic ? [] : [
    ...(canEdit ? [{ id: "new-doc", label: "New document", icon: Plus, keywords: "create write page", run: createDoc }] : []),
    { id: "file-manager", label: "File Manager", icon: FileText, keywords: "files folders browse uploads", run: () => { close(); navigate(`/projects/${projectId}`); } },
    ...(isAdmin ? [{ id: "members", label: "Members", icon: Users, keywords: "invite people team roles", run: () => { close(); navigate(`/projects/${projectId}/settings#members`); } }] : []),
    { id: "settings", label: "Site settings", icon: SlidersHorizontal, keywords: "configure publishing branding", run: () => { close(); navigate(`/projects/${projectId}/settings`); } },
    { id: "dashboard", label: "Go to dashboard", icon: House, keywords: "home sites switch", run: () => { close(); navigate("/"); } },
  ];

  const hasTerm = !!searchTerm.trim();
  const visibleActions = tagMode
    ? []
    : hasTerm
      ? actions.filter(a => `${a.label} ${a.keywords}`.toLowerCase().includes(searchTerm.trim().toLowerCase()))
      : actions;
  const showRecent = !hasTerm && !isPublic && recent.length > 0;
  const showEmpty = hasTerm && !loading && resultCount === 0 && visibleActions.length === 0;
  const showInitialSpinner = hasTerm && loading && resultCount === 0;

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} shouldFilter={false}>
      <CommandInput
        placeholder={tagMode ? "Filter by tag…" : "Search docs and files… or type # for tags"}
        value={query}
        onValueChange={setQuery}
      />
      <div aria-live="polite" role="status" className="sr-only">
        {loading
          ? "Searching…"
          : hasTerm && resultCount === 0 && visibleActions.length === 0
            ? "No results found."
            : resultCount > 0
              ? `${resultCount} result${resultCount === 1 ? "" : "s"} found.`
              : ""}
      </div>
      <CommandList>
        {showRecent && (
          <CommandGroup heading="Recently viewed">
            {recent.map(item => (
              <CommandItem
                key={`recent:${item.kind}:${item.id}`}
                value={`recent:${item.kind}:${item.id}`}
                onSelect={() => openRecent(item)}
                className="flex items-center gap-2 py-2 min-w-0"
              >
                {item.kind === "doc"
                  ? <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  : <FileKindIcon mime={item.mime ?? ""} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                <span className="font-medium text-sm flex-1 min-w-0 truncate">{item.title}</span>
                <span className="ml-auto flex items-center gap-1 shrink-0 text-[10px] text-muted-foreground">
                  <Clock className="h-2.5 w-2.5" />
                  {timeAgo(item.accessedAt)}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {!hasTerm && !showRecent && visibleActions.length === 0 && (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Search docs and files, or type <span className="font-mono">#</span> to filter by tag.
          </p>
        )}
        {showInitialSpinner && (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden="true" />
            <span className="sr-only">Searching…</span>
          </div>
        )}
        {showEmpty && (
          <p className="py-6 text-center text-sm text-muted-foreground">No results found.</p>
        )}
        {hasTerm && docs.length > 0 && (
          <CommandGroup heading={tagMode ? "Tagged documents" : "Documents"}>
            {docs.map(d => (
              <CommandItem
                key={`doc:${d.doc_id}`}
                value={`doc:${d.doc_id}`}
                onSelect={() => openDoc(d.doc_id)}
                className={d.tags ? "flex items-center gap-2 py-2 min-w-0" : "flex flex-col items-start gap-0.5 py-2"}
              >
                {d.tags ? (
                  <>
                    <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="font-medium text-sm flex-1 min-w-0 truncate">{d.title}</span>
                    <TagChips tags={d.tags} highlight={searchTerm} />
                  </>
                ) : (
                  <>
                    <span className="flex w-full items-center gap-1.5 min-w-0">
                      <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="font-medium text-sm truncate">
                        <HighlightedText text={d.title} term={searchTerm} />
                      </span>
                      <HitMeta folder={d.folder} updatedAt={d.updated_at} />
                    </span>
                    {d.excerpt && <SearchSnippet html={d.excerpt} />}
                  </>
                )}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {hasTerm && folders.length > 0 && (
          <CommandGroup heading="Folders">
            {folders.map(f => (
              <CommandItem
                key={`folder:${f.folder_id}`}
                value={`folder:${f.folder_id}`}
                onSelect={() => openFolder(f.folder_id)}
                className="flex items-center gap-1.5 py-2 min-w-0"
              >
                <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="font-medium text-sm truncate">
                  <HighlightedText text={f.name} term={searchTerm} />
                </span>
                <HitMeta folder={f.parent} />
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {hasTerm && files.length > 0 && (
          <CommandGroup heading="Files">
            {files.map(f => (
              <CommandItem
                key={`file:${f.file_id}`}
                value={`file:${f.file_id}`}
                onSelect={() => openFile(f.file_id)}
                className="flex items-center gap-1.5 py-2 min-w-0"
              >
                <FileKindIcon mime={f.mime_type} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="font-medium text-sm truncate">
                  <HighlightedText text={f.name} term={searchTerm} />
                </span>
                <HitMeta folder={f.folder} updatedAt={f.updated_at} />
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {visibleActions.length > 0 && (
          <CommandGroup heading="Actions">
            {visibleActions.map(a => (
              <CommandItem
                key={`action:${a.id}`}
                value={`action:${a.id}`}
                onSelect={() => { void a.run(); }}
                className="flex items-center gap-1.5 py-2 min-w-0"
              >
                <a.icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="text-sm truncate">{a.label}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
      <div className="flex items-center justify-between gap-2 border-t px-3 py-1.5">
        <div className="flex items-center gap-2 min-w-0">
          <button
            onClick={toggleTagMode}
            aria-pressed={tagMode}
            className={cn(
              "inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border transition-colors cursor-pointer",
              tagMode
                ? "bg-primary/10 text-primary border-primary/30 font-medium"
                : "text-muted-foreground border-border hover:text-foreground hover:border-muted-foreground",
            )}
          >
            <Hash className="h-3 w-3" aria-hidden="true" />
            Tags
          </button>
          {loading ? (
            <span className="flex items-center gap-1 text-[10px] text-muted-foreground" aria-hidden="true">
              <Loader2 className="h-3 w-3 animate-spin" />
              Searching…
            </span>
          ) : hasTerm && resultCount > 0 ? (
            <span className="text-[10px] text-muted-foreground" aria-hidden="true">
              {resultCount} result{resultCount === 1 ? "" : "s"}
            </span>
          ) : null}
        </div>
        <div className="hidden sm:flex items-center gap-2 text-[10px] text-muted-foreground whitespace-nowrap">
          <span className="flex items-center gap-1"><Kbd>↑↓</Kbd> navigate</span>
          <span className="flex items-center gap-1"><Kbd>↵</Kbd> open</span>
          <span className="flex items-center gap-1"><Kbd>esc</Kbd> close</span>
        </div>
      </div>
    </CommandDialog>
  );
}
