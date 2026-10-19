import { useEffect, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { type DeletePreviewUser, previewUserDeletion, scheduleUserDeletion } from "@/lib/api";
import { type BulkResult, runBulk } from "@/lib/bulk";

const CONFIRM_WORD = "DELETE";
// Display only - mirrors USER_DELETION_GRACE_SECONDS in the admin worker
// (src/lib/userDeletion.ts), which is what actually sets the date.
export const DELETION_GRACE_DAYS = 7;

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function ownsAnything(u: DeletePreviewUser): boolean {
  return u.owned_sites.length > 0 || u.owned_orgs.length > 0;
}

// Splits the preview into what will actually be scheduled for deletion. An account that owns
// sites/orgs is skipped unless the operator ticked its "also delete" box -
// site deletion is never implied by selecting a user.
export function planDeletion(preview: DeletePreviewUser[], alsoDeleteOwned: Record<string, boolean>) {
  const deletable = preview.filter(u => !u.blocked && (!ownsAnything(u) || alsoDeleteOwned[u.id]));
  const skipped = preview.filter(u => !deletable.includes(u));
  return {
    deletable,
    skipped,
    sites: deletable.flatMap(u => u.owned_sites),
    orgs: deletable.flatMap(u => u.owned_orgs),
  };
}

export interface BulkDeleteUsersDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userIds: string[];
  // Called after a run with the ids that were actually scheduled.
  onScheduled: (ids: string[]) => void;
}

