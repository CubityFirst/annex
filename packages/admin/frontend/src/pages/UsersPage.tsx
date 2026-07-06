import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
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
import { useCursorPagination } from "@/hooks/useCursorPagination";
import { type AdminUser, searchUsers } from "@/lib/api";

// Radix Select disallows an empty-string item value, so the default
// "no filter" option uses an "all" sentinel that maps to no status param.
type StatusFilter = "all" | "active" | "disabled" | "suspended";

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
            {visibleUsers.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">No users found.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
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
    </div>
  );
}
