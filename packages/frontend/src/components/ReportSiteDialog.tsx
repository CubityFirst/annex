import { useId, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { getToken } from "@/lib/auth";

const MAX_NOTE_LENGTH = 2000;

// "Report Site" flow for the published reading view. Anyone can file a report
// (no account needed); when the visitor has a session token it's sent along so
// the report is attributed to them server-side. Errors render inline - the
// public pages don't mount a toaster.
export function ReportSiteDialog({
  projectIdOrSlug,
  siteName,
  docId,
  open,
  onOpenChange,
}: {
  projectIdOrSlug: string;
  siteName: string;
  // The doc being viewed when the report was opened - sent along so the
  // moderation team can jump straight to the right page on a large site.
  docId?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const noteId = useId();

  function handleOpenChange(next: boolean) {
    onOpenChange(next);
    if (!next) {
      // Reset for the next open; a just-sent confirmation shouldn't linger.
      setNote("");
      setError(null);
      setSent(false);
      setSubmitting(false);
    }
  }

  async function handleSubmit() {
    const trimmed = note.trim();
    if (!trimmed) {
      setError("Please describe what you're reporting.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const token = getToken();
      const res = await fetch(`/api/public/projects/${encodeURIComponent(projectIdOrSlug)}/report`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ note: trimmed, ...(docId ? { docId } : {}) }),
      });
      const data = await res.json().catch(() => null) as { ok?: boolean; error?: string } | null;
      if (!res.ok || !data?.ok) {
        throw new Error(
          res.status === 429
            ? "Too many reports from your connection - please try again in a minute."
            : data?.error ?? "Failed to submit the report. Please try again.",
        );
      }
      setSent(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to submit the report. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        {sent ? (
          <>
            <DialogHeader>
              <DialogTitle>Report submitted</DialogTitle>
              <DialogDescription>
                Thanks - your report about {siteName} has been sent to the moderation team for review.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button onClick={() => handleOpenChange(false)}>Close</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Report this site</DialogTitle>
              <DialogDescription>
                Flag {siteName} for the moderation team: abuse, illegal content, spam, or
                anything else that shouldn't be here.
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-2">
              <Label htmlFor={noteId}>What&apos;s wrong?</Label>
              <Textarea
                id={noteId}
                value={note}
                onChange={e => setNote(e.target.value)}
                maxLength={MAX_NOTE_LENGTH}
                rows={5}
                placeholder="Which page, and what did you see?"
                aria-describedby={`${noteId}-count`}
                aria-invalid={error ? true : undefined}
                disabled={submitting}
              />
              <div className="flex items-start justify-between gap-3 text-xs">
                {/* role=alert so a failed submit is announced, not just painted. */}
                <p role="alert" className="text-sm text-destructive">{error}</p>
                <p id={`${noteId}-count`} className="shrink-0 tabular-nums text-muted-foreground">
                  {note.length} / {MAX_NOTE_LENGTH}
                </p>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={submitting}>
                Cancel
              </Button>
              {/* Filing a report deletes nothing, so it's the dialog's normal
                  primary action rather than a red destructive one. */}
              <Button
                onClick={() => void handleSubmit()}
                disabled={submitting || !note.trim()}
              >
                {submitting ? "Submitting…" : "Submit report"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
