import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, ListFilter, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { CursorPaginationFooter } from "@/components/CursorPaginationFooter";
import { expandableRowProps } from "@/components/ExpandableRow";
import { SearchInput } from "@/components/SearchInput";
import { useCursorPagination } from "@/hooks/useCursorPagination";
import { formatDateTime } from "@/lib/format";
import { type AdminAuditEntry, LIST_PAGE_SIZE, listAuditActions, listAuditLog } from "@/lib/api";

// Turn a dotted action key into a readable label, e.g.
// "user.ink.grant" -> "User · Ink · Grant". Purely cosmetic; the raw
// action string stays the filter value and the query param.
function humanizeAction(action: string): string {
  return action
    .split(".")
    .map(part =>
      part.replace(/_/g, " ").replace(/\b\w/g, ch => ch.toUpperCase()),
    )
    .join(" · ");
}

function prettyDetail(detail: string | null): string {
  if (!detail) return "";
  try {
    return JSON.stringify(JSON.parse(detail), null, 2);
  } catch {
    return detail;
  }
}

function AuditRow({ entry }: { entry: AdminAuditEntry }) {
  const [expanded, setExpanded] = useState(false);
  const hasDetail = !!entry.detail;

  return (
    <>
      <TableRow {...expandableRowProps(expanded, setExpanded, hasDetail)}>
        <TableCell className="w-8 pr-0">
          {hasDetail
            ? expanded
              ? <ChevronDown className="h-4 w-4 text-muted-foreground" />
              : <ChevronRight className="h-4 w-4 text-muted-foreground" />
            : null}
        </TableCell>
        <TableCell className="text-xs text-muted-foreground">
          <span className="whitespace-nowrap">{formatDateTime(entry.created_at)}</span>
          <span className="mt-0.5 block font-mono sm:hidden">
            {entry.target_type}
            {entry.target_id ? `:${entry.target_id}` : ""}
          </span>
          <span className="mt-0.5 block break-all md:hidden">{entry.actor_email}</span>
        </TableCell>
        <TableCell className="hidden text-xs md:table-cell">{entry.actor_email}</TableCell>
        <TableCell>
          {/* Humanized to match the filter's labels; the raw key stays one
              hover away for grepping logs. */}
          <Badge variant="secondary" className="text-xs" title={entry.action}>
            {humanizeAction(entry.action)}
          </Badge>
        </TableCell>
        <TableCell className="hidden font-mono text-xs text-muted-foreground sm:table-cell">
          {entry.target_type}
          {entry.target_id ? `:${entry.target_id}` : ""}
        </TableCell>
      </TableRow>
      {hasDetail && expanded && (
        <TableRow className="bg-muted/20 hover:bg-transparent">
          <TableCell colSpan={5} className="py-3 pl-10 pr-6">
            <pre className="overflow-x-auto rounded-md bg-muted/40 p-3 text-xs">
              {prettyDetail(entry.detail)}
            </pre>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

// Multi-select dropdown of action types. Empty selection = no filter
// ("All actions"). Selecting several matches any of them (OR).
function ActionFilter({
  options,
  selected,
  onToggle,
  onClear,
}: {
  options: string[];
  selected: string[];
  onToggle: (action: string) => void;
  onClear: () => void;
}) {
  const label =
    selected.length === 0
      ? "All actions"
      : selected.length === 1
        ? humanizeAction(selected[0])
        : `${selected.length} actions`;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className="w-full justify-between sm:w-56"
          aria-label="Filter by action type"
        >
          <span className="flex min-w-0 items-center gap-2">
            <ListFilter className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="truncate">{label}</span>
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-0">
        {options.length === 0 ? (
          <p className="px-3 py-4 text-center text-sm text-muted-foreground">
            No actions recorded yet.
          </p>
        ) : (
          <>
            <div className="max-h-72 overflow-y-auto p-1">
              {options.map(action => (
                <label
                  key={action}
                  className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
                >
                  <Checkbox
                    checked={selected.includes(action)}
                    onCheckedChange={() => onToggle(action)}
                  />
                  <span className="truncate">{humanizeAction(action)}</span>
                </label>
              ))}
            </div>
            {selected.length > 0 && (
              <div className="border-t p-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full justify-start text-muted-foreground"
                  onClick={onClear}
                >
                  <X className="mr-2 h-4 w-4" />
                  Clear {selected.length} selected
                </Button>
              </div>
            )}
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

export function AuditPage() {
  // Selected action types (mix-and-match; empty = every action).
  const [selectedActions, setSelectedActions] = useState<string[]>([]);
  // All action types available to filter by (loaded once).
  const [actionOptions, setActionOptions] = useState<string[]>([]);
  // `search` is the committed (debounced) user-scope query; `searchInput`
  // is the live text box. Default empty = everyone.
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");

  const fetchPage = useCallback(
    async (cursor: string | undefined, signal: AbortSignal) => {
      const res = await listAuditLog(
        cursor,
        { actions: selectedActions, q: search || undefined },
        signal,
      );
      return { items: res.entries, nextCursor: res.nextCursor };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedActions.join(","), search],
  );
  const pager = useCursorPagination<AdminAuditEntry>(fetchPage);
  // reset() reads the latest fetcher via a ref, so calling it right after a
  // filter state update still fetches with the new filters.
  const { reset } = pager;

  const hasFilter = selectedActions.length > 0 || search.length > 0;

  // Distinct action types for the filter list. Loaded once; a failure here
  // is non-fatal (the list just stays empty -> only "all" is available).
  useEffect(() => {
    const controller = new AbortController();
    listAuditActions(controller.signal)
      .then(list => {
        if (!controller.signal.aborted) setActionOptions(list);
      })
      .catch(() => {
        /* non-fatal: leave the filter empty */
      });
    return () => controller.abort();
  }, []);

  // Debounce the search box, and restart paging whenever the committed
  // query changes so a new search begins from the newest match.
  const searchRef = useRef(search);
  searchRef.current = search;
  useEffect(() => {
    const t = setTimeout(() => {
      const next = searchInput.trim();
      if (next !== searchRef.current) {
        setSearch(next);
        reset();
      }
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput, reset]);

  // Toggling an action restarts paging from the newest matching entry.
  function toggleAction(action: string) {
    setSelectedActions(prev =>
      prev.includes(action) ? prev.filter(a => a !== action) : [...prev, action],
    );
    reset();
  }

  function clearActions() {
    setSelectedActions([]);
    reset();
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold">Audit Log</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Actor-attributed record of privileged admin actions. Newest first, {LIST_PAGE_SIZE} per page.
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <SearchInput
            value={searchInput}
            onChange={setSearchInput}
            placeholder="Search user (email or ID)..."
            ariaLabel="Search audit log by user"
            className="w-full sm:w-64"
          />
          <ActionFilter
            options={actionOptions}
            selected={selectedActions}
            onToggle={toggleAction}
            onClear={clearActions}
          />
        </div>
      </div>

      <Card>
        <CardContent className="pt-5">
          {pager.loading ? (
            <div className="space-y-2">
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : pager.error ? (
            <div className="flex flex-col items-center gap-3 py-6">
              <p className="text-center text-sm text-destructive">{pager.error}</p>
              <Button size="sm" variant="outline" onClick={() => pager.refresh()}>
                Retry
              </Button>
            </div>
          ) : pager.items.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {hasFilter ? "No entries match these filters." : "No audit entries yet."}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8" />
                  <TableHead>Time</TableHead>
                  <TableHead className="hidden md:table-cell">Actor</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead className="hidden sm:table-cell">Target</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pager.items.map(entry => (
                  <AuditRow key={entry.id} entry={entry} />
                ))}
              </TableBody>
            </Table>
          )}

          {!pager.error && <CursorPaginationFooter pager={pager} />}
        </CardContent>
      </Card>
    </div>
  );
}
