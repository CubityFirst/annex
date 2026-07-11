import { useCallback, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { CursorPaginationFooter } from "@/components/CursorPaginationFooter";
import { SiteReportCard, UserReportCard } from "@/components/reports/SiteReportsList";
import { useCursorPagination, type CursorPager } from "@/hooks/useCursorPagination";
import {
  type AdminSiteReport,
  type AdminUserReport,
  listSiteReports,
  listUserReports,
} from "@/lib/api";

const STATUS_FILTERS = [
  { value: "current", label: "Current (open + acknowledged)" },
  { value: "open", label: "Open" },
  { value: "acknowledged", label: "Acknowledged" },
  { value: "resolved", label: "Resolved" },
  { value: "dismissed", label: "Dismissed" },
  { value: "all", label: "All" },
] as const;

// The filter card + paged card list shared by both tabs. Each tab owns its
// own status filter and pager; Radix unmounts the inactive tab, so switching
// back refetches page 1 - fine for a triage queue that should be fresh.
function ReportQueue<T extends { id: string }>({
  status,
  onStatusChange,
  pager,
  renderCard,
  emptyCurrent,
  ariaLabel,
}: {
  status: string;
  onStatusChange: (next: string) => void;
  pager: CursorPager<T>;
  renderCard: (item: T, onChanged: () => void) => React.ReactNode;
  emptyCurrent: string;
  ariaLabel: string;
}) {
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Filter</CardTitle>
        </CardHeader>
        <CardContent>
          <Select value={status} onValueChange={onStatusChange}>
            <SelectTrigger className="w-full max-w-sm" aria-label={ariaLabel}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_FILTERS.map(f => (
                <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-5">
          {pager.loading ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-24 w-full" />
              ))}
            </div>
          ) : pager.items.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {status === "current" ? emptyCurrent : "No reports match this filter."}
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              {pager.items.map(item => renderCard(item, () => pager.refresh()))}
            </div>
          )}

          <CursorPaginationFooter pager={pager} />
        </CardContent>
      </Card>
    </div>
  );
}

function SiteReportsTab() {
  const [status, setStatus] = useState<string>("current");
  const fetchPage = useCallback(
    async (cursor: string | undefined, signal: AbortSignal) => {
      const res = await listSiteReports({ status, cursor }, signal);
      return { items: res.reports, nextCursor: res.nextCursor };
    },
    [status],
  );
  const pager = useCursorPagination<AdminSiteReport>(fetchPage);

  return (
    <ReportQueue
      status={status}
      onStatusChange={next => { setStatus(next); pager.reset(); }}
      pager={pager}
      renderCard={(report, onChanged) => (
        <SiteReportCard key={report.id} report={report} showProject onChanged={onChanged} />
      )}
      emptyCurrent="No open site reports - all clear."
      ariaLabel="Filter site reports by status"
    />
  );
}

function UserReportsTab() {
  const [status, setStatus] = useState<string>("current");
  const fetchPage = useCallback(
    async (cursor: string | undefined, signal: AbortSignal) => {
      const res = await listUserReports({ status, cursor }, signal);
      return { items: res.reports, nextCursor: res.nextCursor };
    },
    [status],
  );
  const pager = useCursorPagination<AdminUserReport>(fetchPage);

  return (
    <ReportQueue
      status={status}
      onStatusChange={next => { setStatus(next); pager.reset(); }}
      pager={pager}
      renderCard={(report, onChanged) => (
        <UserReportCard key={report.id} report={report} onChanged={onChanged} />
      )}
      emptyCurrent="No open user reports - all clear."
      ariaLabel="Filter user reports by status"
    />
  );
}

export function ReportsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Current Reports</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Abuse reports filed by visitors and members - sites via the published-site
          &quot;Report Site&quot; button, users via the profile card. Acknowledge a report
          to mark it as seen, then resolve or dismiss it.
        </p>
      </div>

      <Tabs defaultValue="sites">
        <TabsList>
          <TabsTrigger value="sites">Sites</TabsTrigger>
          <TabsTrigger value="users">Users</TabsTrigger>
        </TabsList>
        <TabsContent value="sites" className="mt-4">
          <SiteReportsTab />
        </TabsContent>
        <TabsContent value="users" className="mt-4">
          <UserReportsTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
