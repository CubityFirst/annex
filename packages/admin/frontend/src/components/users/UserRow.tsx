import { useRef, useState } from "react";
import { ChevronDown, ChevronRight, Download, ExternalLink, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { TableCell, TableRow } from "@/components/ui/table";
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
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { expandableRowProps } from "@/components/ExpandableRow";
import { UserDetailsPanel } from "@/components/users/UserDetailsPanel";
import { DetailsLoadingState } from "@/components/users/DetailsLoadingState";
import {
  type AdminUser,
  type AdminUserDetails,
  cancelUserDeletion,
  deleteUserAvatar,
  exportUserData,
  getUserDetails,
  resyncUserName,
} from "@/lib/api";
import { downloadBlob } from "@/lib/download";
import { formatDate, formatTimestampSeconds, initials } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  formatModerationUntil,
  getModerationState,
  latestModerationSummary,
} from "@/lib/moderation";

export interface UserRowProps {
  user: AdminUser;
  selected: boolean;
  onSelectedChange: (selected: boolean) => void;
  onUpdated: (id: string, updates: Partial<AdminUser>) => void;
  // Fired after a moderation change lands, so the page can re-pull the list
  // (a freshly disabled user must drop out of an "Active"-filtered list).
  onModerated: () => void;
}

export function UserRow({ user, selected, onSelectedChange, onUpdated, onModerated }: UserRowProps) {
  const [expanded, setExpanded] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [resyncingName, setResyncingName] = useState(false);
  const [avatarCacheBust, setAvatarCacheBust] = useState(0);
  const [deletingAvatar, setDeletingAvatar] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [details, setDetails] = useState<AdminUserDetails | null>(null);
  const moderationState = getModerationState(user.moderation);
  const deletionScheduled = user.deletion_execute_after != null;
  const deletionStarted = user.deletion_started_at != null;
  const [cancellingDeletion, setCancellingDeletion] = useState(false);

  // A refresh requested while one is already in flight is queued instead of
  // dropped - the Stripe-webhook backoff refetches (2s/5s timers in
  // InkBillingCard) exist precisely to close the stale-billing window, so
  // silently swallowing them would defeat the point.
  const detailsInFlight = useRef(false);
  const queuedRefresh = useRef<{ showError: boolean } | null>(null);

  async function loadDetails(force = false, showError = true) {
    if (detailsInFlight.current) {
      if (force) queuedRefresh.current = { showError };
      return;
    }
    if (!force && details) return;

    detailsInFlight.current = true;
    setDetailsLoading(true);
    try {
      setDetails(await getUserDetails(user.id));
    } catch (e) {
      if (showError) toast.error(e instanceof Error ? e.message : "Failed to load user details");
    } finally {
      detailsInFlight.current = false;
      setDetailsLoading(false);
      const queued = queuedRefresh.current;
      queuedRefresh.current = null;
      if (queued) void loadDetails(true, queued.showError);
    }
  }

  function handleDetailsOpenChange(open: boolean) {
    setDetailsOpen(open);
    // Always refetch on open: cached details go stale across close/reopen
    // (any cached copy still renders while the refresh is in flight).
    if (open) void loadDetails(true, true);
  }

  async function handleExport() {
    setExporting(true);
    try {
      const { blob, filename } = await exportUserData(user.id, user.email);
      downloadBlob(blob, filename);
      toast.success("Data export downloaded");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to export user data");
    } finally {
      setExporting(false);
    }
  }

  async function handleResyncName() {
    setResyncingName(true);
    try {
      const updated = await resyncUserName(user.id);
      const total = updated.project_members + updated.organization_members;
      if (detailsOpen || details) void loadDetails(true, false);
      toast.success(
        total === 0
          ? "Display name was already in sync everywhere"
          : `Display name fixed on ${total} membership row${total === 1 ? "" : "s"}`,
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to resync display name");
    } finally {
      setResyncingName(false);
    }
  }

  async function handleDeleteAvatar() {
    setDeletingAvatar(true);
    try {
      await deleteUserAvatar(user.id);
      setAvatarCacheBust(v => v + 1);
      toast.success("Avatar removed");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to delete avatar");
    } finally {
      setDeletingAvatar(false);
    }
  }

  async function handleCancelDeletion() {
    setCancellingDeletion(true);
    try {
      await cancelUserDeletion(user.id);
      if (detailsOpen || details) void loadDetails(true, false);
      // Moderation is restored server-side to whatever it was before; refetch
      // rather than guess it here.
      onModerated();
      toast.success("Scheduled deletion cancelled");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to cancel deletion");
    } finally {
      setCancellingDeletion(false);
    }
  }

  const latestSummary = latestModerationSummary(user);
  const currentReason = moderationState.kind === "active" ? null : user.latest_moderation_reason;

  return (
    <>
      <TableRow
        {...expandableRowProps(expanded, setExpanded)}
        className={cn("cursor-pointer", selected && "bg-muted/50")}
      >
        {/* The row itself toggles expansion on click/Enter/Space - keep the
            checkbox's own clicks and key presses from reaching it. */}
        <TableCell
          className="w-8 pr-0"
          onClick={e => e.stopPropagation()}
          onKeyDown={e => e.stopPropagation()}
        >
          <Checkbox
            checked={selected}
            onCheckedChange={v => onSelectedChange(v === true)}
            aria-label={`Select ${user.email}`}
          />
        </TableCell>
        <TableCell className="w-8 pr-0">
          {expanded
            ? <ChevronDown className="h-4 w-4 text-muted-foreground" />
            : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
        </TableCell>
        <TableCell className="font-mono text-xs whitespace-normal break-all">
          {user.email}
          {user.name && (
            <span className="mt-0.5 block font-sans text-[11px] text-muted-foreground sm:hidden">
              {user.name}
            </span>
          )}
          <span className="mt-0.5 block font-sans text-[11px] text-muted-foreground md:hidden">
            {formatDate(user.created_at)}
          </span>
        </TableCell>
        <TableCell className="hidden sm:table-cell">
          {user.name}
          {user.handle && (
            <span className="mt-0.5 block text-[11px] text-muted-foreground">@{user.handle}</span>
          )}
        </TableCell>
        <TableCell className="hidden text-muted-foreground text-xs md:table-cell">
          {formatDate(user.created_at)}
        </TableCell>
        <TableCell>
          <div className="flex flex-wrap items-center gap-1">
            {deletionScheduled
              ? user.deletion_completed_at != null
                ? <Badge variant="destructive">Annex data deleted</Badge>
                : <Badge variant="destructive">Deleting {formatTimestampSeconds(user.deletion_execute_after!)}</Badge>
              : moderationState.kind === "disabled"
              ? <Badge variant="destructive">Disabled</Badge>
              : moderationState.kind === "suspended"
                ? <Badge variant="secondary">Suspended</Badge>
                : <Badge variant="default">Active</Badge>}
            {user.deletion_error && (
              <Badge variant="outline" className="text-destructive" title={user.deletion_error}>Deletion failed</Badge>
            )}
            {!user.email_verified && (
              <Badge variant="outline" className="text-amber-600">Email unverified</Badge>
            )}
          </div>
        </TableCell>
      </TableRow>
      {expanded && (
        <TableRow className="bg-muted/20 hover:bg-transparent">
          <TableCell colSpan={6} className="py-3 pl-10 pr-6">
            <div className="flex flex-col gap-3" onClick={e => e.stopPropagation()}>
              {deletionScheduled && (
                <div className="text-sm">
                  <p>
                    {user.deletion_completed_at != null ? (
                      <>
                        <span className="font-medium text-destructive">Annex data deleted</span> on{" "}
                        {formatTimestampSeconds(user.deletion_completed_at)}. They stay blocked from Annex; delete the
                        account itself on auth.cubityfir.st.
                      </>
                    ) : (
                      <>
                        <span className="font-medium text-destructive">Annex data scheduled for deletion</span> on{" "}
                        {formatTimestampSeconds(user.deletion_execute_after!)}
                        {user.deletion_requested_by_email ? ` (requested by ${user.deletion_requested_by_email})` : ""}.
                        They&apos;re blocked from Annex until then.
                      </>
                    )}
                  </p>
                  {user.deletion_error && (
                    <p className="mt-1 text-xs text-destructive">
                      Last attempt failed: {user.deletion_error}. It retries hourly
                      {deletionStarted
                        ? " - the deletion is already under way, so it can only be finished, not cancelled."
                        : "; cancel and reschedule to review again."}
                    </p>
                  )}
                </div>
              )}

              {!deletionScheduled && moderationState.kind === "suspended" && (
                <p className="text-xs text-muted-foreground">
                  This account will be re-enabled automatically on {formatModerationUntil(moderationState.until)}.
                </p>
              )}

              {currentReason && (
                <p className="text-sm">
                  <span className="font-medium">Current moderation reason:</span> {currentReason}
                </p>
              )}

              {!currentReason && latestSummary && (
                <p className="text-xs text-muted-foreground">
                  Last moderation event: {latestSummary}
                  {user.latest_moderation_reason ? ` - ${user.latest_moderation_reason}` : ""}
                </p>
              )}

              <div className="flex flex-wrap items-center gap-2">
                <Sheet open={detailsOpen} onOpenChange={handleDetailsOpenChange}>
                  <SheetTrigger asChild>
                    <Button size="sm" variant="secondary">
                      User details
                    </Button>
                  </SheetTrigger>
                  <SheetContent className="max-w-3xl">
                    <SheetHeader>
                      <div className="flex items-center gap-3">
                        <Avatar className="size-12">
                          <AvatarImage
                            src={`/api/avatar/${user.id}?v=${avatarCacheBust}`}
                            alt={user.name}
                          />
                          <AvatarFallback>{initials(user.name)}</AvatarFallback>
                        </Avatar>
                        <div>
                          <SheetTitle>{user.name}</SheetTitle>
                          <SheetDescription>{user.email}</SheetDescription>
                        </div>
                      </div>
                    </SheetHeader>
                    <SheetBody>
                      {detailsLoading && !details
                        ? <DetailsLoadingState />
                        : details
                          ? <UserDetailsPanel details={details} userId={user.id} userName={user.name} onChanged={() => loadDetails(true, false)} />
                          : <p className="text-sm text-muted-foreground">User details could not be loaded.</p>}
                    </SheetBody>
                    <SheetFooter className="flex flex-row justify-end gap-2">
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button type="button" variant="outline" disabled={deletingAvatar} className="mr-auto">
                            <Trash2 className="h-3.5 w-3.5" />
                            Delete avatar
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Delete avatar?</AlertDialogTitle>
                            <AlertDialogDescription>
                              This will permanently remove the avatar for <strong>{user.name}</strong>.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction onClick={handleDeleteAvatar}>
                              Delete
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                      <Button type="button" variant="outline" disabled={detailsLoading} onClick={() => { setAvatarCacheBust(v => v + 1); void loadDetails(true); }}>
                        Refresh details
                      </Button>
                      <Button type="button" variant="outline" disabled={exporting} onClick={handleExport}>
                        <Download className="h-3.5 w-3.5" />
                        Export data
                      </Button>
                    </SheetFooter>
                  </SheetContent>
                </Sheet>

                <Button size="sm" variant="outline" disabled={exporting} onClick={handleExport}>
                  <Download className="h-3.5 w-3.5" />
                  Export data
                </Button>

                <Button size="sm" variant="outline" disabled={resyncingName} onClick={handleResyncName}>
                  <RefreshCw className="h-3.5 w-3.5" />
                  Resync display name
                </Button>

                {deletionScheduled && user.deletion_completed_at != null ? null : deletionScheduled && deletionStarted ? (
                  <Badge variant="outline" className="text-xs">Deletion in progress - can't be cancelled</Badge>
                ) : deletionScheduled ? (
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button size="sm" variant="outline" disabled={cancellingDeletion}>
                        Cancel deletion
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Cancel scheduled deletion?</AlertDialogTitle>
                        <AlertDialogDescription>
                          <strong>{user.email}</strong>&apos;s Annex data will not be deleted, and they can use
                          Annex again.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Keep scheduled</AlertDialogCancel>
                        <AlertDialogAction onClick={handleCancelDeletion}>Cancel deletion</AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                ) : null}

                <Button size="sm" variant="outline" asChild>
                  <a href={`https://auth.cubityfir.st/admin/users/${encodeURIComponent(user.id)}`} target="_blank" rel="noreferrer">
                    Moderate on auth.cubityfir.st
                    <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                  </a>
                </Button>
              </div>
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}
