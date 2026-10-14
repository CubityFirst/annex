import { useCallback, useEffect, useState } from "react";
import { useNavigate, useOutletContext, useParams } from "react-router-dom";
import { FileText, Folder, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import type { DocsLayoutContext } from "@/layouts/DocsLayout";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { FileTypeIcon } from "@/components/FileTypeIcon";
import { useToast } from "@/hooks/use-toast";
import { apiFetchJson } from "@/lib/apiFetch";
import { formatBytes, formatRelativeTime } from "@/lib/fileManager";
import { daysUntilPurge, restoreTrashEntry, restoredItemUrl, trashContentsLabel, type TrashEntry, type TrashListing } from "@/lib/trash";

const CAN_EDIT_ROLES = new Set(["editor", "admin", "owner"]);

function EntryIcon({ entry }: { entry: TrashEntry }) {
  if (entry.item_type === "folder") return <Folder className="h-5 w-5 shrink-0 text-primary/70" aria-hidden="true" />;
  if (entry.item_type === "doc") return <FileText className="h-5 w-5 shrink-0 text-muted-foreground/60" aria-hidden="true" />;
  return <FileTypeIcon mimeType="" name={entry.name} className="h-5 w-5 shrink-0 text-muted-foreground/60" />;
}

export function TrashPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { myRole, setBreadcrumbs } = useOutletContext<DocsLayoutContext>();
  const canEdit = CAN_EDIT_ROLES.has(myRole ?? "");

  const [listing, setListing] = useState<TrashListing | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Entry id with a request in flight, so its buttons disable.
  const [busyId, setBusyId] = useState<string | null>(null);
  const [purgeTarget, setPurgeTarget] = useState<TrashEntry | null>(null);
  const [emptyConfirmOpen, setEmptyConfirmOpen] = useState(false);
  const [emptying, setEmptying] = useState(false);

  useEffect(() => {
    setBreadcrumbs([{ id: null, name: "Recycle bin" }]);
    return () => setBreadcrumbs([]);
  }, [setBreadcrumbs]);

  const load = useCallback(async () => {
    if (!projectId) return;
    setLoadError(null);
    const result = await apiFetchJson<TrashListing>(`/api/projects/${projectId}/trash`);
    if (result.ok && result.data) setListing(result.data);
    else if (!result.redirected) setLoadError(result.error ?? "Couldn't load the recycle bin.");
  }, [projectId]);

  useEffect(() => {
    if (canEdit) load();
  }, [canEdit, load]);

  const removeEntry = (id: string) =>
    setListing(prev => (prev ? { ...prev, entries: prev.entries.filter(e => e.id !== id) } : prev));

  async function handleRestore(entry: TrashEntry) {
    if (!projectId || busyId) return;
    setBusyId(entry.id);
    try {
      const result = await restoreTrashEntry(projectId, entry.id);
      if (result.ok && result.data) {
        const restored = result.data;
        removeEntry(entry.id);
        toast({
          title: `Restored "${entry.name}"`,
          description: entry.folder_id && restored.folderId === null
            ? "Its original folder no longer exists, so it was restored to the top level."
            : undefined,
          action: { label: "Open", onClick: () => navigate(restoredItemUrl(projectId, restored)) },
        });
      } else if (!result.redirected) {
        toast({ title: "Couldn't restore.", description: result.error, variant: "destructive" });
      }
    } finally {
      setBusyId(null);
    }
  }

  async function handlePurge() {
    const entry = purgeTarget;
    if (!projectId || !entry || busyId) return;
    setBusyId(entry.id);
    try {
      const result = await apiFetchJson(`/api/projects/${projectId}/trash/${entry.id}`, { method: "DELETE" });
      if (result.ok) removeEntry(entry.id);
      else if (!result.redirected) toast({ title: "Couldn't delete.", description: result.error, variant: "destructive" });
      setPurgeTarget(null);
    } finally {
      setBusyId(null);
    }
  }

  async function handleEmpty() {
    if (!projectId || emptying) return;
    setEmptying(true);
    setEmptyConfirmOpen(false);
    try {
      const result = await apiFetchJson<{ purged: number; remaining: number }>(`/api/projects/${projectId}/trash`, { method: "DELETE" });
      if (result.ok && result.data && result.data.remaining > 0) {
        // A very large bin is emptied in bounded passes server-side.
        toast({ title: `Deleted ${result.data.purged} items.`, description: `${result.data.remaining} remain - empty the bin again to finish.` });
      } else if (!result.ok && !result.redirected) {
        toast({ title: "Couldn't empty the recycle bin.", description: result.error, variant: "destructive" });
      }
      await load();
    } finally {
      setEmptying(false);
    }
  }

  if (!projectId) return null;

  if (!canEdit) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <Trash2 className="mb-3 h-10 w-10 text-muted-foreground/30" aria-hidden="true" />
        <p className="text-sm font-medium text-muted-foreground">Only editors can view the recycle bin.</p>
      </div>
    );
  }

  const entries = listing?.entries ?? [];
  const retentionDays = listing?.retentionDays ?? 30;

  return (
    <div className="px-4 py-6 sm:px-6 max-w-4xl">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
            <Trash2 className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
            Recycle bin
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Deleted items are kept for {retentionDays} days, then permanently deleted.
            {listing && !listing.canPurge && " Only admins can delete items forever."}
          </p>
        </div>
        {listing?.canPurge && entries.length > 0 && (
          <Button size="sm" variant="destructive" className="gap-1.5" onClick={() => setEmptyConfirmOpen(true)} disabled={emptying}>
            <Trash2 className="h-3.5 w-3.5" />
            {emptying ? "Emptying…" : "Empty bin"}
          </Button>
        )}
      </div>

      {loadError ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <p className="text-sm font-medium text-muted-foreground">Couldn't load the recycle bin.</p>
          <p className="mt-1 text-xs text-muted-foreground">{loadError}</p>
          <Button size="sm" variant="outline" className="mt-4 gap-1.5" onClick={() => load()}>
            <RefreshCw className="h-3.5 w-3.5" />
            Retry
          </Button>
        </div>
      ) : !listing ? (
        <div className="flex flex-col gap-1.5">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-14 w-full" />)}
        </div>
      ) : entries.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <Trash2 className="mb-3 h-10 w-10 text-muted-foreground/30" aria-hidden="true" />
          <p className="text-sm font-medium text-muted-foreground">The recycle bin is empty</p>
        </div>
      ) : (
        <ul className="rounded-md border bg-background overflow-hidden" aria-label="Deleted items">
          {entries.map(entry => {
            const contents = trashContentsLabel(entry);
            const daysLeft = daysUntilPurge(entry.deleted_at, retentionDays);
            const busy = busyId === entry.id;
            const meta = [
              entry.folder_path ? `from ${entry.folder_path}` : null,
              contents || null,
              entry.size > 0 ? formatBytes(entry.size) : null,
              `deleted ${formatRelativeTime(entry.deleted_at).toLowerCase()}${entry.deleted_by_name ? ` by ${entry.deleted_by_name}` : ""}`,
            ].filter(Boolean).join(" · ");
            return (
              <li key={entry.id} className="flex items-center gap-3 min-h-14 px-3 py-2.5 border-b last:border-b-0">
                <EntryIcon entry={entry} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{entry.name}</div>
                  <div className="truncate text-xs text-muted-foreground" title={new Date(entry.deleted_at).toLocaleString()}>
                    {meta}
                  </div>
                </div>
                <span className="hidden sm:inline shrink-0 text-xs text-muted-foreground" title="Permanently deleted after this">
                  {daysLeft === 0 ? "Deleting soon" : `${daysLeft}d left`}
                </span>
                <Button size="sm" variant="outline" className="gap-1.5 h-9 shrink-0" onClick={() => handleRestore(entry)} disabled={busy} aria-label={`Restore ${entry.name}`}>
                  <RotateCcw className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Restore</span>
                </Button>
                {listing.canPurge && (
                  <Button size="sm" variant="ghost" className="h-9 w-9 p-0 shrink-0 text-muted-foreground hover:text-destructive" onClick={() => setPurgeTarget(entry)} disabled={busy} aria-label={`Delete ${entry.name} forever`} title="Delete forever">
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <AlertDialog open={!!purgeTarget} onOpenChange={open => { if (!open) setPurgeTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete "{purgeTarget?.name}" forever?</AlertDialogTitle>
            <AlertDialogDescription>
              {purgeTarget && trashContentsLabel(purgeTarget)
                ? `This folder and everything in it (${trashContentsLabel(purgeTarget)}) will be permanently deleted. This can't be undone.`
                : "This will be permanently deleted, including its history. This can't be undone."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handlePurge}
              disabled={!!busyId}
            >
              Delete forever
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={emptyConfirmOpen} onOpenChange={setEmptyConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Empty the recycle bin?</AlertDialogTitle>
            <AlertDialogDescription>
              All {entries.length} {entries.length === 1 ? "item" : "items"} will be permanently deleted. This can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={handleEmpty}>
              Empty bin
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
