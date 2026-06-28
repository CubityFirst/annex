import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandItem,
  CommandEmpty,
} from "@/components/ui/command";
import { getToken } from "@/lib/auth";
import { useSiteRoute, siteHref } from "@/lib/siteUrl";
import { FileText, Hash, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

interface TextSearchResult {
  doc_id: string;
  title: string;
  excerpt: string;
  tags?: never;
}

interface TagSearchResult {
  doc_id: string;
  title: string;
  tags: string[];
  excerpt?: never;
}

type SearchResult = TextSearchResult | TagSearchResult;

function SearchSnippet({ html }: { html: string }) {
  const parts = html.split(/(<mark>[\s\S]*?<\/mark>)/g);
  return (
    <span className="text-xs text-muted-foreground line-clamp-2">
      {parts.map((part, i) =>
        part.startsWith("<mark>") ? (
          <mark key={i} className="bg-yellow-200/80 dark:bg-yellow-700/50 text-foreground rounded-[2px] px-px not-italic">
            {part.slice(6, -7)}
          </mark>
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

interface SearchPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  isPublic?: boolean;
}

export function SearchPalette({ open, onOpenChange, projectId, isPublic = false }: SearchPaletteProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const route = useSiteRoute();

  const tagMode = query.startsWith("#");
  const searchTerm = tagMode ? query.slice(1) : query;

  const search = useCallback(
    async (q: string) => {
      const isTag = q.startsWith("#");
      const term = isTag ? q.slice(1) : q;
      if (!term.trim()) { setResults([]); setLoading(false); return; }
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
        const res = await fetch(url, { headers });
        const json = await res.json() as { ok: boolean; data?: SearchResult[] };
        if (json.ok && json.data) setResults(json.data);
        else setResults([]);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    },
    [projectId, isPublic],
  );

  useEffect(() => {
    if (!open) { setQuery(""); setResults([]); setLoading(false); return; }
    if (!searchTerm.trim()) { setResults([]); setLoading(false); return; }
    setLoading(true);
    const timer = setTimeout(() => { search(query); }, 300);
    return () => clearTimeout(timer);
  }, [query, open, search, searchTerm]);

  function handleSelect(docId: string) {
    onOpenChange(false);
    if (isPublic) {
      // Host mode (custom domain) → clean root URL; otherwise /s/<slug>/<docId>.
      navigate(siteHref(route, projectId, docId));
    } else {
      navigate(`/projects/${projectId}/docs/${docId}`);
    }
  }

  function toggleTagMode() {
    if (tagMode) {
      setQuery(searchTerm);
    } else {
      setQuery("#" + query);
    }
  }

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} shouldFilter={false}>
      <CommandInput
        placeholder={tagMode ? "Filter by tag…" : "Search documents… or type # for tags"}
        value={query}
        onValueChange={setQuery}
      />
      <div className="flex items-center gap-1.5 border-b px-3 py-1.5">
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
      </div>
      <div aria-live="polite" role="status" className="sr-only">
        {loading
          ? "Searching…"
          : searchTerm.trim() && results.length === 0
            ? "No results found."
            : results.length > 0
              ? `${results.length} result${results.length === 1 ? "" : "s"} found.`
              : ""}
      </div>
      <CommandList>
        {loading && (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden="true" />
            <span className="sr-only">Searching…</span>
          </div>
        )}
        {!loading && searchTerm.trim() && results.length === 0 && (
          <CommandEmpty>No results found.</CommandEmpty>
        )}
        {!loading && results.map(r => (
          <CommandItem
            key={r.doc_id}
            value={r.doc_id}
            onSelect={() => handleSelect(r.doc_id)}
            className={r.tags ? "flex items-center gap-2 py-2 min-w-0" : "flex flex-col items-start gap-0.5 py-2"}
          >
            {r.tags ? (
              <>
                <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="font-medium text-sm flex-1 min-w-0 truncate">{r.title}</span>
                <TagChips tags={r.tags} highlight={searchTerm} />
              </>
            ) : (
              <>
                <span className="flex items-center gap-1.5 font-medium text-sm">
                  <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  {r.title}
                </span>
                {r.excerpt && <SearchSnippet html={r.excerpt} />}
              </>
            )}
          </CommandItem>
        ))}
      </CommandList>
    </CommandDialog>
  );
}
