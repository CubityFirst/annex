import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { BookOpen, Building2, Mail, MailCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { SettingsEmptyState } from "@/components/settings/SettingsShell";
import { ROLE_BADGE_CLASSES } from "@/lib/roleStyles";
import { useToast } from "@/hooks/use-toast";
import { getToken } from "@/lib/auth";
import { PAGE_PADDING, WIDE_CONTAINER } from "@/lib/pageContainer";

type Role = "limited" | "viewer" | "editor" | "admin" | "owner";

// Invites span both sites (projects) and orgs; `type` discriminates which.
interface PendingInvite {
  id: string;
  type: "site" | "org";
  role: Role;
  inviterName: string;
  createdAt: string;
  // site invites
  projectId?: string;
  projectName?: string;
  projectDescription?: string | null;
  // org invites
  organizationId?: string;
  organizationName?: string;
}

export function PendingInvitesPage() {
  const [invites, setInvites] = useState<PendingInvite[]>([]);
  const [acting, setActing] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState("");
  const navigate = useNavigate();
  const { toast } = useToast();

  useEffect(() => {
    const token = getToken();
    if (!token) return;
    // Cancel on unmount so a duplicate StrictMode-mount fetch that loses the
    // race (or fails) can't replace an already-loaded list with the error panel.
    let cancelled = false;
    fetch("/api/pending-invites", { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then((json: { ok: boolean; data?: PendingInvite[] }) => {
        if (cancelled) return;
        if (json.ok && json.data) setInvites(json.data);
        else setLoadError("Could not load your pending invites. Please try again.");
      })
      .catch(() => { if (!cancelled) setLoadError("Could not load your pending invites. Please try again."); });
    return () => { cancelled = true; };
  }, []);

  async function handleAccept(invite: PendingInvite) {
    const token = getToken();
    if (!token || acting) return;
    setActing(invite.id);
    try {
      const qs = invite.type === "org" ? "?type=org" : "";
      const res = await fetch(`/api/pending-invites/${invite.id}/accept${qs}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        setStatusMessage(`Accepted invite to ${(invite.type === "org" ? invite.organizationName : invite.projectName) ?? "this invite"}.`);
        setInvites(prev => prev.filter(i => i.id !== invite.id));
        navigate(invite.type === "org" ? `/orgs/${invite.organizationId}` : `/projects/${invite.projectId}`);
      } else {
        toast({ title: "Could not accept the invite.", description: "Please try again.", variant: "destructive" });
      }
    } catch {
      toast({ title: "Could not accept the invite.", description: "Please try again.", variant: "destructive" });
    } finally {
      setActing(null);
    }
  }

  async function handleDecline(invite: PendingInvite) {
    const token = getToken();
    if (!token || acting) return;
    setActing(invite.id);
    try {
      const qs = invite.type === "org" ? "?type=org" : "";
      const res = await fetch(`/api/pending-invites/${invite.id}${qs}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        setStatusMessage(`Declined invite to ${(invite.type === "org" ? invite.organizationName : invite.projectName) ?? "this invite"}.`);
        setInvites(prev => prev.filter(i => i.id !== invite.id));
      } else {
        toast({ title: "Could not decline the invite.", description: "Please try again.", variant: "destructive" });
      }
    } catch {
      toast({ title: "Could not decline the invite.", description: "Please try again.", variant: "destructive" });
    } finally {
      setActing(null);
    }
  }

  return (
    <div className={PAGE_PADDING}>
    <div className={WIDE_CONTAINER}>
      {/* Same wide index container as the dashboard (lib/pageContainer);
          title, muted line, then a divider spanning the measure the list
          below shares. */}
      <h1 className="text-[1.75rem] font-semibold leading-tight tracking-tight">Invites</h1>
      <p className="mt-1.5 text-sm text-muted-foreground">
        Pending invitations to sites and organizations. Accept or decline each one.
      </p>
      <Separator className="mb-8 mt-7" />

      <div aria-live="polite" className="sr-only">{statusMessage}</div>

      {loadError ? (
        <div role="alert">
          <SettingsEmptyState icon={Mail} title="Couldn't load invites" hint={loadError} />
        </div>
      ) : invites.length === 0 ? (
        <SettingsEmptyState icon={MailCheck} title="No pending invites" hint="You're all caught up." />
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border bg-card">
          {invites.map(invite => {
            const isOrg = invite.type === "org";
            const title = isOrg ? invite.organizationName : invite.projectName;
            return (
              <li key={invite.id} className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:gap-4">
                <div className="flex min-w-0 flex-1 items-start gap-3">
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-muted/40">
                    {isOrg
                      ? <Building2 className="size-4 text-muted-foreground" aria-hidden="true" />
                      : <BookOpen className="size-4 text-muted-foreground" aria-hidden="true" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <p className="truncate text-sm font-medium">{title}</p>
                      <Badge variant="outline" className={`shrink-0 text-xs font-medium ${ROLE_BADGE_CLASSES[invite.role]}`}>
                        {invite.role.charAt(0).toUpperCase() + invite.role.slice(1)}
                      </Badge>
                    </div>
                    {!isOrg && invite.projectDescription && (
                      <p className="mt-0.5 line-clamp-2 text-sm text-muted-foreground">{invite.projectDescription}</p>
                    )}
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {isOrg ? "Organization" : "Site"} · Invited by{" "}
                      <span className="font-medium text-foreground">{invite.inviterName}</span>
                    </p>
                  </div>
                </div>

                <div className="flex shrink-0 gap-2 sm:pl-0 pl-12">
                  <Button
                    variant="outline"
                    className="min-h-10 flex-1 sm:min-h-9 sm:flex-none"
                    onClick={() => handleDecline(invite)}
                    disabled={acting === invite.id}
                  >
                    Decline
                  </Button>
                  <Button
                    className="min-h-10 flex-1 sm:min-h-9 sm:flex-none"
                    onClick={() => handleAccept(invite)}
                    disabled={acting === invite.id}
                  >
                    Accept
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
    </div>
  );
}
