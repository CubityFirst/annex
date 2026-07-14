import { useRef, useState } from "react";
import { format } from "date-fns";
import { CalendarDays, ChevronDown, ChevronRight, Download, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { TableCell, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
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
  deleteUserAvatar,
  exportUserData,
  forceUserPasswordChange,
  getUserDetails,
  resyncUserName,
  updateUserModeration,
} from "@/lib/api";
import { downloadBlob } from "@/lib/download";
import { formatDate, initials } from "@/lib/format";
import {
  type DisableMode,
  createDefaultDisableDate,
  formatModerationUntil,
  formatTimeInput,
  getModerationState,
  latestModerationSummary,
  mergeDateAndTime,
} from "@/lib/moderation";
import { cn } from "@/lib/utils";

export interface UserRowProps {
  user: AdminUser;
  onUpdated: (id: string, updates: Partial<AdminUser>) => void;
  // Fired after a moderation change lands, so the page can re-pull the list
  // (a freshly disabled user must drop out of an "Active"-filtered list).
  onModerated: () => void;
}

export function UserRow({ user, onUpdated, onModerated }: UserRowProps) {
  const [expanded, setExpanded] = useState(false);
  const [pending, setPending] = useState(false);
  const [forcingPasswordChange, setForcingPasswordChange] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [resyncingName, setResyncingName] = useState(false);
  const [avatarCacheBust, setAvatarCacheBust] = useState(0);
  const [deletingAvatar, setDeletingAvatar] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [details, setDetails] = useState<AdminUserDetails | null>(null);
  const [disableDialogOpen, setDisableDialogOpen] = useState(false);
  const [datePickerOpen, setDatePickerOpen] = useState(false);
  const [disableMode, setDisableMode] = useState<DisableMode>("indefinitely");
  const [disableDate, setDisableDate] = useState<Date | undefined>(() => createDefaultDisableDate());
  const [disableTime, setDisableTime] = useState(() => formatTimeInput(createDefaultDisableDate()));
  const [disableReason, setDisableReason] = useState("");
  const moderationState = getModerationState(user.moderation);
  const isReasonRequired = disableMode === "indefinitely" || disableMode === "until";
  const canSubmitDisable = !pending && disableReason.trim().length > 0;

  // A refresh requested while one is already in flight is queued instead of
  // dropped - the Stripe-webhook backoff refetches (2s/5s timers in
  // InkBillingCard) exist precisely to close the stale-billing window, so
  // silently swallowing them would defeat the point.
  const detailsInFlight = useRef(false);
  const queuedRefresh = useRef<{ showError: boolean } | null>(null);

  function resetDisableForm() {
    const nextDate = createDefaultDisableDate();
    setDatePickerOpen(false);
    setDisableMode("indefinitely");
    setDisableDate(nextDate);
    setDisableTime(formatTimeInput(nextDate));
    setDisableReason("");
  }

  function handleDisableDialogChange(open: boolean) {
    setDisableDialogOpen(open);
    if (!open) resetDisableForm();
  }

  function handleDisableDateSelect(date: Date | undefined) {
    setDisableDate(date);
    if (date) setDatePickerOpen(false);
  }

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

  async function handleForcePasswordChange() {
    setForcingPasswordChange(true);
    try {
      await forceUserPasswordChange(user.id);
      onUpdated(user.id, { force_password_change: 1 });
      if (detailsOpen || details) void loadDetails(true, false);
      toast.success(`${user.name} will be required to change their password on next sign in`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to force password change");
    } finally {
      setForcingPasswordChange(false);
    }
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

  async function handleEnableAccount() {
    setPending(true);
    try {
      await updateUserModeration(user.id, 0);
      onUpdated(user.id, {
        moderation: 0,
        latest_moderation_action: "re_enabled",
        latest_moderation_reason: null,
        latest_moderation_created_at: new Date().toISOString(),
      });
      if (detailsOpen || details) void loadDetails(true, false);
      onModerated();
      toast.success("Account re-enabled");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to update user");
    } finally {
      setPending(false);
    }
  }

  async function handleDisableAccount() {
    const trimmedReason = disableReason.trim();
    if (!trimmedReason) {
      toast.error("Enter a moderation reason");
      return;
    }

    let moderation = -1;

    if (disableMode === "until") {
      if (!disableDate) {
        toast.error("Choose a date before disabling the account");
        return;
      }

      const disableUntil = mergeDateAndTime(disableDate, disableTime);
      if (Number.isNaN(disableUntil.getTime()) || disableUntil.getTime() <= Date.now()) {
        toast.error("Choose a future date and time");
        return;
      }

      moderation = Math.floor(disableUntil.getTime() / 1000);
    }

    setPending(true);
    try {
      await updateUserModeration(user.id, moderation, trimmedReason);
      onUpdated(user.id, {
        moderation,
        latest_moderation_action: moderation === -1 ? "disabled" : "suspended",
        latest_moderation_reason: trimmedReason,
        latest_moderation_created_at: new Date().toISOString(),
      });
      if (detailsOpen || details) void loadDetails(true, false);
      onModerated();
      toast.success(
        moderation === -1
          ? "Account disabled indefinitely"
          : `Account disabled until ${formatModerationUntil(moderation)}`,
      );
      handleDisableDialogChange(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to update user");
    } finally {
      setPending(false);
    }
  }

  const latestSummary = latestModerationSummary(user);
  const currentReason = moderationState.kind === "active" ? null : user.latest_moderation_reason;

  return (
    <>
      <TableRow {...expandableRowProps(expanded, setExpanded)}>
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
        <TableCell className="hidden sm:table-cell">{user.name}</TableCell>
        <TableCell className="hidden text-muted-foreground text-xs md:table-cell">
          {formatDate(user.created_at)}
        </TableCell>
        <TableCell>
          {moderationState.kind === "disabled"
            ? <Badge variant="destructive">Disabled</Badge>
            : moderationState.kind === "suspended"
              ? <Badge variant="secondary">Suspended</Badge>
              : <Badge variant="default">Active</Badge>}
        </TableCell>
      </TableRow>
      {expanded && (
        <TableRow className="bg-muted/20 hover:bg-transparent">
          <TableCell colSpan={5} className="py-3 pl-10 pr-6">
            <div className="flex flex-col gap-3" onClick={e => e.stopPropagation()}>
              {moderationState.kind === "suspended" && (
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

                {user.force_password_change ? (
                  <Badge variant="outline" className="text-xs">Password change pending</Badge>
                ) : (
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button size="sm" variant="outline" disabled={forcingPasswordChange}>
                        Force password change
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Force password change?</AlertDialogTitle>
                        <AlertDialogDescription>
                          <strong>{user.email}</strong> will be required to set a new password the next time they sign in.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction onClick={handleForcePasswordChange}>
                          Confirm
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                )}

                {moderationState.kind === "active" ? (
                  <Dialog open={disableDialogOpen} onOpenChange={handleDisableDialogChange}>
                    <DialogTrigger asChild>
                      <Button size="sm" variant="destructive" disabled={pending}>
                        Disable account
                      </Button>
                    </DialogTrigger>
                    <DialogContent>
                      <DialogHeader>
                        <DialogTitle>Disable account?</DialogTitle>
                        <DialogDescription>
                          This will prevent <strong>{user.email}</strong> from logging in until the selected time,
                          or until an administrator manually re-enables the account.
                        </DialogDescription>
                      </DialogHeader>

                      <div className="flex flex-col gap-4">
                      <RadioGroup
                        value={disableMode}
                        onValueChange={v => setDisableMode(v as DisableMode)}
                        className="flex flex-col gap-4"
                      >
                        <Label
                          htmlFor={`disable-mode-indefinitely-${user.id}`}
                          className="flex cursor-pointer items-start gap-3 rounded-md border p-3 font-normal"
                        >
                          <RadioGroupItem
                            id={`disable-mode-indefinitely-${user.id}`}
                            value="indefinitely"
                            className="mt-0.5"
                          />
                          <div className="flex flex-col gap-1">
                            <span className="text-sm font-medium">Indefinitely</span>
                            <span className="text-sm text-muted-foreground">
                              Keep the account disabled until an administrator re-enables it.
                            </span>
                          </div>
                        </Label>

                        <div className="flex flex-col gap-3 rounded-md border p-3">
                          <Label
                            htmlFor={`disable-mode-until-${user.id}`}
                            className="flex cursor-pointer items-start gap-3 font-normal"
                          >
                            <RadioGroupItem
                              id={`disable-mode-until-${user.id}`}
                              value="until"
                              className="mt-0.5"
                            />
                            <div className="flex flex-col gap-1">
                              <span className="text-sm font-medium">Until X time</span>
                              <span className="text-sm text-muted-foreground">
                                Re-enable the account automatically at a specific date and time.
                              </span>
                            </div>
                          </Label>

                          {disableMode === "until" && (
                            <div className="flex flex-col gap-3 rounded-md border bg-muted/20 p-3">
                                <div className="flex flex-col gap-2">
                                  <Label>Date</Label>
                                  <Popover open={datePickerOpen} onOpenChange={setDatePickerOpen}>
                                    <PopoverTrigger asChild>
                                      <Button
                                        type="button"
                                        variant="outline"
                                        className={cn(
                                          "w-full justify-start text-left font-normal",
                                          !disableDate && "text-muted-foreground",
                                        )}
                                      >
                                        <CalendarDays className="h-4 w-4" />
                                        {disableDate ? format(disableDate, "PPP") : "Pick a date"}
                                      </Button>
                                    </PopoverTrigger>
                                    <PopoverContent className="w-auto p-0" align="start">
                                      <Calendar
                                        mode="single"
                                        selected={disableDate}
                                        onSelect={handleDisableDateSelect}
                                        disabled={(date) => {
                                          const today = new Date();
                                          today.setHours(0, 0, 0, 0);
                                          return date < today;
                                        }}
                                        initialFocus
                                      />
                                    </PopoverContent>
                                  </Popover>
                                </div>

                                <div className="flex flex-col gap-2">
                                  <Label htmlFor={`disable-time-${user.id}`}>Time</Label>
                                  <Input
                                    id={`disable-time-${user.id}`}
                                    type="time"
                                    value={disableTime}
                                    onChange={e => setDisableTime(e.target.value)}
                                  />
                                </div>
                              </div>
                            )}
                          </div>
                        </RadioGroup>

                        <div className="flex flex-col gap-2">
                          <Label htmlFor={`disable-reason-${user.id}`}>
                            Moderation reason
                          </Label>
                          <Textarea
                            id={`disable-reason-${user.id}`}
                            value={disableReason}
                            onChange={e => setDisableReason(e.target.value)}
                            placeholder="Explain why this account is being disabled or suspended."
                            required={isReasonRequired}
                          />
                          <p className="text-xs text-muted-foreground">
                            This reason is stored in admin moderation history and included in user export data.
                          </p>
                        </div>
                      </div>

                      <DialogFooter>
                        <Button type="button" variant="outline" onClick={() => handleDisableDialogChange(false)} disabled={pending}>
                          Cancel
                        </Button>
                        <Button type="button" variant="destructive" onClick={handleDisableAccount} disabled={!canSubmitDisable}>
                          Disable
                        </Button>
                      </DialogFooter>
                    </DialogContent>
                  </Dialog>
                ) : (
                  <Button size="sm" variant="outline" disabled={pending} onClick={handleEnableAccount}>
                    Re-enable account
                  </Button>
                )}
              </div>
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}
