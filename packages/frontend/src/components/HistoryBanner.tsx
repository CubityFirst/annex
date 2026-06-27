import { useState } from "react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

interface Props {
  editorName: string;
  createdAt: string;
  onBack: () => void;
  onRevert?: () => void;
  reverting?: boolean;
  className?: string;
}

export function HistoryBanner({ editorName, createdAt, onBack, onRevert, reverting, className }: Props) {
  const [confirmOpen, setConfirmOpen] = useState(false);

  return (
    <>
      <div className={`flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950/50 dark:text-amber-300 ${className ?? ""}`}>
        <span className="flex-1 min-w-0">
          Historical version saved by <strong>{editorName}</strong> on {formatDate(createdAt)}.
        </span>
        <div className="flex items-center gap-x-4 gap-y-1 shrink-0">
          {onRevert && (
            <button
              onClick={() => setConfirmOpen(true)}
              className="inline-flex items-center min-h-11 px-1 -mx-1 font-medium underline underline-offset-2 hover:no-underline"
            >
              Revert to this version
            </button>
          )}
          <button
            onClick={onBack}
            className="inline-flex items-center min-h-11 px-1 -mx-1 font-medium underline underline-offset-2 hover:no-underline"
          >
            Back to live
          </button>
        </div>
      </div>

      {onRevert && (
        <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Revert to this version?</AlertDialogTitle>
              <AlertDialogDescription>
                This will replace the current content with the version saved by <strong>{editorName}</strong> on {formatDate(createdAt)}. The current state will be saved as a new revision in history.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={reverting}>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={onRevert} disabled={reverting}>
                {reverting ? "Reverting…" : "Revert"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </>
  );
}
