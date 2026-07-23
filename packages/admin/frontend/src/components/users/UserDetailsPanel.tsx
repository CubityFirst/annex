import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DetailField } from "@/components/DetailField";
import { InkBillingCard } from "@/components/users/InkBillingCard";
import { BadgesCard } from "@/components/users/BadgesCard";
import type { AdminUserDetails } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { formatModerationAction, formatModerationUntil } from "@/lib/moderation";

export function StatusBadge({ status }: { status: "active" | "disabled" | "suspended" }) {
  if (status === "disabled") return <Badge variant="destructive">Disabled</Badge>;
  if (status === "suspended") return <Badge variant="secondary">Suspended</Badge>;
  return <Badge variant="default">Active</Badge>;
}

export function UserDetailsPanel({
  details,
  userId,
  userName,
  onChanged,
}: {
  details: AdminUserDetails;
  userId: string;
  userName: string;
  onChanged: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Account</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <DetailField label="Status" value={<StatusBadge status={details.profile.account_status} />} />
            <DetailField label="User ID" value={<span className="font-mono text-xs">{details.profile.id}</span>} />
            <DetailField label="Email" value={<span className="font-mono text-xs">{details.profile.email}</span>} />
            <DetailField
              label="Email Verified"
              value={details.profile.email_verified
                ? <Badge variant="default">Verified</Badge>
                : <Badge variant="outline" className="text-amber-600">Unverified</Badge>}
            />
            <DetailField label="Created" value={formatDateTime(details.profile.account_created_at)} />
            {details.profile.account_status === "suspended" && details.profile.account_suspended_until && (
              <DetailField
                label="Suspended Until"
                value={formatModerationUntil(details.profile.account_suspended_until)}
              />
            )}
            <DetailField
              label="Password Reset"
              value={details.profile.force_password_change ? "Required on next sign in" : "Not required"}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Security</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <DetailField
              label="TOTP"
              value={details.security.totp_enabled ? <Badge variant="default">Enabled</Badge> : <Badge variant="outline">Disabled</Badge>}
            />
            <DetailField
              label="Passkeys"
              value={`${details.security.passkeys.length} registered`}
            />
            <DetailField
              label="Backup Codes"
              value={`${details.security.backup_codes.active} active of ${details.security.backup_codes.total}`}
            />
            <DetailField
              label="Used Backup Codes"
              value={String(details.security.backup_codes.used)}
            />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Passkeys</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {details.security.passkeys.length === 0 ? (
            <p className="text-sm text-muted-foreground">No passkeys registered.</p>
          ) : (
            details.security.passkeys.map(passkey => (
              <div key={passkey.id} className="rounded-lg border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-medium">{passkey.name}</p>
                  <p className="text-xs text-muted-foreground">{formatDateTime(passkey.registered_at)}</p>
                </div>
                <p className="mt-2 font-mono text-xs text-muted-foreground">{passkey.id}</p>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <InkBillingCard userId={userId} userName={userName} details={details} onChanged={onChanged} />

      <BadgesCard userId={userId} badges={details.profile.badges} onChanged={onChanged} />

      <Card>
        <CardHeader>
          <CardTitle>Moderation History</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <DetailField
            label="Current Reason"
            value={details.moderation.current_reason ?? "No active moderation reason"}
          />
          {details.moderation.history.length === 0 ? (
            <p className="text-sm text-muted-foreground">No moderation events recorded.</p>
          ) : (
            details.moderation.history.map((event, index) => (
              <div key={`${event.created_at}-${index}`} className="rounded-lg border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Badge variant={event.action === "disabled" ? "destructive" : event.action === "suspended" ? "secondary" : "outline"}>
                      {formatModerationAction(event.action)}
                    </Badge>
                    <span className="text-xs text-muted-foreground">{formatDateTime(event.created_at)}</span>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {event.actor_email ?? event.actor_user_id ?? "System"}
                  </span>
                </div>
                {event.reason && <p className="mt-2 text-sm">{event.reason}</p>}
                <p className="mt-2 text-xs text-muted-foreground">
                  Stored moderation value: {event.moderation_value}
                  {event.moderation_value > 0 ? ` (${formatModerationUntil(event.moderation_value)})` : ""}
                </p>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Owned Projects</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {details.projects.owned_projects.length === 0 ? (
              <p className="text-sm text-muted-foreground">This user does not own any projects.</p>
            ) : (
              details.projects.owned_projects.map(project => (
                <div key={project.id} className="rounded-lg border p-3">
                  <p className="font-medium">{project.name}</p>
                  <p className="mt-1 font-mono text-xs text-muted-foreground">{project.id}</p>
                  <p className="mt-2 text-xs text-muted-foreground">Created {formatDateTime(project.created_at)}</p>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Project Memberships</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {details.projects.project_memberships.length === 0 ? (
              <p className="text-sm text-muted-foreground">This user has no project memberships.</p>
            ) : (
              details.projects.project_memberships.map(membership => (
                <div key={`${membership.project_id}-${membership.role}`} className="rounded-lg border p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-medium">{membership.project_name}</p>
                    <Badge variant="outline">{membership.role}</Badge>
                  </div>
                  <p className="mt-1 font-mono text-xs text-muted-foreground">{membership.project_id}</p>
                  <p className="mt-2 text-xs text-muted-foreground">Joined {formatDateTime(membership.joined_at)}</p>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
