import { useState, useEffect } from "react";
import { useParams, useNavigate, useOutletContext } from "react-router-dom";
import { UserAvatar } from "@/components/UserAvatar";
import { UserProfileCard } from "@/components/UserProfileCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { apiFetchJson } from "@/lib/apiFetch";
import type { DocsLayoutContext } from "@/layouts/DocsLayout";
import { SettingsShell, type SettingsGroupDef, type SettingsSectionDef } from "@/components/settings/SettingsShell";

type Role = "viewer" | "editor" | "admin" | "owner";

const ROLE_LABELS: Record<Role, string> = {
  viewer: "Viewer",
  editor: "Editor",
  admin: "Admin",
  owner: "Owner",
};

const ROLE_DESCRIPTIONS: Record<Role, string> = {
  viewer: "Can read every site in the organization",
  editor: "Can create and edit docs across the org's sites",
  admin: "Can manage org members and attach/detach sites",
  owner: "Full control, including deleting the organization",
};

const ROLE_RANK: Record<Role, number> = { viewer: 0, editor: 1, admin: 2, owner: 3 };
const ASSIGNABLE_ROLES: Role[] = ["viewer", "editor", "admin"];

const ORG_SETTINGS_GROUPS: SettingsGroupDef[] = [
  { id: "org", label: "Organization" },
  { id: "people", label: "People" },
  { id: "sites", label: "Sites" },
  { id: "danger", label: "Danger Zone" },
];

interface OrgDetail {
  id: string;
  name: string;
  role: Role;
}

interface OrgMember {
  id: string;
  userId: string;
  email: string;
  name: string;
  role: Role;
  accepted: boolean;
  personalPlan?: "free" | "ink";
  personalPlanStyle?: string | null;
}

interface OrgSite {
  id: string;
  name: string;
}

interface OwnedSite {
  id: string;
  name: string;
  role: string;
  organization_id: string | null;
}

function RoleBadge({ role }: { role: Role }) {
  return <Badge variant="secondary" className="capitalize">{ROLE_LABELS[role]}</Badge>;
}

