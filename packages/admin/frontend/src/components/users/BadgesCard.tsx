import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { updateUserBadges } from "@/lib/api";

const BADGE_DEVELOPER = 1 << 0;
const BADGE_BETA_TESTER = 1 << 1;

const KNOWN_BADGES: Array<{ bit: number; label: string; description: string }> = [
  { bit: BADGE_DEVELOPER, label: "Annex Developer", description: "Green code-xml badge on the profile card." },
  { bit: BADGE_BETA_TESTER, label: "Beta Tester", description: "Purple flask badge for users in the beta program." },
];
const ALL_KNOWN_BADGE_BITS = KNOWN_BADGES.reduce((acc, b) => acc | b.bit, 0);

export function BadgesCard({ userId, badges, onChanged }: { userId: string; badges: number; onChanged: () => void }) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const [pendingBadges, setPendingBadges] = useState(badges);
  const [rawInput, setRawInput] = useState(String(badges));
  const [saving, setSaving] = useState(false);

  // Keep local edit state in sync when the parent refetches after a save
  // (mirrors ProjectRow's effect on project.features). The closed card
  // would otherwise show a stale value until the sheet is reopened.
  useEffect(() => {
    setPendingBadges(badges);
    setRawInput(String(badges));
  }, [badges]);

  function handleSheetOpen(open: boolean) {
    setSheetOpen(open);
    if (open) {
      setPendingBadges(badges);
      setRawInput(String(badges));
    }
  }

  function setPending(next: number) {
    setPendingBadges(next);
    setRawInput(String(next));
  }

  function toggleBit(bit: number, checked: boolean) {
    setPending(checked ? pendingBadges | bit : pendingBadges & ~bit);
  }

  function handleRawChange(value: string) {
    setRawInput(value);
    const parsed = Number.parseInt(value, 10);
    if (Number.isInteger(parsed) && parsed >= 0) setPendingBadges(parsed);
  }

  async function handleApply() {
    const parsed = Number.parseInt(rawInput, 10);
    if (!Number.isInteger(parsed) || parsed < 0) {
      toast.error("Bitmask must be a non-negative integer");
      return;
    }
    setSaving(true);
    try {
      await updateUserBadges(userId, parsed);
      toast.success("Badges saved");
      onChanged();
      setSheetOpen(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to update badges");
    } finally {
      setSaving(false);
    }
  }

  const dirty = pendingBadges !== badges || rawInput !== String(badges);
  const activeKnown = KNOWN_BADGES.filter(b => (badges & b.bit) !== 0);
  const unknownBitsSaved = badges & ~ALL_KNOWN_BADGE_BITS;
  const unknownBitsPending = pendingBadges & ~ALL_KNOWN_BADGE_BITS;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Profile Badges</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {activeKnown.length === 0 && unknownBitsSaved === 0 ? (
            <span className="text-sm text-muted-foreground">No badges.</span>
          ) : (
            <>
              {activeKnown.map(b => (
                <Badge key={b.bit} variant="secondary">{b.label}</Badge>
              ))}
              {unknownBitsSaved !== 0 && (
                <Badge variant="outline" className="font-mono">unknown: 0b{unknownBitsSaved.toString(2)}</Badge>
              )}
            </>
          )}
          <span className="ml-auto font-mono text-xs text-muted-foreground">
            {badges} (0b{badges.toString(2)})
          </span>
        </div>

        <Sheet open={sheetOpen} onOpenChange={handleSheetOpen}>
          <SheetTrigger asChild>
            <Button size="sm" variant="outline">Edit badges</Button>
          </SheetTrigger>
          <SheetContent>
            <SheetHeader>
              <SheetTitle>Profile Badges</SheetTitle>
              <SheetDescription>{userId}</SheetDescription>
              <p className="text-sm text-muted-foreground pt-1">
                Toggle the known badges below or set the raw bitmask directly. Changes apply on save.
              </p>
            </SheetHeader>
            <SheetBody className="space-y-5">
              {KNOWN_BADGES.map(({ bit, label, description }) => (
                <div key={bit} className="flex items-start gap-3">
                  <Checkbox
                    id={`badge-${userId}-${bit}`}
                    checked={(pendingBadges & bit) !== 0}
                    onCheckedChange={checked => toggleBit(bit, checked === true)}
                    className="mt-0.5"
                  />
                  <div>
                    <Label htmlFor={`badge-${userId}-${bit}`} className="cursor-pointer font-medium">
                      {label}
                      <span className="ml-2 font-mono text-xs font-normal text-muted-foreground">
                        bit {Math.log2(bit)} · {bit}
                      </span>
                    </Label>
                    <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
                  </div>
                </div>
              ))}

              <div className="border-t pt-4">
                <Label htmlFor={`badges-raw-${userId}`} className="text-xs uppercase text-muted-foreground">
                  Raw bitmask
                </Label>
                <Input
                  id={`badges-raw-${userId}`}
                  type="number"
                  min={0}
                  step={1}
                  value={rawInput}
                  onChange={(e) => handleRawChange(e.target.value)}
                  className="mt-1.5 max-w-40 font-mono"
                />
                <p className="mt-1.5 font-mono text-xs text-muted-foreground">
                  pending: {pendingBadges} (0b{pendingBadges.toString(2)})
                </p>
                {unknownBitsPending !== 0 && (
                  <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
                    Pending value contains unknown bits: 0b{unknownBitsPending.toString(2)}. Will save but won't render.
                  </p>
                )}
              </div>
            </SheetBody>
            <SheetFooter>
              <Button className="w-full" onClick={handleApply} disabled={saving || !dirty}>
                {saving ? "Applying..." : "Apply"}
              </Button>
            </SheetFooter>
          </SheetContent>
        </Sheet>
      </CardContent>
    </Card>
  );
}
