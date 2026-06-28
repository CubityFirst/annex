import { ChevronRight } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";

export interface RevisionMeta {
  id: string;
  editor_id: string;
  editor_name: string;
  created_at: string;
  changelog: string | null;
  contributors: string | null; // JSON: {id: string; name: string}[]
}

function displayName(rev: RevisionMeta): string {
  if (rev.contributors) {
    try {
      const cs = JSON.parse(rev.contributors) as { id: string; name: string }[];
      if (cs.length > 1) return cs.map(c => c.name).join(", ");
    } catch { /* */ }
  }
  return rev.editor_name;
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  const date = d.toLocaleDateString(undefined, { year: "numeric", month: "2-digit", day: "2-digit" });
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  return `${date} ${time}`;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const seconds = Math.floor(diff / 1000);
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

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  revisions: RevisionMeta[] | null;
  selectedId?: string | null;
  loading?: boolean;
  onSelect: (id: string) => void;
}

export function HistorySheet({ open, onOpenChange, revisions, selectedId, loading, onSelect }: Props) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-72 sm:w-80 flex flex-col gap-0 p-0">
        <SheetHeader className="px-6 py-4 border-b border-border">
          <SheetTitle>History</SheetTitle>
        </SheetHeader>
        <div className="flex-1 overflow-auto">
          {revisions === null ? (
            <p className="text-sm text-muted-foreground px-6 py-4">Loading…</p>
          ) : revisions.length === 0 ? (
            <p className="text-sm text-muted-foreground px-6 py-4">No history yet. Revisions are created each time the document is saved.</p>
          ) : (
            <div className="flex flex-col py-2">
              {revisions.map(rev => (
                <button
                  key={rev.id}
                  aria-current={selectedId === rev.id ? "true" : undefined}
                  className={`flex items-center justify-between gap-2 border-l-2 px-6 py-2.5 text-left disabled:opacity-50 ${selectedId === rev.id ? "border-primary bg-accent" : "border-transparent hover:bg-accent/60"}`}
                  onClick={() => onSelect(rev.id)}
                  disabled={loading}
                >
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex items-center gap-1.5 text-sm font-medium">
                      <span className="truncate">{displayName(rev)}</span>
                      {selectedId === rev.id && (
                        <span className="shrink-0 rounded-sm bg-primary px-1 py-0.5 text-[10px] font-medium leading-none text-primary-foreground">Viewing</span>
                      )}
                    </span>
                    <span className="text-xs text-muted-foreground">{formatDateTime(rev.created_at)} · <span className="text-muted-foreground">{timeAgo(rev.created_at)}</span></span>
                    {rev.changelog && (
                      <span className="text-xs text-foreground/70 italic line-clamp-2">{rev.changelog}</span>
                    )}
                  </div>
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                </button>
              ))}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
