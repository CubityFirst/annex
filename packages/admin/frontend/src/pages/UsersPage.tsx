import { useCallback, useEffect, useState } from "react";
import { Ban, Trash2, Undo2, UserCheck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Table, TableBody, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CursorPaginationFooter } from "@/components/CursorPaginationFooter";
import { SearchInput } from "@/components/SearchInput";
import { UserRow } from "@/components/users/UserRow";
import { BulkDeleteUsersDialog } from "@/components/users/BulkDeleteUsersDialog";
import { BulkDisableUsersDialog } from "@/components/users/BulkDisableUsersDialog";
import { useCursorPagination } from "@/hooks/useCursorPagination";
import { type AdminUser, cancelUserDeletion, searchUsers, updateUserModeration } from "@/lib/api";
import { runBulk } from "@/lib/bulk";

// Radix Select disallows an empty-string item value, so the default
// "no filter" option uses an "all" sentinel that maps to no status param.
type StatusFilter = "all" | "active" | "disabled" | "suspended" | "pending_deletion";

export function UsersPage() {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  // `committed` is the query+status actually being paged over (set on submit /
  // status change). Pagination and refreshes page over THESE, never whatever
  // is half-typed in the input box. The empty query is a valid search (all
  // users, newest first), so the list auto-loads on mount.
  const [committed, setCommitted] = useState<{ q: string; status: StatusFilter }>({ q: "", status: "all" });

  const fetchPage = useCallback(
    async (cursor: string | undefined, signal: AbortSignal) => {
      const res = await searchUsers(
        {
          q: committed.q,
          status: committed.status === "all" ? undefined : committed.status,
          cursor,
        },
        signal,
      );
      return { items: res.users, nextCursor: res.nextCursor };
    },
    [committed],
  );
  const pager = useCursorPagination<AdminUser>(fetchPage);
  const users = pager.items;

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    // Commit the current input + status and restart from page 1 (reset always
    // refetches, so re-submitting the same query is a refresh, not a no-op).
    setCommitted({ q: query.trim(), status });
    pager.reset();
  }

  function handleStatusChange(next: StatusFilter) {
    setStatus(next);
    // The status filter applies immediately, but to the COMMITTED query -
    // committing half-typed input here would diverge from the page's
    // submit-to-commit model.
    setCommitted(prev => ({ q: prev.q, status: next }));
    pager.reset();
  }

  // Optimistic per-row overlays on top of the pager's fetched items, applied
  // until the next refetch replaces the underlying rows. Structural changes
  // (a row that should leave a filtered list) go through onModerated ->
  // pager.refresh() instead.
  const [localOverrides, setLocalOverrides] = useState<Record<string, Partial<AdminUser>>>({});
  // Each successful fetch replaces the rows wholesale - drop the overlays so
  // they can't mask newer server state.
  useEffect(() => {
    setLocalOverrides({});
  }, [users]);
  const visibleUsers = users.map(u => (localOverrides[u.id] ? { ...u, ...localOverrides[u.id] } : u));

  function handleUpdated(id: string, updates: Partial<AdminUser>) {
    setLocalOverrides(prev => ({ ...prev, [id]: { ...prev[id], ...updates } }));
  }

  // Checkbox selection for bulk actions. Ids that leave the loaded list (a new
  // search, a refetch after a bulk delete/disable) drop out of the selection,
  // so an action never targets a row the operator can't see.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    setSelectedIds(prev => {
      const loaded = new Set(users.map(u => u.id));
      const next = new Set([...prev].filter(id => loaded.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [users]);
  const selectedUsers = visibleUsers.filter(u => selectedIds.has(u.id));
  const headerChecked =
    selectedUsers.length === 0 ? false : selectedUsers.length === visibleUsers.length ? true : "indeterminate";

  function setSelected(id: string, on: boolean) {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function setAllSelected(on: boolean) {
    setSelectedIds(on ? new Set(visibleUsers.map(u => u.id)) : new Set());
  }

  // Snapshot of the selection when the delete dialog opens: the list refetches
  // after each run, and the dialog must keep showing (and re-checking) the
  // accounts the operator actually reviewed.
  const [deleteTargets, setDeleteTargets] = useState<string[] | null>(null);
  const [disableOpen, setDisableOpen] = useState(false);
  const [reEnabling, setReEnabling] = useState(false);
  // Accounts pending deletion are excluded: their state belongs to the
  // schedule (the worker refuses), so they go through "Cancel deletion".
  const reEnableTargets = selectedUsers.filter(u => u.moderation !== 0 && u.deletion_execute_after == null);
  // A deletion the cron has started can only be finished, not cancelled.
  const cancelDeletionTargets = selectedUsers.filter(u => u.deletion_execute_after != null && u.deletion_started_at == null);
  const [cancellingDeletions, setCancellingDeletions] = useState(false);

  async function handleBulkCancelDeletion() {
    setCancellingDeletions(true);
    try {
      const result = await runBulk(cancelDeletionTargets.map(u => u.id), id => cancelUserDeletion(id));
      if (result.succeeded.length > 0) {
        toast.success(`Cancelled ${result.succeeded.length} scheduled deletion${result.succeeded.length === 1 ? "" : "s"}`);
      }
      for (const f of result.failed) {
        toast.error(`${visibleUsers.find(u => u.id === f.id)?.email ?? f.id}: ${f.error}`);
      }
      pager.refresh();
    } finally {
      setCancellingDeletions(false);
    }
  }

  async function handleBulkReEnable() {
    setReEnabling(true);
    try {
      const result = await runBulk(reEnableTargets.map(u => u.id), id => updateUserModeration(id, 0));
      if (result.succeeded.length > 0) {
        toast.success(`Re-enabled ${result.succeeded.length} account${result.succeeded.length === 1 ? "" : "s"}`);
      }
      for (const f of result.failed) {
        toast.error(`${visibleUsers.find(u => u.id === f.id)?.email ?? f.id}: ${f.error}`);
      }
      pager.refresh();
    } finally {
      setReEnabling(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Users</h1>
        <p className="mt-1 text-sm text-muted-foreground">Search and moderate user accounts.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Search</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSearch} className="flex flex-col gap-2 sm:flex-row">
            <SearchInput
              value={query}
              onChange={setQuery}
              placeholder="Email or user ID..."
              ariaLabel="Search users by email or ID"
              className="w-full sm:max-w-sm"
            />
            <Select value={status} onValueChange={v => handleStatusChange(v as StatusFilter)}>
              <SelectTrigger className="w-full sm:w-44">
                <SelectValue placeholder="All statuses" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="disabled">Disabled</SelectItem>
                <SelectItem value="suspended">Suspended</SelectItem>
                <SelectItem value="pending_deletion">Pending deletion</SelectItem>
              </SelectContent>
            </Select>
            <Button type="submit" disabled={pager.loading}>
              Search
            </Button>
          </form>
        </CardContent>
      </Card>

      {pager.loading ? (
        <Card>
          <CardContent className="space-y-2 pt-5">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="pt-5">
            {selectedUsers.length > 0 && (
              <div className="mb-3 flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 px-3 py-2">
                <span className="text-sm font-medium">{selectedUsers.length} selected</span>
                <Button size="sm" variant="ghost" onClick={() => setAllSelected(false)}>
                  Clear
                </Button>
                <div className="ml-auto flex flex-wrap gap-2">
                  {cancelDeletionTargets.length > 0 && (
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button size="sm" variant="outline" disabled={cancellingDeletions}>
                          <Undo2 className="h-3.5 w-3.5" />
                          Cancel deletion
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>
                            Cancel {cancelDeletionTargets.length} scheduled deletion{cancelDeletionTargets.length === 1 ? "" : "s"}?
                          </AlertDialogTitle>
                          <AlertDialogDescription>
                            These accounts won't be deleted, and each returns to the state it was in before its deletion
                            was scheduled.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Keep scheduled</AlertDialogCancel>
                          <AlertDialogAction onClick={handleBulkCancelDeletion}>Cancel deletions</AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  )}
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button size="sm" variant="outline" disabled={reEnabling || reEnableTargets.length === 0}>
                        <UserCheck className="h-3.5 w-3.5" />
                        Re-enable
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>
                          Re-enable {reEnableTargets.length} account{reEnableTargets.length === 1 ? "" : "s"}?
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                          These disabled or suspended accounts will be able to sign in again.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction onClick={handleBulkReEnable}>Re-enable</AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                  <Button size="sm" variant="outline" onClick={() => setDisableOpen(true)}>
                    <Ban className="h-3.5 w-3.5" />
                    Disable
                  </Button>
                  <Button size="sm" variant="destructive" onClick={() => setDeleteTargets(selectedUsers.map(u => u.id))}>
                    <Trash2 className="h-3.5 w-3.5" />
                    Delete
                  </Button>
                </div>
              </div>
            )}

            {visibleUsers.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">No users found.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8 pr-0">
                      <Checkbox
                        checked={headerChecked}
                        onCheckedChange={v => setAllSelected(v === true)}
                        aria-label="Select all loaded users"
                      />
                    </TableHead>
                    <TableHead className="w-8" />
                    <TableHead>Email</TableHead>
                    <TableHead className="hidden sm:table-cell">Name</TableHead>
                    <TableHead className="hidden md:table-cell">Created</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibleUsers.map(user => (
                    <UserRow
                      key={user.id}
                      user={user}
                      selected={selectedIds.has(user.id)}
                      onSelectedChange={on => setSelected(user.id, on)}
                      onUpdated={handleUpdated}
                      onModerated={() => pager.refresh()}
                    />
                  ))}
                </TableBody>
              </Table>
            )}

            <CursorPaginationFooter pager={pager} />
          </CardContent>
        </Card>
      )}

      <BulkDeleteUsersDialog
        open={deleteTargets !== null}
        onOpenChange={open => { if (!open) setDeleteTargets(null); }}
        userIds={deleteTargets ?? []}
        onScheduled={() => pager.refresh()}
      />
      <BulkDisableUsersDialog
        open={disableOpen}
        onOpenChange={setDisableOpen}
        users={selectedUsers}
        onDone={() => pager.refresh()}
      />
    </div>
  );
}
