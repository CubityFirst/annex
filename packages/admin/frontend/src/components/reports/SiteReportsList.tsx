import { useCallback, useState } from "react";
import { toast } from "sonner";
import { ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { CursorPaginationFooter } from "@/components/CursorPaginationFooter";
import { useCursorPagination } from "@/hooks/useCursorPagination";
import { formatDateTime } from "@/lib/format";
import {
  type AdminSiteReport,
  type AdminUserReport,
  type ReportStatus,
  listSiteReports,
  updateReportStatus,
} from "@/lib/api";

// The docs app origin, for deep-linking a report to the public page it was
// filed from (same DEV/prod split as lib/handoff.ts).
const DOCS_APP_ORIGIN = import.meta.env.DEV
  ? "http://localhost:5173"
  : "https://docs.cubityfir.st";

const STATUS_BADGE_VARIANT: Record<ReportStatus, "destructive" | "default" | "secondary" | "outline"> = {
  open: "destructive",
  acknowledged: "default",
  resolved: "secondary",
  dismissed: "outline",
};

export function ReportStatusBadge({ status }: { status: ReportStatus }) {
  return <Badge variant={STATUS_BADGE_VARIANT[status]} className="capitalize">{status}</Badge>;
}

// The status transitions offered per current status. Resolved/dismissed
// reports can be reopened if they were triaged by mistake.
const ACTIONS: Record<ReportStatus, Array<{ to: ReportStatus; label: string; busyLabel: string }>> = {
  open: [
    { to: "acknowledged", label: "Acknowledge", busyLabel: "Acknowledging..." },
    { to: "resolved", label: "Resolve", busyLabel: "Resolving..." },
    { to: "dismissed", label: "Dismiss", busyLabel: "Dismissing..." },
  ],
  acknowledged: [
    { to: "resolved", label: "Resolve", busyLabel: "Resolving..." },
    { to: "dismissed", label: "Dismiss", busyLabel: "Dismissing..." },
  ],
  resolved: [{ to: "open", label: "Reopen", busyLabel: "Reopening..." }],
  dismissed: [{ to: "open", label: "Reopen", busyLabel: "Reopening..." }],
};

// Renders a user identity resolved from the auth DB, falling back to the
// bare id for deleted accounts.
function identityLabel(
  identity: { email: string | null; name: string | null } | null,
  userId: string | null,
): string {
  if (identity) return identity.name ?? identity.email ?? userId ?? "Unknown";
  return userId ? `${userId} (account deleted)` : "Unknown";
}

// Shared card chrome: status badge + timestamp header, note body, meta line,
// and the triage action row. The per-kind cards supply the target line and
// which PATCH endpoint the transitions hit.
function ReportCard({
  kind,
  reportId,
  status,
  createdAt,
  statusChangedAt,
  header,
  target,
  meta,
  note,
  onChanged,
}: {
  kind: "site" | "user";
  reportId: string;
  status: ReportStatus;
  createdAt: string;
  statusChangedAt: string | null;
  header?: React.ReactNode;
  target?: React.ReactNode;
  meta: React.ReactNode;
  note: string;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<ReportStatus | null>(null);

  async function transition(to: ReportStatus) {
    setBusy(to);
    try {
      await updateReportStatus(kind, reportId, to);
      toast.success(`Report ${to === "open" ? "reopened" : to}`);
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to update report");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <ReportStatusBadge status={status} />
        {header}
        <span className="ml-auto text-xs text-muted-foreground">{formatDateTime(createdAt)}</span>
      </div>
      <p className="mt-2 whitespace-pre-wrap break-words text-sm">{note}</p>
      {target}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {meta}
        {statusChangedAt && <span>Status changed {formatDateTime(statusChangedAt)}</span>}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {ACTIONS[status].map(({ to, label, busyLabel }) => (
          <Button
            key={to}
            size="sm"
            variant={to === "resolved" ? "default" : "outline"}
            disabled={busy !== null}
            onClick={() => void transition(to)}
          >
            {busy === to ? busyLabel : label}
          </Button>
        ))}
      </div>
    </div>
  );
}

export function SiteReportCard({
  report,
  showProject,
  onChanged,
}: {
  report: AdminSiteReport;
  // The global queue shows which site each report targets; the per-site view
  // is already scoped to one site and hides it.
  showProject: boolean;
  onChanged: () => void;
}) {
  return (
    <ReportCard
      kind="site"
      reportId={report.id}
      status={report.status}
      createdAt={report.created_at}
      statusChangedAt={report.status_changed_at}
      note={report.note}
      onChanged={onChanged}
      header={showProject ? (
        <span className="min-w-0 break-words">
          <span className="font-medium">{report.project_name ?? "Unknown site"}</span>
          {/* Raw id is noise on a phone - the name identifies the site. */}
          <span className="ml-2 hidden font-mono text-[11px] text-muted-foreground break-all sm:inline">
            {report.project_id}
          </span>
        </span>
      ) : undefined}
      target={report.doc_id ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Reported from page:{" "}
          <a
            href={`${DOCS_APP_ORIGIN}/s/${report.project_id}/${report.doc_id}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex max-w-full items-center gap-1 text-foreground underline underline-offset-2 hover:no-underline"
          >
            <span className="min-w-0 break-words">{report.doc_title ?? report.doc_id}</span>
            <ExternalLink className="h-3 w-3 shrink-0" />
          </a>
        </p>
      ) : undefined}
      meta={
        <>
          <span className="min-w-0 break-all">
            {report.reporter_user_id
              ? `Reported by ${identityLabel(report.reporter, report.reporter_user_id)}`
              : "Reported anonymously"}
          </span>
          {report.reporter?.email && report.reporter.name && (
            <span className="min-w-0 break-all font-mono">{report.reporter.email}</span>
          )}
          {report.reporter_ip && <span className="min-w-0 break-all font-mono">IP {report.reporter_ip}</span>}
        </>
      }
    />
  );
}

export function UserReportCard({
  report,
  onChanged,
}: {
  report: AdminUserReport;
  onChanged: () => void;
}) {
  return (
    <ReportCard
      kind="user"
      reportId={report.id}
      status={report.status}
      createdAt={report.created_at}
      statusChangedAt={report.status_changed_at}
      note={report.note}
      onChanged={onChanged}
      header={
        <span className="min-w-0 break-words">
          <span className="font-medium">{identityLabel(report.reported, report.reported_user_id)}</span>
          {report.reported?.email && (
            <span className="ml-2 hidden font-mono text-[11px] text-muted-foreground break-all sm:inline">
              {report.reported.email}
            </span>
          )}
        </span>
      }
      meta={
        <>
          <span className="min-w-0 break-all">
            Reported by {identityLabel(report.reporter, report.reporter_user_id)}
          </span>
          {report.reporter?.email && report.reporter.name && (
            <span className="min-w-0 break-all font-mono">{report.reporter.email}</span>
          )}
          {report.reporter_ip && <span className="min-w-0 break-all font-mono">IP {report.reporter_ip}</span>}
        </>
      }
    />
  );
}

function ReportListSkeleton() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 4 }).map((_, i) => (
        <Skeleton key={i} className="h-24 w-full" />
      ))}
    </div>
  );
}

// Cursor-paged report list for one site - the body of the "Reports" sheet in
// the admin Projects page. Shows the full history (every status).
export function ProjectReportsPanel({ projectId }: { projectId: string }) {
  const fetchPage = useCallback(
    async (cursor: string | undefined, signal: AbortSignal) => {
      const res = await listSiteReports({ status: "all", projectId, cursor }, signal);
      return { items: res.reports, nextCursor: res.nextCursor };
    },
    [projectId],
  );
  const pager = useCursorPagination<AdminSiteReport>(fetchPage);

  if (pager.loading) return <ReportListSkeleton />;
  if (pager.items.length === 0) {
    return <p className="py-6 text-center text-sm text-muted-foreground">No reports have been filed against this site.</p>;
  }
  return (
    <div className="flex flex-col gap-3">
      {pager.items.map(r => (
        <SiteReportCard key={r.id} report={r} showProject={false} onChanged={() => pager.refresh()} />
      ))}
      <CursorPaginationFooter pager={pager} />
    </div>
  );
}
