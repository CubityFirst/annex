import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
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
                Report {siteName} to the moderation team. Tell us what's wrong - abuse, illegal
                content, spam, or anything else that shouldn't be here.
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-1.5">
              <Textarea
                value={note}
                onChange={e => setNote(e.target.value)}
                maxLength={MAX_NOTE_LENGTH}
                rows={5}
                placeholder="What are you reporting, and why?"
                aria-label="Report justification"
                disabled={submitting}
              />
              {error && <p className="text-sm text-destructive">{error}</p>}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={submitting}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={() => void handleSubmit()}
                disabled={submitting || !note.trim()}
              >
                {submitting ? "Submitting..." : "Submit report"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
