import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { BookOpen, Building2, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { getToken } from "@/lib/auth";

type Role = "limited" | "viewer" | "editor" | "admin" | "owner";

const ROLE_COLORS: Record<Role, string> = {
  owner: "bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-300",
  admin: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  editor: "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300",
  viewer: "bg-muted text-foreground",
  limited: "bg-muted text-foreground",
};

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

  useEffect(() => {
    const token = getToken();
    if (!token) return;
    fetch("/api/pending-invites", { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then((json: { ok: boolean; data?: PendingInvite[] }) => {
        if (json.ok && json.data) setInvites(json.data);
        else setLoadError("Could not load your pending invites. Please try again.");
      })
      .catch(() => setLoadError("Could not load your pending invites. Please try again."));
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
      }
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
      }
    } finally {
      setActing(null);
    }
  }

  return (
    <div className="px-4 py-8 sm:px-8 sm:py-10">
      <div className="mb-8">
        <h1 className="text-2xl font-bold tracking-tight">Pending Invites</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Accept or decline invitations to sites and organizations.
        </p>
      </div>

      <div aria-live="polite" className="sr-only">{statusMessage}</div>

      {loadError ? (
        <div role="alert" className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border py-20 text-center">
          <Mail className="mb-3 h-10 w-10 text-muted-foreground/40" aria-hidden="true" />
          <p className="text-sm font-medium">Couldn&apos;t load invites</p>
          <p className="mt-1 text-xs text-muted-foreground">{loadError}</p>
        </div>
      ) : invites.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border py-20 text-center">
          <Mail className="mb-3 h-10 w-10 text-muted-foreground/40" aria-hidden="true" />
          <p className="text-sm font-medium">No pending invites</p>
          <p className="mt-1 text-xs text-muted-foreground">
            You're all caught up.
          </p>
        </div>
      ) : (
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {invites.map(invite => {
            const isOrg = invite.type === "org";
            const title = isOrg ? invite.organizationName : invite.projectName;
            return (
              <Card key={invite.id} asChild className="flex flex-col">
              <li>
                <CardHeader className="flex-row items-start justify-between gap-3 pb-0">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10">
                      {isOrg ? <Building2 className="h-4 w-4 text-primary" aria-hidden="true" /> : <BookOpen className="h-4 w-4 text-primary" aria-hidden="true" />}
                    </div>
                    <div className="min-w-0">
                      <CardTitle className="truncate">{title}</CardTitle>
                      <p className="text-[11px] uppercase tracking-wide text-secondary-foreground">
                        {isOrg ? "Organization" : "Site"}
                      </p>
                    </div>
                  </div>
                  <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${ROLE_COLORS[invite.role]}`}>
                    {invite.role.charAt(0).toUpperCase() + invite.role.slice(1)}
                  </span>
                </CardHeader>

                <CardContent className="flex-1">
                  {!isOrg && invite.projectDescription && (
                    <p className="text-sm text-muted-foreground line-clamp-2">{invite.projectDescription}</p>
                  )}
                  <p className="mt-2 text-xs text-muted-foreground">
                    Invited by <span className="font-medium text-foreground">{invite.inviterName}</span>
                  </p>
                </CardContent>

                <CardFooter className="flex gap-2">
                  <Button
                    className="flex-1 min-h-11 sm:min-h-9"
                    onClick={() => handleAccept(invite)}
                    disabled={acting === invite.id}
                  >
                    Accept
                  </Button>
                  <Button
                    className="flex-1 min-h-11 sm:min-h-9"
                    variant="outline"
                    onClick={() => handleDecline(invite)}
                    disabled={acting === invite.id}
                  >
                    Decline
                  </Button>
                </CardFooter>
              </li>
              </Card>
            );
          })}
        </ul>
      )}
    </div>
  );
}
