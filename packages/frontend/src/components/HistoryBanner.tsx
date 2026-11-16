import { useState } from "react";
import { History } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";

// Ghost buttons tinted to the banner instead of the neutral accent hover.
const BANNER_GHOST = "text-amber-900 hover:bg-amber-200/60 hover:text-amber-950 dark:text-amber-200 dark:hover:bg-amber-900/50 dark:hover:text-amber-100";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

interface Props {
  editorName: string;
  createdAt: string;
  /** Doc title at this revision, when it differs from the live title. */
  title?: string | null;
  onBack: () => void;
  onRevert?: () => void;
  reverting?: boolean;
  /** When set, a "View changes"/"View document" toggle is shown. */
  showingDiff?: boolean;
  onToggleDiff?: () => void;
  className?: string;
}

export function HistoryBanner({ editorName, createdAt, title, onBack, onRevert, reverting, showingDiff, onToggleDiff, className }: Props) {
  const [confirmOpen, setConfirmOpen] = useState(false);

  return (
    <>
      {/* One sentence that says where you are, then real buttons in a
          clear order: look (View changes), leave (Back to live), act
          (Revert - the only filled one). Underlined text links read as
          prose and wrapped off the edge on phones. */}
      <div className={`flex flex-col gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 sm:flex-row sm:items-center dark:border-amber-800/70 dark:bg-amber-950/40 dark:text-amber-200 ${className ?? ""}`}>
        <div className="flex min-w-0 flex-1 items-start gap-2.5">
          <History className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-400" aria-hidden="true" />
          <p className="min-w-0 text-pretty">
            Viewing the version <strong className="font-semibold">{editorName}</strong> saved on {formatDate(createdAt)}.
            {title && <> Titled &ldquo;<strong className="font-semibold">{title}</strong>&rdquo; at the time.</>}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 max-sm:pl-6.5 max-sm:[&>button:first-child]:-ml-3 sm:shrink-0">
          {onToggleDiff && (
            <Button variant="ghost" size="sm" onClick={onToggleDiff} className={BANNER_GHOST}>
              {showingDiff ? "View document" : "View changes"}
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={onBack} className={BANNER_GHOST}>
            Back to live
          </Button>
          {onRevert && (
            <Button size="sm" onClick={() => setConfirmOpen(true)} className="border border-amber-400/70 bg-amber-200/60 font-semibold text-amber-950 shadow-none hover:bg-amber-200 dark:border-amber-500/40 dark:bg-amber-400/15 dark:text-amber-100 dark:hover:bg-amber-400/25">
              Revert to this version
            </Button>
          )}
        </div>
      </div>

      {onRevert && (
        <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Revert to this version?</AlertDialogTitle>
              <AlertDialogDescription>
                This will restore the document&apos;s content and title to the version saved by <strong>{editorName}</strong> on {formatDate(createdAt)}. The current state will be saved as a new revision in history.
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
