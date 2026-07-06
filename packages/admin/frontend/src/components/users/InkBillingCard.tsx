import { useEffect, useRef, useState } from "react";
import { Gift, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import { DetailField } from "@/components/DetailField";
import {
  type AdminUserDetails,
  cancelUserSubscription,
  giftFreeMonth,
  grantInk,
  revokeGrantedInk,
} from "@/lib/api";
import { formatTimestampMs } from "@/lib/format";

type GrantExpiry = "forever" | "30d" | "1y";

const GRANT_EXPIRY_OPTIONS: Array<{ value: GrantExpiry; label: string }> = [
  { value: "forever", label: "Forever" },
  { value: "30d", label: "30 days" },
  { value: "1y", label: "1 year" },
];

interface InkBillingCardProps {
  userId: string;
  userName: string;
  details: AdminUserDetails;
  onChanged: () => void;
}

export function InkBillingCard({ userId, userName, details, onChanged }: InkBillingCardProps) {
  const billing = details.billing;
  const [grantOpen, setGrantOpen] = useState(false);
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [grantReason, setGrantReason] = useState("");
  const [grantExpiry, setGrantExpiry] = useState<GrantExpiry>("forever");
  const [cancelPaidSub, setCancelPaidSub] = useState(false);
  const [cancelMode, setCancelMode] = useState<"period_end" | "immediate">("period_end");
  const [pending, setPending] = useState(false);

  // Stripe applies the cancel via an async webhook, so a single fixed-delay
  // refetch can read stale billing if the webhook is slow. Refetch on a short
  // backoff schedule instead, and clear any pending timers on unmount.
  const refetchTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => { refetchTimers.current.forEach(clearTimeout); }, []);

  const hasPaidSub = !!billing.stripe.subscription_id;

  function planBadge() {
    if (billing.resolved_plan === "ink") {
      const label = billing.via === "granted" ? "Ink (granted)" : "Ink";
      return (
        <Badge className="border-amber-500/40 bg-amber-100/60 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
          <Sparkles className="size-3" />
          {label}
        </Badge>
      );
    }
    return <Badge variant="outline">Free</Badge>;
  }

  async function handleGrant() {
    const reason = grantReason.trim();
    if (!reason) {
      toast.error("Reason is required");
      return;
    }
    let expiresAt: number | null = null;
    if (grantExpiry === "30d") expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
    else if (grantExpiry === "1y") expiresAt = Date.now() + 365 * 24 * 60 * 60 * 1000;

    setPending(true);
    try {
      const result = await grantInk(userId, { reason, expiresAt, cancelExistingPaidSub: cancelPaidSub && hasPaidSub });
      if (result.cancelStripeWarning) {
        toast.warning(`Granted Ink, but Stripe cancel didn't apply: ${result.cancelStripeWarning}`);
      } else if (cancelPaidSub && hasPaidSub) {
        toast.success(`Granted Ink to ${userName} and cancelled their paid sub at period end`);
      } else {
        toast.success(`Granted Annex Ink to ${userName}`);
      }
      setGrantOpen(false);
      setGrantReason("");
      setGrantExpiry("forever");
      setCancelPaidSub(false);
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to grant Ink");
    } finally {
      setPending(false);
    }
  }

  async function handleRevoke() {
    setPending(true);
    try {
      await revokeGrantedInk(userId);
      toast.success("Ink grant revoked");
      setRevokeOpen(false);
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to revoke Ink grant");
    } finally {
      setPending(false);
    }
  }

  async function handleGiftMonth() {
    setPending(true);
    try {
      const result = await giftFreeMonth(userId);
      const amountStr = (result.amount / 100).toFixed(2);
      toast.success(`Credited ${userName} ${result.currency.toUpperCase()} ${amountStr} - applied to their next invoice`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to gift free month");
    } finally {
      setPending(false);
    }
  }

  async function handleCancelSubscription() {
    setPending(true);
    try {
      await cancelUserSubscription(userId, { immediate: cancelMode === "immediate" });
      toast.success(
        cancelMode === "immediate"
          ? `${userName}'s subscription has been cancelled immediately`
          : `${userName}'s subscription will cancel at the end of the current period`,
      );
      setCancelOpen(false);
      setCancelMode("period_end");
      // Refetch now, then again on a backoff to catch the async webhook once it
      // lands (a single fixed delay can read stale billing if it's slow).
      onChanged();
      refetchTimers.current.push(
        setTimeout(() => onChanged(), 2000),
        setTimeout(() => onChanged(), 5000),
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to cancel subscription");
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Billing</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid gap-4 md:grid-cols-2">
          <DetailField label="Current Plan" value={planBadge()} />
          <DetailField
            label="Source"
            value={billing.via === "granted" ? "Manual grant" : billing.via === "paid" ? "Stripe subscription" : "-"}
          />
          {billing.status && <DetailField label="Status" value={billing.status} />}
          {billing.started_at && (
            <DetailField label="Supporter Since" value={formatTimestampMs(billing.started_at)} />
          )}
          {billing.cancel_at && (
            <DetailField
              label="Cancels On"
              value={<span className="text-amber-700 dark:text-amber-400">{formatTimestampMs(billing.cancel_at)}</span>}
            />
          )}
          {billing.stripe.customer_id && (
            <DetailField
              label="Stripe Customer"
              value={<span className="font-mono text-xs">{billing.stripe.customer_id}</span>}
            />
          )}
          {billing.stripe.subscription_id && (
            <DetailField
              label="Stripe Subscription"
              value={<span className="font-mono text-xs">{billing.stripe.subscription_id}</span>}
            />
          )}
        </div>

        {billing.granted && (
          <div className="rounded-md border bg-amber-50/50 dark:bg-amber-950/20 p-3">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Active grant</p>
            <p className="mt-1 text-sm">
              {billing.granted.reason ?? "-"}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {billing.granted.expires_at
                ? `Expires ${formatTimestampMs(billing.granted.expires_at)}`
                : "No expiry - granted forever"}
            </p>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          {hasPaidSub && !billing.cancel_at && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button size="sm" variant="outline" disabled={pending}>
                  <Gift className="size-3.5" />
                  Gift free month
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Gift a free month?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This credits <strong>{userName}</strong>&apos;s Stripe balance with one month of their
                    current subscription price. The credit applies to their next invoice and cannot be
                    taken back from here.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={handleGiftMonth}>Gift month</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}

          {hasPaidSub && !billing.cancel_at && (
            <Dialog open={cancelOpen} onOpenChange={setCancelOpen}>
              <DialogTrigger asChild>
                <Button size="sm" variant="destructive" disabled={pending}>
                  Cancel paid subscription
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Cancel paid subscription</DialogTitle>
                  <DialogDescription>
                    Stops Stripe from billing <strong>{userName}</strong>. Plan flips to free when the corresponding
                    webhook arrives. If they have an active Ink grant, that overrides regardless and they keep Ink.
                  </DialogDescription>
                </DialogHeader>
                <RadioGroup
                  value={cancelMode}
                  onValueChange={v => setCancelMode(v as "period_end" | "immediate")}
                  className="flex flex-col gap-3"
                >
                  <Label
                    htmlFor="cancel-mode-period-end"
                    className="flex cursor-pointer items-start gap-3 rounded-md border p-3 font-normal"
                  >
                    <RadioGroupItem id="cancel-mode-period-end" value="period_end" className="mt-0.5" />
                    <div className="flex flex-col gap-1">
                      <span className="text-sm font-medium">At period end <span className="text-muted-foreground">(recommended)</span></span>
                      <span className="text-sm text-muted-foreground">
                        They keep access through the cycle they already paid for. Stripe stops billing after.
                      </span>
                    </div>
                  </Label>
                  <Label
                    htmlFor="cancel-mode-immediate"
                    className="flex cursor-pointer items-start gap-3 rounded-md border p-3 font-normal"
                  >
                    <RadioGroupItem id="cancel-mode-immediate" value="immediate" className="mt-0.5" />
                    <div className="flex flex-col gap-1">
                      <span className="text-sm font-medium">Immediately</span>
                      <span className="text-sm text-muted-foreground">
                        Access cuts off now. Useful for chargebacks / TOS violations. Stripe doesn't auto-refund the partial period.
                      </span>
                    </div>
                  </Label>
                </RadioGroup>
                <DialogFooter>
                  <Button type="button" variant="outline" onClick={() => setCancelOpen(false)} disabled={pending}>
                    Keep subscription
                  </Button>
                  <Button type="button" variant="destructive" onClick={handleCancelSubscription} disabled={pending}>
                    Cancel subscription
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          )}

          {billing.granted ? (
            <AlertDialog open={revokeOpen} onOpenChange={setRevokeOpen}>
              <AlertDialogTrigger asChild>
                <Button size="sm" variant="outline" disabled={pending}>
                  Revoke grant
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Revoke Ink grant?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This clears the manual grant for <strong>{userName}</strong>. If they have a paid Stripe sub,
                    they'll keep Ink via that. If not, they revert to free.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={handleRevoke}>Revoke</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          ) : (
            <Dialog open={grantOpen} onOpenChange={setGrantOpen}>
              <DialogTrigger asChild>
                <Button size="sm" variant="default" disabled={pending}>
                  <Sparkles className="size-3.5" />
                  Grant Ink
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Grant Annex Ink</DialogTitle>
                  <DialogDescription>
                    Comp <strong>{userName}</strong> a supporter subscription. Takes precedence over any
                    Stripe-managed plan in the resolver.
                  </DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-4">
                  <div className="flex flex-col gap-2">
                    <Label htmlFor={`grant-reason-${userId}`}>Reason</Label>
                    <Textarea
                      id={`grant-reason-${userId}`}
                      value={grantReason}
                      onChange={e => setGrantReason(e.target.value)}
                      placeholder="e.g. Early supporter, contest winner, outage credit"
                    />
                    <p className="text-xs text-muted-foreground">
                      Stored on the user row for audit. Required.
                    </p>
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label>Duration</Label>
                    <RadioGroup
                      value={grantExpiry}
                      onValueChange={v => setGrantExpiry(v as GrantExpiry)}
                      className="flex flex-wrap gap-2"
                    >
                      {GRANT_EXPIRY_OPTIONS.map(opt => (
                        <Label
                          key={opt.value}
                          htmlFor={`grant-expiry-${userId}-${opt.value}`}
                          className="flex cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-normal has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5"
                        >
                          <RadioGroupItem id={`grant-expiry-${userId}-${opt.value}`} value={opt.value} />
                          {opt.label}
                        </Label>
                      ))}
                    </RadioGroup>
                  </div>

                  {hasPaidSub && (
                    <label className="flex cursor-pointer items-start gap-3 rounded-md border p-3">
                      <Checkbox
                        checked={cancelPaidSub}
                        onCheckedChange={(v) => setCancelPaidSub(v === true)}
                      />
                      <div className="flex flex-col gap-1">
                        <span className="text-sm font-medium">Also cancel their paid Stripe subscription</span>
                        <span className="text-sm text-muted-foreground">
                          Sets cancel_at_period_end on the existing sub so they stop being billed at the end of the current cycle.
                          The grant keeps them on Ink either way.
                        </span>
                      </div>
                    </label>
                  )}
                </div>
                <DialogFooter>
                  <Button type="button" variant="outline" onClick={() => setGrantOpen(false)} disabled={pending}>
                    Cancel
                  </Button>
                  <Button type="button" onClick={handleGrant} disabled={pending || !grantReason.trim()}>
                    Grant
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
