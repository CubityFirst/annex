import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DetailField } from "@/components/DetailField";
import { updateUserHandle } from "@/lib/api";
import { DOCS_APP_ORIGIN } from "@/lib/docsOrigin";

// Moderation for the opt-in `/@handle` profile link (auth `user_preferences.
// handle` / `handle_locked`). Admins can assign any well-formed name -
// including reserved ones the user couldn't pick - clear it, and lock it so
// the user can't change it from their own settings.
export function ProfileLinkCard({
  userId,
  handle,
  locked,
  onChanged,
}: {
  userId: string;
  handle: string | null;
  locked: boolean;
  onChanged: () => void;
}) {
  const [draft, setDraft] = useState(handle ?? "");
  const [busy, setBusy] = useState(false);

  // Follow the parent's refetch after a save.
  useEffect(() => { setDraft(handle ?? ""); }, [handle]);

  async function apply(patch: { handle?: string | null; locked?: boolean }, success: string) {
    setBusy(true);
    try {
      await updateUserHandle(userId, patch);
      toast.success(success);
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to update profile link");
    } finally {
      setBusy(false);
    }
  }

  const normalizedDraft = draft.trim().replace(/^@/, "").toLowerCase();
  const dirty = normalizedDraft !== (handle ?? "");

  return (
    <Card>
      <CardHeader>
        <CardTitle>Profile Link</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <DetailField
            label="Link"
            value={handle ? (
              <a
                href={`${DOCS_APP_ORIGIN}/@${handle}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 font-mono text-xs hover:underline"
              >
                /@{handle}
                <ExternalLink className="size-3" />
              </a>
            ) : (
              <span className="text-muted-foreground">Off</span>
            )}
          />
          <DetailField
            label="User Can Change"
            value={locked ? <Badge variant="secondary">Locked by admin</Badge> : <Badge variant="outline">Yes</Badge>}
          />
        </div>

        <form
          className="flex flex-col gap-1.5"
          onSubmit={e => {
            e.preventDefault();
            if (!dirty || !normalizedDraft) return;
            void apply({ handle: normalizedDraft }, `Profile link set to /@${normalizedDraft}`);
          }}
        >
          <Label htmlFor={`handle-${userId}`} className="text-xs uppercase text-muted-foreground">Username</Label>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-40 flex-1">
              <span aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">@</span>
              <Input
                id={`handle-${userId}`}
                value={draft}
                onChange={e => setDraft(e.target.value)}
                placeholder="username"
                autoComplete="off"
                spellCheck={false}
                className="pl-7 font-mono"
              />
            </div>
            <Button type="submit" size="sm" variant="outline" disabled={busy || !dirty || !normalizedDraft}>
              {handle ? "Rename" : "Assign"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy || !handle}
              onClick={() => apply({ handle: null }, "Profile link cleared")}
            >
              Clear
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Reserved names (e.g. admin, support) can be assigned here; users can't pick them themselves.
          </p>
        </form>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
          <div className="flex items-start gap-3">
            <Checkbox
              id={`handle-locked-${userId}`}
              checked={locked}
              disabled={busy}
              onCheckedChange={checked => apply(
                { locked: checked === true },
                checked === true ? "Profile link locked" : "Profile link unlocked",
              )}
              className="mt-0.5"
            />
            <div>
              <Label htmlFor={`handle-locked-${userId}`} className="cursor-pointer font-medium">Lock</Label>
              <p className="mt-0.5 text-xs text-muted-foreground">
                The user can't set, change or clear their profile link while locked.
              </p>
            </div>
          </div>
          {handle && !locked && (
            <Button
              type="button"
              size="sm"
              variant="destructive"
              disabled={busy}
              onClick={() => apply({ handle: null, locked: true }, "Profile link cleared and locked")}
            >
              Clear &amp; lock
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
