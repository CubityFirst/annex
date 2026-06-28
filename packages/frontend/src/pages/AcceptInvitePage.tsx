import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { getToken } from "@/lib/auth";

type Role = "limited" | "viewer" | "editor" | "admin" | "owner";

const ROLE_LABELS: Record<Role, string> = {
  limited: "Limited",
  viewer: "Viewer",
  editor: "Editor",
  admin: "Admin",
  owner: "Owner",
};

const ROLE_COLORS: Record<Role, string> = {
  owner: "bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-300",
  admin: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  editor: "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300",
  viewer: "bg-muted text-foreground",
  limited: "bg-muted text-foreground",
};

interface InviteInfo {
  projectId: string;
  projectName: string;
  ownerName: string;
  role: Role;
  maxUses: number | null;
  useCount: number;
  expiresAt: string | null;
  isActive: boolean;
}

export function AcceptInvitePage() {
  const { token: inviteToken } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const authToken = getToken();
  const isLoggedIn = !!authToken;

  const [info, setInfo] = useState<InviteInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [accepting, setAccepting] = useState(false);
  const [alreadyMember, setAlreadyMember] = useState(false);
  const [alreadyProjectId, setAlreadyProjectId] = useState<string | null>(null);

  useEffect(() => {
    if (!inviteToken) return;
    fetch(`/api/invites/${inviteToken}`)
      .then(r => r.json())
      .then((json: { ok: boolean; data?: InviteInfo; error?: string }) => {
        if (json.ok && json.data) {
          setInfo(json.data);
          if (!json.data.isActive) {
            setError("This invite link has been revoked.");
          } else if (json.data.expiresAt && new Date(json.data.expiresAt) < new Date()) {
            setError("This invite link has expired.");
          } else if (json.data.maxUses !== null && json.data.useCount >= json.data.maxUses) {
            setError("This invite link has reached its maximum uses.");
          }
        } else {
          setError("This invite link is invalid or no longer exists.");
        }
      })
      .catch(() => setError("Could not load invite details. Please try again."))
      .finally(() => setLoading(false));
  }, [inviteToken]);

  async function handleAccept() {
    if (!inviteToken) return;

    if (!isLoggedIn) {
      navigate("/login", { state: { from: `/invite/${inviteToken}` } });
      return;
    }

    setAccepting(true);
    try {
      const res = await fetch(`/api/invites/${inviteToken}/accept`, {
        method: "POST",
        headers: { Authorization: `Bearer ${authToken}` },
      });
      const json = await res.json() as {
        ok: boolean;
        data?: { projectId: string; alreadyMember?: boolean; role?: Role };
        error?: string;
      };
      if (json.ok && json.data) {
        if (json.data.alreadyMember) {
          setAlreadyMember(true);
          setAlreadyProjectId(json.data.projectId);
        } else {
          navigate(`/projects/${json.data.projectId}`);
        }
      } else {
        setError(json.error ?? "Failed to accept invite. Please try again.");
      }
    } catch {
      setError("Could not connect to the server. Please try again.");
    } finally {
      setAccepting(false);
    }
  }

  function handleDecline() {
    if (isLoggedIn) {
      navigate("/dashboard");
    } else {
      navigate("/");
    }
  }

  const projectLetter = info?.projectName?.charAt(0).toUpperCase() ?? "?";

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm">
        {loading ? (
          <div className="flex flex-col items-center gap-4 text-center" aria-live="polite" aria-busy="true">
            <span className="sr-only">Loading invite…</span>
            <div className="size-16 rounded-2xl bg-muted animate-pulse" />
            <div className="h-5 w-48 bg-muted animate-pulse rounded" />
          </div>
        ) : error && !alreadyMember ? (
          <div role="alert" className="flex flex-col items-center gap-6 text-center rounded-xl border border-border bg-card p-8 shadow-sm">
            <div className="size-16 rounded-2xl bg-muted flex items-center justify-center text-2xl font-bold text-muted-foreground">
              ?
            </div>
            <div className="flex flex-col gap-2">
              <h1 className="text-xl font-semibold">Invalid invite</h1>
              <p className="text-sm text-muted-foreground">{error}</p>
            </div>
            <Button variant="outline" onClick={handleDecline}>
              {isLoggedIn ? "Go to dashboard" : "Go to homepage"}
            </Button>
          </div>
        ) : alreadyMember ? (
          <div className="flex flex-col items-center gap-6 text-center rounded-xl border border-border bg-card p-8 shadow-sm">
            <div
              className="size-16 rounded-2xl flex items-center justify-center text-2xl font-bold text-white"
              style={{ background: "linear-gradient(135deg, #6366f1, #8b5cf6)" }}
            >
              {projectLetter}
            </div>
            <div className="flex flex-col gap-2">
              <h1 className="text-xl font-semibold">{info?.projectName}</h1>
              <p className="text-sm text-muted-foreground">You&apos;re already a member of this project.</p>
            </div>
            <Button onClick={() => navigate(`/projects/${alreadyProjectId}`)}>
              Go to project
            </Button>
          </div>
        ) : info ? (
          <div className="flex flex-col items-center gap-6 text-center rounded-xl border border-border bg-card p-8 shadow-sm">
            <div
              className="size-16 rounded-2xl flex items-center justify-center text-2xl font-bold text-white"
              style={{ background: "linear-gradient(135deg, #6366f1, #8b5cf6)" }}
            >
              {projectLetter}
            </div>

            <div className="flex flex-col gap-2">
              <p className="text-sm text-muted-foreground">You&apos;ve been invited to join</p>
              <h1 className="text-2xl font-bold">{info.projectName}</h1>
              <p className="text-sm text-muted-foreground">Invited by {info.ownerName}</p>
              <div className="flex justify-center mt-1">
                <Badge variant="outline" className={`text-xs font-medium ${ROLE_COLORS[info.role]}`}>
                  {ROLE_LABELS[info.role]}
                </Badge>
              </div>
            </div>

            <div className="flex flex-col gap-2 w-full">
              <Button onClick={handleAccept} disabled={accepting} className="w-full">
                {accepting ? "Joining…" : isLoggedIn ? "Accept" : "Sign in to accept"}
              </Button>
              <Button variant="ghost" onClick={handleDecline} className="w-full">
                Not now
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
