import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { type AdminUser, updateUserModeration } from "@/lib/api";
import { runBulk } from "@/lib/bulk";

export interface BulkDisableUsersDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  users: AdminUser[];
  onDone: () => void;
}

// Disables every selected account indefinitely with one shared reason.
// Already-disabled accounts are left alone so their existing reason isn't
// overwritten; suspended accounts become indefinitely disabled. For a timed
// suspension, use the per-user "Disable account" dialog.
export function BulkDisableUsersDialog({ open, onOpenChange, users, onDone }: BulkDisableUsersDialogProps) {
  const [reason, setReason] = useState("");
  const [running, setRunning] = useState(false);
  // Snapshot at open time so a background list refresh can't change the
  // target set after the operator has read the title.
  const [snapshot, setSnapshot] = useState<AdminUser[]>([]);
  useEffect(() => {
    if (open) setSnapshot(users);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const targets = snapshot.filter(u => u.moderation !== -1);
  const alreadyDisabled = snapshot.length - targets.length;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const suspended = targets.filter(u => u.moderation > nowSeconds).length;

  function handleOpenChange(next: boolean) {
    if (running) return;
    if (!next) setReason("");
    onOpenChange(next);
  }

  async function handleDisable() {
    const trimmed = reason.trim();
    if (!trimmed) return;
    setRunning(true);
    try {
      const result = await runBulk(targets.map(u => u.id), id => updateUserModeration(id, -1, trimmed));
      if (result.succeeded.length > 0) {
        toast.success(`Disabled ${result.succeeded.length} account${result.succeeded.length === 1 ? "" : "s"}`);
      }
      for (const f of result.failed) {
        const email = snapshot.find(u => u.id === f.id)?.email ?? f.id;
        toast.error(`${email}: ${f.error}`);
      }
      onDone();
    } finally {
      setRunning(false);
      setReason("");
      onOpenChange(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Disable {targets.length} account{targets.length === 1 ? "" : "s"}?
          </DialogTitle>
          <DialogDescription>
            These accounts won't be able to sign in until an administrator re-enables them.
            {suspended > 0 && ` ${suspended} currently suspended account${suspended === 1 ? " becomes" : "s become"} disabled indefinitely.`}
            {alreadyDisabled > 0 && ` ${alreadyDisabled} already-disabled account${alreadyDisabled === 1 ? " is" : "s are"} left unchanged.`}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2">
          <Label htmlFor="bulk-disable-reason">Moderation reason</Label>
          <Textarea
            id="bulk-disable-reason"
            value={reason}
            onChange={e => setReason(e.target.value)}
            placeholder="Explain why these accounts are being disabled."
            disabled={running}
          />
          <p className="text-xs text-muted-foreground">
            Stored in each account's moderation history and included in user export data.
          </p>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => handleOpenChange(false)} disabled={running}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={handleDisable}
            disabled={running || targets.length === 0 || !reason.trim()}
          >
            {running ? "Disabling..." : "Disable"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