export function BulkDeleteUsersDialog({ open, onOpenChange, userIds, onScheduled }: BulkDeleteUsersDialogProps) {
  const [preview, setPreview] = useState<DeletePreviewUser[] | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [alsoDeleteOwned, setAlsoDeleteOwned] = useState<Record<string, boolean>>({});
  const [confirmText, setConfirmText] = useState("");
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [failures, setFailures] = useState<BulkResult["failed"]>([]);

  // Fresh preview every time the dialog opens: consent must be given against
  // the accounts' current sites, not a stale copy.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setPreview(null);
    setPreviewError(null);
    setAlsoDeleteOwned({});
    setConfirmText("");
    setProgress(null);
    setFailures([]);
    previewUserDeletion(userIds)
      .then(p => { if (!cancelled) setPreview(p); })
      .catch(e => { if (!cancelled) setPreviewError(e instanceof Error ? e.message : "Failed to load preview"); });
    return () => { cancelled = true; };
    // Keyed on the joined ids: the caller snapshots them at open time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, userIds.join(",")]);

  const plan = preview ? planDeletion(preview, alsoDeleteOwned) : null;
  const canDelete = !!plan && plan.deletable.length > 0 && confirmText === CONFIRM_WORD && !running;

  async function handleDelete() {
    if (!plan) return;
    setRunning(true);
    setFailures([]);
    setProgress({ done: 0, total: plan.deletable.length });
    try {
      const result = await runBulk(
        plan.deletable.map(u => u.id),
        id => {
          const u = plan.deletable.find(p => p.id === id)!;
          return scheduleUserDeletion(id, {
            siteIds: u.owned_sites.map(s => s.id),
            orgIds: u.owned_orgs.map(o => o.id),
          }).then(() => undefined);
        },
        { onProgress: (done, total) => setProgress({ done, total }) },
      );
      if (result.succeeded.length > 0) {
        toast.success(`Scheduled ${plural(result.succeeded.length, "account")} for deletion`);
        onScheduled(result.succeeded);
      }
      if (result.failed.length > 0) {
        // Keep the dialog open so the operator can read what went wrong. A
        // retry must be consented against what the remaining accounts own NOW
        // (their sites may have changed since the first preview), so
        // re-preview them and clear every "also delete" box and the confirm word.
        setFailures(result.failed);
        setConfirmText("");
        setAlsoDeleteOwned({});
        const remaining = (preview ?? []).map(u => u.id).filter(id => !result.succeeded.includes(id));
        try {
          setPreview(remaining.length > 0 ? await previewUserDeletion(remaining) : []);
        } catch (e) {
          setPreviewError(e instanceof Error ? e.message : "Failed to reload preview");
        }
        toast.error(`${plural(result.failed.length, "account")} could not be scheduled`);
      } else {
        onOpenChange(false);
      }
    } finally {
      setRunning(false);
    }
  }

  const emailFor = (id: string) => preview?.find(u => u.id === id)?.email ?? id;
  const title = preview ? plural(preview.length, "account") : plural(userIds.length, "account");

  return (
    <Dialog open={open} onOpenChange={next => { if (!running) onOpenChange(next); }}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Schedule deletion of {title}?</DialogTitle>
          <DialogDescription>
            Accounts are disabled immediately and permanently deleted in {DELETION_GRACE_DAYS} days. Until then any
            admin can cancel from the Users page. When the deletion runs, each account's sessions, passkeys, billing
            and memberships are removed, and any Stripe customer is deleted (which cancels their subscription).
          </DialogDescription>
        </DialogHeader>

        {previewError ? (
          <p className="text-sm text-destructive">{previewError}</p>
        ) : !preview || !plan ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Checking what these accounts own...
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <ul className="flex max-h-[45vh] flex-col gap-2 overflow-y-auto pr-1">
              {preview.map(u => (
                <li key={u.id} className="rounded-md border p-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs break-all">{u.email}</span>
                    {u.name && <span className="text-muted-foreground">{u.name}</span>}
                    {u.blocked === "self" && <Badge variant="secondary">Skipped - your account</Badge>}
                    {u.blocked === "admin" && <Badge variant="secondary">Skipped - admin account</Badge>}
                    {u.blocked === "scheduled" && <Badge variant="secondary">Skipped - already scheduled</Badge>}
                  </div>

                  {!u.blocked && u.has_stripe_customer && (
                    <p className="mt-1 text-xs text-amber-600">
                      {u.has_subscription
                        ? "Has a Stripe subscription - it will be cancelled and the Stripe customer deleted."
                        : "Has a Stripe customer - it will be deleted."}
                    </p>
                  )}

                  {!u.blocked && ownsAnything(u) && (
                    <div className="mt-2 rounded-md border border-destructive/40 bg-destructive/5 p-2">
                      {u.owned_sites.length > 0 && (
                        <>
                          <p className="text-xs font-medium">Owns {plural(u.owned_sites.length, "site")}:</p>
                          <ul className="mt-1 list-disc pl-5 text-xs">
                            {u.owned_sites.map(s => (
                              <li key={s.id}>
                                <span className="font-medium">{s.name}</span>
                                {" - "}{plural(s.docs, "doc")}, {plural(s.other_members, "other member")}
                                {s.published ? ", published" : ""}
                              </li>
                            ))}
                          </ul>
                        </>
                      )}
                      {u.owned_orgs.length > 0 && (
                        <>
                          <p className="mt-1 text-xs font-medium">Owns {plural(u.owned_orgs.length, "organization")}:</p>
                          <ul className="mt-1 list-disc pl-5 text-xs">
                            {u.owned_orgs.map(o => (
                              <li key={o.id}>
                                <span className="font-medium">{o.name}</span>
                                {" - "}{plural(o.sites, "attached site")} (detached, not deleted),{" "}
                                {plural(o.other_members, "other member")}
                              </li>
                            ))}
                          </ul>
                        </>
                      )}
                      <Label
                        htmlFor={`also-delete-${u.id}`}
                        className="mt-2 flex cursor-pointer items-start gap-2 text-xs font-normal"
                      >
                        <Checkbox
                          id={`also-delete-${u.id}`}
                          checked={!!alsoDeleteOwned[u.id]}
                          disabled={running}
                          onCheckedChange={v => setAlsoDeleteOwned(prev => ({ ...prev, [u.id]: v === true }))}
                        />
                        <span>
                          Also permanently delete{" "}
                          {[
                            u.owned_sites.length > 0 ? `${u.owned_sites.length === 1 ? "this" : "these"} ${plural(u.owned_sites.length, "site")}` : null,
                            u.owned_orgs.length > 0 ? plural(u.owned_orgs.length, "organization") : null,
                          ].filter(Boolean).join(" and ")}
                          {alsoDeleteOwned[u.id] ? "" : " - otherwise this account is skipped"}
                        </span>
                      </Label>
                    </div>
                  )}
                </li>
              ))}
            </ul>

            <div className="rounded-md bg-muted/40 p-3 text-sm">
              <p>
                <span className="font-medium">{plural(plan.deletable.length, "account")}</span> will be disabled now
                and deleted in {DELETION_GRACE_DAYS} days{plan.skipped.length > 0 && <>; {plan.skipped.length} skipped</>}.
              </p>
              {plan.sites.length > 0 && (
                <p className="mt-1 flex items-start gap-1.5 text-destructive">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>
                    {plural(plan.sites.length, "site")} will be permanently deleted with all docs and files when the
                    deletion runs:{" "}
                    {plan.sites.map(s => s.name).join(", ")}
                  </span>
                </p>
              )}
              {plan.orgs.length > 0 && (
                <p className="mt-1 text-destructive">
                  {plural(plan.orgs.length, "organization")} will be deleted: {plan.orgs.map(o => o.name).join(", ")}
                </p>
              )}
            </div>

            {failures.length > 0 && (
              <div className="rounded-md border border-destructive/40 p-3 text-xs">
                <p className="font-medium text-destructive">Not scheduled:</p>
                <ul className="mt-1 list-disc pl-5">
                  {failures.map(f => (
                    <li key={f.id}><span className="font-mono">{emailFor(f.id)}</span> - {f.error}</li>
                  ))}
                </ul>
              </div>
            )}

            {plan.deletable.length > 0 && (
              <div className="flex flex-col gap-2">
                <Label htmlFor="bulk-delete-confirm">Type {CONFIRM_WORD} to confirm</Label>
                <Input
                  id="bulk-delete-confirm"
                  value={confirmText}
                  onChange={e => setConfirmText(e.target.value)}
                  disabled={running}
                  autoComplete="off"
                />
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={running}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" onClick={handleDelete} disabled={!canDelete}>
            {running && progress
              ? `Scheduling ${progress.done}/${progress.total}...`
              : `Schedule deletion (${plural(plan?.deletable.length ?? 0, "account")})`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
