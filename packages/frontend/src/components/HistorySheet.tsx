import { Fragment } from "react";
import { ChevronRight } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { UserAvatar } from "@/components/UserAvatar";

export interface RevisionMeta {
  id: string;
  editor_id: string;
  editor_name: string;
  created_at: string;
  changelog: string | null;
  contributors: string | null; // JSON: {id: string; name: string}[]
  title?: string | null; // doc title at this revision; null/absent on rows predating title tracking
}

interface Person {
  id: string;
  name: string;
}

// Everyone credited on the revision - the collab contributors list when the
// revision captured one (only stored when >1 people typed), else the editor.
function contributorsOf(rev: RevisionMeta): Person[] {
  if (rev.contributors) {
    try {
      const cs = JSON.parse(rev.contributors) as Person[];
      if (Array.isArray(cs) && cs.length > 1) return cs;
    } catch { /* */ }
  }
  return [{ id: rev.editor_id, name: rev.editor_name }];
}

function displayName(people: Person[]): string {
  return people.map(p => p.name).join(", ");
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

// Date bucket for the section headers: Today / Yesterday / "June 2026".
function groupLabel(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (diffDays <= 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

// Selected row uses the app's inset rounded-highlight pattern (see the
// sidebar's recent-docs list) rather than full-width bands, which read as
// stacked horizontal lines next to the header/section borders.
function rowClass(selected: boolean): string {
  return `mx-3 flex items-center gap-3 rounded-md px-3 py-2.5 text-left disabled:opacity-50 ${selected ? "bg-accent" : "hover:bg-accent/60"}`;
}

function ViewingBadge() {
  return (
    <span className="shrink-0 rounded-sm bg-primary px-1 py-0.5 text-[10px] font-medium leading-none text-primary-foreground">Viewing</span>
  );
}

// Single avatar, or the app's overlapping-stack pattern (see EditorPresence)
// for multi-editor collab revisions: up to three faces + a "+N" chip.
function AvatarCluster({ people }: { people: Person[] }) {
  if (people.length === 1) {
    return <UserAvatar userId={people[0].id} name={people[0].name} className="size-7 shrink-0 text-xs" />;
  }
  const visible = people.slice(0, 3);
  const overflow = people.length - visible.length;
  return (
    <div className="flex shrink-0 -space-x-2.5">
      {visible.map(p => (
        <UserAvatar key={p.id} userId={p.id} name={p.name} className="size-7 text-xs ring-2 ring-background" />
      ))}
      {overflow > 0 && (
        <span className="z-10 flex size-7 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground ring-2 ring-background">+{overflow}</span>
      )}
    </div>
  );
}

// Presence-style "this is now" indicator for the pinned current-version row.
function LiveDot() {
  return (
    <span className="flex size-7 shrink-0 items-center justify-center" aria-hidden="true">
      <span className="relative flex size-2.5">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500/50" />
        <span className="relative inline-flex size-2.5 rounded-full bg-emerald-500" />
      </span>
    </span>
  );
}

function RowSkeleton() {
  return (
    <div className="flex items-center gap-3 px-6 py-2.5">
      <Skeleton className="size-7 shrink-0 rounded-full" />
      <div className="flex flex-1 flex-col gap-1.5">
        <Skeleton className="h-3.5 w-28" />
        <Skeleton className="h-3 w-40" />
      </div>
    </div>
  );
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  revisions: RevisionMeta[] | null;
  selectedId?: string | null;
  loading?: boolean;
  onSelect: (id: string) => void;
  /** Title of the live document - used to detect renamed revisions and label the current-version entry. */
  currentTitle?: string;
  /** When provided, a pinned "Current version" entry returns to the live document. */
  onSelectCurrent?: () => void;
  /** The last page was full - there may be older revisions to load. */
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
}

export function HistorySheet({ open, onOpenChange, revisions, selectedId, loading, onSelect, currentTitle, onSelectCurrent, hasMore, loadingMore, onLoadMore }: Props) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-80 sm:w-96 flex flex-col gap-0 p-0">
        <SheetHeader className="px-6 py-4 border-b border-border">
          <SheetTitle>
            History
            {revisions && revisions.length > 0 && (
              <span className="ml-1.5 font-normal text-muted-foreground">· {revisions.length}{hasMore ? "+" : ""}</span>
            )}
          </SheetTitle>
        </SheetHeader>
        <div className="flex-1 overflow-auto">
          {revisions === null ? (
            <div className="flex flex-col py-2" data-testid="history-loading" aria-busy="true">
              <RowSkeleton />
              <RowSkeleton />
              <RowSkeleton />
            </div>
          ) : revisions.length === 0 ? (
            <p className="text-sm text-muted-foreground px-6 py-4">No history yet. Revisions are created each time the document is saved, and kept for 90 days.</p>
          ) : (
            <div className="flex flex-col py-2">
              {onSelectCurrent && (
                <button
                  aria-current={!selectedId ? "true" : undefined}
                  className={rowClass(!selectedId)}
                  onClick={onSelectCurrent}
                  disabled={loading}
                >
                  <LiveDot />
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex items-center gap-1.5 text-sm font-medium">
                      <span className="truncate">Current version</span>
                      {!selectedId && <ViewingBadge />}
                    </span>
                    {currentTitle && (
                      <span className="truncate text-xs text-muted-foreground">{currentTitle}</span>
                    )}
                  </div>
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                </button>
              )}
              {revisions.map((rev, i) => {
                const label = groupLabel(rev.created_at);
                const showLabel = i === 0 || label !== groupLabel(revisions[i - 1].created_at);
                const people = contributorsOf(rev);
                return (
                  <Fragment key={rev.id}>
                    {showLabel && (
                      <p className="px-6 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
                    )}
                    <button
                      aria-current={selectedId === rev.id ? "true" : undefined}
                      className={rowClass(selectedId === rev.id)}
                      onClick={() => onSelect(rev.id)}
                      disabled={loading}
                    >
                      <AvatarCluster people={people} />
                      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="flex items-center gap-1.5 text-sm font-medium">
                          <span className="truncate">{displayName(people)}</span>
                          {selectedId === rev.id && <ViewingBadge />}
                        </span>
                        {rev.title && rev.title !== currentTitle && (
                          <span className="truncate text-xs text-muted-foreground">“{rev.title}”</span>
                        )}
                        <span className="text-xs text-muted-foreground" title={formatDateTime(rev.created_at)}>{timeAgo(rev.created_at)}</span>
                        {rev.changelog && (
                          <span className="text-xs text-foreground/70 italic line-clamp-2" title={rev.changelog}>{rev.changelog}</span>
                        )}
                      </div>
                      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                    </button>
                  </Fragment>
                );
              })}
              {hasMore && onLoadMore && (
                <button
                  className="mx-6 mt-2 mb-1 rounded-md border border-border px-3 py-2 text-sm text-muted-foreground hover:bg-accent/60 disabled:opacity-50"
                  onClick={onLoadMore}
                  disabled={loadingMore || loading}
                >
                  {loadingMore ? "Loading…" : "Load more"}
                </button>
              )}
              <p className="px-6 pt-3 pb-2 text-xs text-muted-foreground">Revisions are kept for 90 days. The latest revision is always retained.</p>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