export function OrgSettingsPage() {
  const { orgId } = useParams<{ orgId: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { currentUser } = useOutletContext<DocsLayoutContext>();

  const [org, setOrg] = useState<OrgDetail | null>(null);
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [sites, setSites] = useState<OrgSite[]>([]);
  const [attachable, setAttachable] = useState<OwnedSite[]>([]);
  const [notFound, setNotFound] = useState(false);

  const [nameDraft, setNameDraft] = useState("");
  const [savingName, setSavingName] = useState(false);

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<Role>("viewer");
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const [attachId, setAttachId] = useState<string>("");
  const [attaching, setAttaching] = useState(false);

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [leaveOpen, setLeaveOpen] = useState(false);

  const myRole = org?.role ?? null;
  const isOwner = myRole === "owner";
  const isAdmin = myRole === "admin" || myRole === "owner";

  useEffect(() => {
    if (!orgId) return;
    apiFetchJson<OrgDetail>(`/api/organizations/${orgId}`)
      .then(result => {
        if (result.redirected) return;
        if (result.status === 404 || result.status === 403) { setNotFound(true); return; }
        if (result.ok && result.data) { setOrg(result.data); setNameDraft(result.data.name); }
      })
      .catch(() => {});
    apiFetchJson<OrgSite[]>(`/api/organizations/${orgId}/projects`)
      .then(result => { if (result.ok && result.data) setSites(result.data); })
      .catch(() => {});
  }, [orgId]);

  // Admin-only data (member list + attachable sites). Loaded once we know the role.
  useEffect(() => {
    if (!orgId || !isAdmin) return;
    apiFetchJson<OrgMember[]>(`/api/organizations/${orgId}/members`)
      .then(result => { if (result.ok && result.data) setMembers(result.data); })
      .catch(() => {});
    apiFetchJson<OwnedSite[]>("/api/projects")
      .then(result => {
        if (result.ok && result.data) {
          setAttachable(result.data.filter(p => p.role === "owner" && p.organization_id == null));
        }
      })
      .catch(() => {});
  }, [orgId, isAdmin]);

  async function handleRename() {
    if (!orgId || !nameDraft.trim()) return;
    setSavingName(true);
    try {
      const result = await apiFetchJson<OrgDetail>(`/api/organizations/${orgId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: nameDraft.trim() }),
      });
      if (result.ok && result.data) {
        setOrg(prev => prev ? { ...prev, name: result.data!.name } : prev);
        toast({ title: "Organization renamed." });
      } else {
        toast({ title: "Failed to rename.", variant: "destructive" });
      }
    } finally {
      setSavingName(false);
    }
  }

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    if (!orgId || !inviteEmail) return;
    setInviting(true);
    setInviteError(null);
    const result = await apiFetchJson<OrgMember>(`/api/organizations/${orgId}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: inviteEmail, role: inviteRole }),
    });
    if (result.ok && result.data) {
      setMembers(prev => [...prev, result.data!]);
      setInviteEmail("");
      toast({ title: `Invite sent to ${result.data.email}.` });
    } else {
      setInviteError(result.error ?? "Failed to add member.");
    }
    setInviting(false);
  }

  async function handleRoleChange(member: OrgMember, newRole: Role) {
    if (!orgId) return;
    const result = await apiFetchJson<OrgMember>(`/api/organizations/${orgId}/members/${member.userId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: newRole }),
    });
    if (result.ok && result.data) {
      setMembers(prev => prev.map(m => m.userId === member.userId ? { ...m, role: newRole } : m));
      toast({ title: `${member.name}'s role updated to ${ROLE_LABELS[newRole]}.` });
    } else {
      toast({ title: "Failed to update role.", variant: "destructive" });
    }
  }

  async function handleRemove(member: OrgMember) {
    if (!orgId) return;
    setRemovingId(member.userId);
    const result = await apiFetchJson(`/api/organizations/${orgId}/members/${member.userId}`, { method: "DELETE" });
    if (result.ok) {
      setMembers(prev => prev.filter(m => m.userId !== member.userId));
      toast({ title: member.accepted ? `${member.name} removed.` : `Invite to ${member.email} canceled.` });
    } else {
      toast({ title: "Failed to remove member.", variant: "destructive" });
    }
    setRemovingId(null);
  }

  async function handleAttach() {
    if (!orgId || !attachId) return;
    setAttaching(true);
    const result = await apiFetchJson(`/api/organizations/${orgId}/projects/${attachId}/attach`, { method: "POST" });
    if (result.ok) {
      const site = attachable.find(s => s.id === attachId);
      if (site) setSites(prev => [...prev, { id: site.id, name: site.name }]);
      setAttachable(prev => prev.filter(s => s.id !== attachId));
      setAttachId("");
      toast({ title: "Site attached to organization." });
    } else {
      toast({ title: result.status === 409 ? "That site is already in another organization." : "Failed to attach site.", variant: "destructive" });
    }
    setAttaching(false);
  }

  async function handleDetach(site: OrgSite) {
    if (!orgId) return;
    const result = await apiFetchJson(`/api/organizations/${orgId}/projects/${site.id}/attach`, { method: "DELETE" });
    if (result.ok) {
      setSites(prev => prev.filter(s => s.id !== site.id));
      toast({ title: `${site.name} detached.` });
    } else {
      toast({ title: "Failed to detach site.", variant: "destructive" });
    }
  }

  async function handleDelete() {
    if (!orgId) return;
    const result = await apiFetchJson(`/api/organizations/${orgId}`, { method: "DELETE" });
    if (result.ok) navigate("/dashboard");
  }

  async function handleLeave() {
    if (!orgId || !currentUser) return;
    const result = await apiFetchJson(`/api/organizations/${orgId}/members/${currentUser.id}`, { method: "DELETE" });
    if (result.ok) navigate("/dashboard");
  }

  if (notFound) {
    return (
      <div className="px-8 py-10">
        <p className="text-sm text-muted-foreground">Organization not found, or you don't have access.</p>
        <Button variant="outline" size="sm" className="mt-4" onClick={() => navigate("/dashboard")}>Back to dashboard</Button>
      </div>
    );
  }

  const settingsSections: SettingsSectionDef[] = [
    { id: "general", label: "General", group: "org" },
    { id: "members", label: "Members", group: "people", visible: isAdmin },
    { id: "sites", label: "Sites", group: "sites", visible: isAdmin },
    { id: "danger", label: "Danger Zone", group: "danger", danger: true },
  ];

  return (
    <SettingsShell
      title="Organization Settings"
      description={org ? org.name : undefined}
      groups={ORG_SETTINGS_GROUPS}
      sections={settingsSections}
    >
      <div>
        {/* General */}
        <div id="general" className="flex flex-col gap-4">
          <div>
            <h3 className="text-base font-semibold">General</h3>
            <p className="mt-1 text-sm text-muted-foreground">The organization's name.</p>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="org-name">Name</Label>
            <div className="flex gap-2">
              <Input
                id="org-name"
                value={nameDraft}
                onChange={e => setNameDraft(e.target.value)}
                disabled={!isAdmin}
                className="max-w-sm"
              />
              {isAdmin && (
                <Button
                  onClick={handleRename}
                  disabled={savingName || !nameDraft.trim() || nameDraft.trim() === org?.name}
                >
                  {savingName ? "Saving…" : "Save"}
                </Button>
              )}
            </div>
          </div>
        </div>

        {/* Members */}
        {isAdmin && (
          <>
            <Separator className="my-10" />
            <div id="members" className="flex flex-col gap-6">
              <div>
                <h3 className="text-base font-semibold">Members</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  Members of this organization get their role on every site in it.
                </p>
              </div>

              <div className="rounded-md border border-border bg-muted/40 p-4">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Permission levels</p>
                <div className="flex flex-col gap-1.5">
                  {(["viewer", "editor", "admin", "owner"] as Role[]).map(role => (
                    <div key={role} className="flex items-center gap-2 text-sm">
                      <RoleBadge role={role} />
                      <span className="text-muted-foreground">{ROLE_DESCRIPTIONS[role]}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Invite */}
              <form onSubmit={handleInvite} className="flex flex-col gap-3 sm:flex-row sm:items-end">
                <div className="flex flex-1 flex-col gap-1.5">
                  <Label htmlFor="invite-email">Invite by email</Label>
                  <Input
                    id="invite-email"
                    type="email"
                    placeholder="teammate@example.com"
                    value={inviteEmail}
                    onChange={e => setInviteEmail(e.target.value)}
                    required
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>Role</Label>
                  <Select value={inviteRole} onValueChange={v => setInviteRole(v as Role)}>
                    <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {(isOwner ? ASSIGNABLE_ROLES : ASSIGNABLE_ROLES.filter(r => ROLE_RANK[r] < ROLE_RANK["admin"])).map(role => (
                        <SelectItem key={role} value={role}>{ROLE_LABELS[role]}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Button type="submit" disabled={inviting}>{inviting ? "Inviting…" : "Invite"}</Button>
              </form>
              {inviteError && <p className="text-sm text-destructive">{inviteError}</p>}

              {/* Member list */}
              <div className="flex flex-col divide-y divide-border rounded-md border border-border">
                {members.map(member => {
                  const isMe = member.userId === currentUser?.id;
                  const isPending = !member.accepted;
                  const canManage = isOwner || (myRole === "admin" && ROLE_RANK[member.role] < ROLE_RANK["admin"]);
                  const canChangeRole = !isPending && canManage && member.role !== "owner" && !isMe;
                  const canRemove = canManage && member.role !== "owner" && !isMe;

                  return (
                    <div key={member.userId} className="flex items-center gap-3 px-4 py-3">
                      <UserProfileCard userId={member.userId} name={member.name}>
                        <button type="button" className="-mx-1 flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded px-1 py-0.5 text-left transition-colors hover:bg-muted/50">
                          <UserAvatar userId={member.userId} name={member.name} className="size-8 shrink-0 text-xs" personalPlan={member.personalPlan} personalPlanStyle={member.personalPlanStyle} />
                          <div className="flex min-w-0 flex-1 flex-col">
                            <span className="truncate text-sm font-medium">
                              {member.name}
                              {isMe && <span className="ml-1.5 text-xs text-muted-foreground">(you)</span>}
                            </span>
                            <span className="truncate text-xs text-muted-foreground">{member.email}</span>
                          </div>
                        </button>
                      </UserProfileCard>

                      <div className="flex shrink-0 items-center gap-3">
                        {isPending ? (
                          <Badge variant="outline" className="text-xs font-medium bg-yellow-100 text-yellow-700 border-yellow-300 dark:bg-yellow-950 dark:text-yellow-300 dark:border-yellow-800">
                            Pending
                          </Badge>
                        ) : canChangeRole ? (
                          <Select value={member.role} onValueChange={val => handleRoleChange(member, val as Role)}>
                            <SelectTrigger className="h-9 w-28 text-xs sm:h-7"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              {(isOwner ? ASSIGNABLE_ROLES : ASSIGNABLE_ROLES.filter(r => ROLE_RANK[r] < ROLE_RANK["admin"])).map(role => (
                                <SelectItem key={role} value={role} className="text-xs">{ROLE_LABELS[role]}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : (
                          <RoleBadge role={member.role} />
                        )}

                        {canRemove && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-9 sm:h-7 px-2.5 text-xs text-muted-foreground hover:text-destructive"
                            disabled={removingId === member.userId}
                            onClick={() => handleRemove(member)}
                          >
                            {removingId === member.userId ? (isPending ? "Canceling…" : "Removing…") : (isPending ? "Cancel" : "Remove")}
                          </Button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </>
        )}

        {/* Sites */}
        {isAdmin && (
          <>
            <Separator className="my-10" />
            <div id="sites" className="flex flex-col gap-6">
              <div>
                <h3 className="text-base font-semibold">Sites</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  Sites in this organization. Attaching a site you own grants every org member their role on it.
                </p>
              </div>

              {/* Attach */}
              <div className="flex flex-col gap-1.5">
                <Label>Attach a site you own</Label>
                <div className="flex gap-2">
                  <Select value={attachId} onValueChange={setAttachId}>
                    <SelectTrigger className="max-w-sm">
                      <SelectValue placeholder={attachable.length ? "Choose a site…" : "No eligible sites"} />
                    </SelectTrigger>
                    <SelectContent>
                      {attachable.map(s => (
                        <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button onClick={handleAttach} disabled={!attachId || attaching}>
                    {attaching ? "Attaching…" : "Attach"}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Only sites you own that aren't already in an organization can be attached.
                </p>
              </div>

              {/* Attached list */}
              {sites.length === 0 ? (
                <p className="text-sm text-muted-foreground">No sites attached yet.</p>
              ) : (
                <div className="flex flex-col divide-y divide-border rounded-md border border-border">
                  {sites.map(site => (
                    <div key={site.id} className="flex items-center justify-between gap-3 px-4 py-3">
                      <button
                        type="button"
                        onClick={() => navigate(`/projects/${site.id}`)}
                        className="truncate text-sm font-medium hover:underline"
                      >
                        {site.name}
                      </button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-9 sm:h-7 px-2.5 text-xs text-muted-foreground hover:text-destructive"
                        onClick={() => handleDetach(site)}
                      >
                        Detach
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}

        {/* Danger Zone */}
        {myRole !== null && (
          <>
            <Separator className="my-10" />
            <div id="danger" className="flex flex-col gap-3">
              <h3 className="text-base font-semibold text-destructive">Danger Zone</h3>

              {isOwner ? (
                <>
                  <p className="text-sm text-muted-foreground">
                    Deleting this organization removes it for all members. The sites inside it are NOT deleted - they're
                    detached and remain owned by their respective owners. This action cannot be undone.
                  </p>
                  <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
                    <AlertDialogTrigger asChild>
                      <Button variant="destructive" className="self-start">Delete organization</Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Delete "{org?.name}"?</AlertDialogTitle>
                        <AlertDialogDescription>
                          This removes the organization and its membership. Its sites are detached but kept. This cannot be undone.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                          className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                          onClick={handleDelete}
                        >
                          Yes, delete
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </>
              ) : (
                <>
                  <p className="text-sm text-muted-foreground">
                    Leaving this organization removes your access to all of its sites. You'll need to be re-invited to regain it.
                  </p>
                  <AlertDialog open={leaveOpen} onOpenChange={setLeaveOpen}>
                    <AlertDialogTrigger asChild>
                      <Button variant="destructive" className="self-start">Leave organization</Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Leave "{org?.name}"?</AlertDialogTitle>
                        <AlertDialogDescription>
                          You will lose access to every site in this organization immediately.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                          className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                          onClick={handleLeave}
                        >
                          Yes, leave
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </SettingsShell>
  );
}
