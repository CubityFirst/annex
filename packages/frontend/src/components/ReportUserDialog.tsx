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

// "Report user" flow for the profile card. Requires a signed-in session (the
// card only renders inside the app), so every user report carries a real
// reporter. Errors render inline - the card can be open on pages without a
// toaster.
export function ReportUserDialog({
  userId,
  userName,
  open,
  onOpenChange,
}: {
  userId: string;
  userName: string;
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
      const res = await fetch(`/api/users/${encodeURIComponent(userId)}/report`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${getToken()}`,
        },
        body: JSON.stringify({ note: trimmed }),
      });
      const data = await res.json().catch(() => null) as { ok?: boolean; error?: string } | null;
      if (!res.ok || !data?.ok) {
        throw new Error(
          res.status === 429
            ? "Too many reports - please try again in a minute."
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
                Thanks - your report about {userName} has been sent to the moderation team for review.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button onClick={() => handleOpenChange(false)}>Close</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Report this user</DialogTitle>
              <DialogDescription>
                Report {userName} to the moderation team. Tell us what's wrong - abuse,
                harassment, impersonation, or anything else that breaks the rules.
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
