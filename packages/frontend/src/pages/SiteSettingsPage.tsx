import { useState, useEffect, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { UserAvatar } from "@/components/UserAvatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { getToken } from "@/lib/auth";
import { Switch } from "@/components/ui/switch";
import { useOutletContext } from "react-router-dom";
import type { DocsLayoutContext } from "@/layouts/DocsLayout";
import { UserProfileCard } from "@/components/UserProfileCard";
import { InlineSaveControls } from "@/components/InlineSaveControls";
import { AvatarCropDialog } from "@/components/AvatarCropDialog";
import { Globe, House, Link, Lock, Copy, Check, X, Network, Plus, ChevronDown, RefreshCw, Upload, ImageIcon, AlertTriangle, KeyRound, Building2 } from "lucide-react";
import { SettingsShell, type SettingsGroupDef, type SettingsSectionDef } from "@/components/settings/SettingsShell";

type Role = "limited" | "viewer" | "editor" | "admin" | "owner";

const ROLE_LABELS: Record<Role, string> = {
  limited: "Limited",
  viewer: "Viewer",
  editor: "Editor",
  admin: "Admin",
  owner: "Owner",
};

const ROLE_DESCRIPTIONS: Record<Role, string> = {
  limited: "Can only access documents explicitly shared with them (view or edit per doc)",
  viewer: "Can read documents",
  editor: "Can create and edit documents",
  admin: "Can invite users and manage roles",
  owner: "Full access including site deletion",
};

const ROLE_RANK: Record<Role, number> = { limited: -1, viewer: 0, editor: 1, admin: 2, owner: 3 };

const ASSIGNABLE_ROLES: Role[] = ["limited", "viewer", "editor", "admin"];

// Grouped outline for the settings accordion. Section→group membership and
// per-role visibility live in the per-render `settingsSections` array. Order
// here is the accordion order and matches DOM order. Features/People collapse
// away for non-admins (their only sections are admin-gated); Site (General)
// and Danger Zone remain for every member.
const SITE_SETTINGS_GROUPS: SettingsGroupDef[] = [
  { id: "site", label: "Site" },
  { id: "features", label: "Features" },
  { id: "people", label: "People" },
  { id: "developer", label: "Developer" },
  { id: "danger", label: "Danger Zone" },
];

interface Project {
  id: string;
  name: string;
  description: string | null;
  owner_id: string;
  published_at: string | null;
  changelog_mode: string;
  vanity_slug: string | null;
  features: number;
  ai_enabled: number;
  ai_summarization_type: string;
  graph_enabled: number;
  published_graph_enabled: number;
  graph_tag_colors: string | null;
  graph_reindex_available_at: string | null;
  home_doc_id: string | null;
  logo_square_updated_at: string | null;
  logo_wide_updated_at: string | null;
  organization_id: string | null;
  organization_name: string | null;
  role: Role;
}

type LogoVariant = "square" | "wide";

interface Member {
  id: string;
  userId: string;
  email: string;
  name: string;
  role: Role;
  accepted: boolean;
  personalPlan?: "free" | "ink";
  personalPlanStyle?: string | null;
}

interface InviteLink {
  id: string;
  projectId: string;
  role: Role;
  maxUses: number | null;
  useCount: number;
  expiresAt: string | null;
  createdBy: string;
  createdAt: string;
  isActive: boolean;
}

type ApiKeyScope = "read" | "readwrite";

interface ApiKey {
  id: string;
  name: string;
  keyPrefix: string;
  scope: ApiKeyScope;
  canInvite: boolean;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

interface DomainDnsRecord {
  type: "CNAME" | "TXT";
  name: string;
  value: string;
  note: string;
}

interface CustomDomain {
  hostname: string;
  status: "pending" | "active" | "error";
  hostnameStatus: string | null;
  sslStatus: string | null;
  dnsRecords: DomainDnsRecord[];
  verificationErrors: string[];
  cnameTarget: string;
  createdAt: string;
  updatedAt: string;
}

const EXPIRY_OPTIONS = [
  { value: "never", label: "Never" },
  { value: "1d", label: "1 day" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
];

function expiryLabel(expiresAt: string | null): string {
  if (!expiresAt) return "Never";
  const date = new Date(expiresAt);
  const now = new Date();
  if (date < now) return "Expired";
  const diff = date.getTime() - now.getTime();
  const days = Math.ceil(diff / (1000 * 60 * 60 * 24));
  if (days === 1) return "Expires in 1 day";
  return `Expires in ${days} days`;
}

function parseToken(token: string): { userId: string; email: string } | null {
  try {
    const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    return { userId: payload.userId, email: payload.email };
  } catch {
    return null;
  }
}

export function SiteSettingsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();

  const [project, setProject] = useState<Project | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [savingName, setSavingName] = useState(false);
  const [savingDescription, setSavingDescription] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const { toast } = useToast();

  const [myRole, setMyRole] = useState<Role | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [loadingMembers, setLoadingMembers] = useState(false);

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<Role>("editor");
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);

  const [removingId, setRemovingId] = useState<string | null>(null);

  const [inviteLinks, setInviteLinks] = useState<InviteLink[]>([]);
  const [loadingLinks, setLoadingLinks] = useState(false);
  const [createLinkOpen, setCreateLinkOpen] = useState(false);
  const [newLinkRole, setNewLinkRole] = useState<Role>("editor");
  const [newLinkMaxUses, setNewLinkMaxUses] = useState("");
  const [newLinkExpiry, setNewLinkExpiry] = useState("never");
  const [creatingLink, setCreatingLink] = useState(false);
  const [copiedLinkId, setCopiedLinkId] = useState<string | null>(null);
  const [revokingLinkId, setRevokingLinkId] = useState<string | null>(null);

  // ── Scoped API keys (public /v1 API) ──
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [loadingKeys, setLoadingKeys] = useState(false);
  const [createKeyOpen, setCreateKeyOpen] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [newKeyScope, setNewKeyScope] = useState<ApiKeyScope>("read");
  const [newKeyCanInvite, setNewKeyCanInvite] = useState(false);
  const [creatingKey, setCreatingKey] = useState(false);
  const [createKeyError, setCreateKeyError] = useState<string | null>(null);
  // The plaintext secret, held in memory only long enough to show it once.
  const [newKeySecret, setNewKeySecret] = useState<string | null>(null);
  const [copiedSecret, setCopiedSecret] = useState(false);
  const [revokingKeyId, setRevokingKeyId] = useState<string | null>(null);

  const [exporting, setExporting] = useState(false);

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const [leaveOpen, setLeaveOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [detachOrgOpen, setDetachOrgOpen] = useState(false);
  const [detaching, setDetaching] = useState(false);
  const [leaveError, setLeaveError] = useState<string | null>(null);

  const [unpublishedDocCount, setUnpublishedDocCount] = useState(0);
  const [togglingPublish, setTogglingPublish] = useState(false);
  const [togglingChangelog, setTogglingChangelog] = useState(false);
  const [togglingAi, setTogglingAi] = useState(false);
  const [togglingAiType, setTogglingAiType] = useState(false);
  const [togglingHomeDoc, setTogglingHomeDoc] = useState(false);
  const [togglingGraph, setTogglingGraph] = useState(false);
  const [togglingPublishedGraph, setTogglingPublishedGraph] = useState(false);

  const [vanitySlug, setVanitySlug] = useState("");
  const [savingSlug, setSavingSlug] = useState(false);
  const [slugError, setSlugError] = useState<string | null>(null);

  // ── Custom domain (Cloudflare for SaaS) - gated by the same CUSTOM_LINK flag ──
  const [domain, setDomain] = useState<CustomDomain | null>(null);
  const [domainConfigured, setDomainConfigured] = useState(true);
  const [domainCnameTarget, setDomainCnameTarget] = useState<string | null>(null);
  const [domainInput, setDomainInput] = useState("");
  const [savingDomain, setSavingDomain] = useState(false);
  const [refreshingDomain, setRefreshingDomain] = useState(false);
  const [removingDomain, setRemovingDomain] = useState(false);
  const [domainError, setDomainError] = useState<string | null>(null);
  const [copiedRecord, setCopiedRecord] = useState<string | null>(null);

  // Per-variant logo state. Square is cropped client-side via AvatarCropDialog
  // (1:1, 512×512); wide uploads native-aspect for the published-site header.
  const [uploadingLogo, setUploadingLogo] = useState<{ square: boolean; wide: boolean }>({ square: false, wide: false });
  const [removingLogo, setRemovingLogo] = useState<{ square: boolean; wide: boolean }>({ square: false, wide: false });
  const [logoError, setLogoError] = useState<{ square: string | null; wide: string | null }>({ square: null, wide: null });
  const [logoPreviewUrls, setLogoPreviewUrls] = useState<{ square: string | null; wide: string | null }>({ square: null, wide: null });
  const squareLogoInputRef = useRef<HTMLInputElement>(null);
  const wideLogoInputRef = useRef<HTMLInputElement>(null);
  // Square slot routes the picked file through AvatarCropDialog before upload.
  const [squareCropFile, setSquareCropFile] = useState<File | null>(null);

  interface TagColorRule { id: number; tag: string; color: string }
  const [tagColorRules, setTagColorRules] = useState<TagColorRule[]>([{ id: 0, tag: "", color: "#6366f1" }]);
  const [nextRuleId, setNextRuleId] = useState(1);
  const [savingTagColors, setSavingTagColors] = useState(false);
  const [tagColorsOpen, setTagColorsOpen] = useState(false);
  const [reindexAvailableAt, setReindexAvailableAt] = useState<Date | null>(null);
  const [reindexing, setReindexing] = useState(false);

  const token = getToken();
  const currentUser = token ? parseToken(token) : null;

  const { setBreadcrumbs } = useOutletContext<DocsLayoutContext>();
  useEffect(() => { setBreadcrumbs([]); }, []);

  useEffect(() => {
    if (!token || !projectId) return;

    fetch(`/api/projects/${projectId}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then((json: { ok: boolean; data?: Project }) => {
        if (json.ok && json.data) {
          setProject(json.data);
          setName(json.data.name);
          setDescription(json.data.description ?? "");
          setVanitySlug(json.data.vanity_slug ?? "");
          setMyRole(json.data.role);
          if (json.data.graph_tag_colors) {
            try {
              const parsed = JSON.parse(json.data.graph_tag_colors) as { tag: string; color: string }[];
              if (Array.isArray(parsed) && parsed.length > 0) {
                setTagColorRules(parsed.map((r, i) => ({ id: i, tag: r.tag, color: r.color })));
                setNextRuleId(parsed.length);
              }
            } catch {}
          }
          if (json.data.graph_reindex_available_at) {
            setReindexAvailableAt(new Date(json.data.graph_reindex_available_at));
          }
        }
      })
      .catch(() => {});
  }, [projectId]);

  useEffect(() => {
    if (!token || !projectId) return;
    setLoadingMembers(true);
    fetch(`/api/projects/${projectId}/members`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then((json: { ok: boolean; data?: Member[] }) => {
        if (json.ok && json.data) {
          setMembers(json.data);
          if (currentUser) {
            const me = json.data.find(m => m.userId === currentUser.userId);
            if (me) setMyRole(me.role);
          }
        }
      })
      .catch(() => {})
      .finally(() => setLoadingMembers(false));
  }, [projectId]);

  useEffect(() => {
    if (!token || !projectId) return;
    setLoadingKeys(true);
    fetch(`/api/projects/${projectId}/api-keys`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then((json: { ok: boolean; data?: ApiKey[] }) => {
        if (json.ok && json.data) setApiKeys(json.data);
      })
      .catch(() => {})
      .finally(() => setLoadingKeys(false));
  }, [projectId]);

  // Count docs left individually unpublished. A published site exposes all of
  // its docs regardless of this flag, so the count drives a heads-up warning.
  useEffect(() => {
    if (!token || !projectId) return;
    fetch(`/api/docs?projectId=${projectId}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then((json: { ok: boolean; data?: { published_at: string | null }[] }) => {
        if (json.ok && json.data) {
          setUnpublishedDocCount(json.data.filter(d => d.published_at === null).length);
        }
      })
      .catch(() => {});
  }, [projectId]);

  useEffect(() => {
    return () => {
      setLogoPreviewUrls(prev => {
        if (prev.square) URL.revokeObjectURL(prev.square);
        if (prev.wide) URL.revokeObjectURL(prev.wide);
        return { square: null, wide: null };
      });
    };
  }, []);

  // Load both logo variants into blob URLs whenever the timestamps change.
  // Auth fetch + ObjectURL because the GET endpoint requires a Bearer token.
  const squareUpdatedAt = project?.logo_square_updated_at ?? null;
  const wideUpdatedAt = project?.logo_wide_updated_at ?? null;
  useEffect(() => {
    if (!token || !projectId) return;
    let cancelled = false;
    function loadVariant(variant: LogoVariant, updatedAt: string | null) {
      if (!updatedAt) {
        setLogoPreviewUrls(prev => {
          if (prev[variant]) URL.revokeObjectURL(prev[variant]!);
          return { ...prev, [variant]: null };
        });
        return;
      }
      fetch(`/api/projects/${projectId}/logo/${variant}?v=${encodeURIComponent(updatedAt)}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
        .then(r => r.ok ? r.blob() : null)
        .then(blob => {
          if (cancelled || !blob) return;
          const newUrl = URL.createObjectURL(blob);
          setLogoPreviewUrls(prev => {
            if (prev[variant]) URL.revokeObjectURL(prev[variant]!);
            return { ...prev, [variant]: newUrl };
          });
        })
        .catch(() => {});
    }
    loadVariant("square", squareUpdatedAt);
    loadVariant("wide", wideUpdatedAt);
    return () => { cancelled = true; };
  }, [projectId, token, squareUpdatedAt, wideUpdatedAt]);

  useEffect(() => {
    if (!token || !projectId || !myRole) return;
    if (ROLE_RANK[myRole] < ROLE_RANK["admin"]) return;
    setLoadingLinks(true);
    fetch(`/api/projects/${projectId}/invite-links`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then((json: { ok: boolean; data?: InviteLink[] }) => {
        if (json.ok && json.data) setInviteLinks(json.data);
      })
      .catch(() => {})
      .finally(() => setLoadingLinks(false));
  }, [projectId, token, myRole]);

  // Load the custom-domain mapping when the CUSTOM_LINK feature is enabled and
  // the caller can manage it (admin+). The endpoint enforces both server-side.
  const customLinkEnabled = !!(project?.features ?? 0) && !!((project?.features ?? 0) & 1);
  useEffect(() => {
    if (!token || !projectId || !customLinkEnabled || !myRole) return;
    if (ROLE_RANK[myRole] < ROLE_RANK["admin"]) return;
    fetch(`/api/projects/${projectId}/domain`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then((json: { ok: boolean; data?: { configured: boolean; cnameTarget: string; domain: CustomDomain | null } }) => {
        if (json.ok && json.data) {
          setDomainConfigured(json.data.configured);
          setDomainCnameTarget(json.data.cnameTarget || null);
          setDomain(json.data.domain);
        }
      })
      .catch(() => {});
  }, [projectId, token, customLinkEnabled, myRole]);

  async function handleSaveName(e: React.FormEvent) {
    e.preventDefault();
    if (!projectId) return;
    setSavingName(true);
    setSaveError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name }),
      });
      const json = await res.json() as { ok: boolean; data?: Project; error?: string };
      if (json.ok && json.data) {
        setProject(json.data);
        toast({ title: "Name saved." });
      } else {
        setSaveError("Failed to save name.");
      }
    } catch {
      setSaveError("Could not connect to the server.");
    } finally {
      setSavingName(false);
    }
  }

  async function handleSaveDescription(e: React.FormEvent) {
    e.preventDefault();
    if (!projectId) return;
    setSavingDescription(true);
    setSaveError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ description: description || null }),
      });
      const json = await res.json() as { ok: boolean; data?: Project; error?: string };
      if (json.ok && json.data) {
        setProject(json.data);
        toast({ title: "Description saved." });
      } else {
        setSaveError("Failed to save description.");
      }
    } catch {
      setSaveError("Could not connect to the server.");
    } finally {
      setSavingDescription(false);
    }
  }

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    if (!projectId || !inviteEmail) return;
    setInviting(true);
    setInviteError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ email: inviteEmail, role: inviteRole }),
      });
      const json = await res.json() as { ok: boolean; data?: Member; error?: string };
      if (json.ok && json.data) {
        setMembers(prev => [...prev, json.data!]);
        setInviteEmail("");
        toast({ title: `Invite sent to ${json.data.email}.` });
      } else {
        setInviteError((json as { error?: string }).error ?? "Failed to add member.");
      }
    } catch {
      setInviteError("Could not connect to the server.");
    } finally {
      setInviting(false);
    }
  }

  async function handleRoleChange(member: Member, newRole: Role) {
    if (!projectId) return;
    try {
      const res = await fetch(`/api/projects/${projectId}/members/${member.userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ role: newRole }),
      });
      const json = await res.json() as { ok: boolean; data?: Member };
      if (json.ok && json.data) {
        setMembers(prev => prev.map(m => m.userId === member.userId ? { ...m, role: newRole } : m));
        toast({ title: `${member.name}'s role updated to ${ROLE_LABELS[newRole]}.` });
      } else {
        toast({ title: "Failed to update role.", variant: "destructive" });
      }
    } catch {
      toast({ title: "Could not connect to the server.", variant: "destructive" });
    }
  }

  async function handleRemove(member: Member) {
    if (!projectId) return;
    setRemovingId(member.userId);
    try {
      const res = await fetch(`/api/projects/${projectId}/members/${member.userId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await res.json() as { ok: boolean };
      if (json.ok) {
        setMembers(prev => prev.filter(m => m.userId !== member.userId));
        toast({ title: member.accepted ? `${member.name} removed.` : `Invite to ${member.email} canceled.` });
      } else {
        toast({ title: member.accepted ? "Failed to remove member." : "Failed to cancel invite.", variant: "destructive" });
      }
    } catch {
      toast({ title: "Could not connect to the server.", variant: "destructive" });
    } finally {
      setRemovingId(null);
    }
  }

  async function handleCreateKey(e: React.FormEvent) {
    e.preventDefault();
    if (!projectId || !newKeyName.trim()) return;
    setCreatingKey(true);
    setCreateKeyError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/api-keys`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: newKeyName.trim(), scope: newKeyScope, canInvite: newKeyCanInvite }),
      });
      const json = await res.json() as { ok: boolean; data?: ApiKey & { secret: string }; error?: string };
      if (json.ok && json.data) {
        const { secret, ...meta } = json.data;
        setApiKeys(prev => [meta, ...prev]);
        setNewKeySecret(secret); // surfaces the one-time reveal dialog
        setCreateKeyOpen(false);
        setNewKeyName("");
        setNewKeyScope("read");
        setNewKeyCanInvite(false);
      } else {
        setCreateKeyError(json.error ?? "Failed to create key.");
      }
    } catch {
      setCreateKeyError("Could not connect to the server.");
    } finally {
      setCreatingKey(false);
    }
  }

  async function handleRevokeKey(key: ApiKey) {
    if (!projectId) return;
    setRevokingKeyId(key.id);
    try {
      const res = await fetch(`/api/projects/${projectId}/api-keys/${key.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await res.json() as { ok: boolean };
      if (json.ok) {
        setApiKeys(prev => prev.filter(k => k.id !== key.id));
        toast({ title: `API key "${key.name}" revoked.` });
      } else {
        toast({ title: "Failed to revoke key.", variant: "destructive" });
      }
    } catch {
      toast({ title: "Could not connect to the server.", variant: "destructive" });
    } finally {
      setRevokingKeyId(null);
    }
  }

  async function handleCopySecret() {
    if (!newKeySecret) return;
    try {
      await navigator.clipboard.writeText(newKeySecret);
      setCopiedSecret(true);
      setTimeout(() => setCopiedSecret(false), 2000);
    } catch { /* clipboard unavailable */ }
  }

  async function handleCreateLink() {
    if (!projectId) return;
    setCreatingLink(true);
    try {
      const expiresAt = newLinkExpiry === "never" ? null : (() => {
        const days = newLinkExpiry === "1d" ? 1 : newLinkExpiry === "7d" ? 7 : 30;
        const d = new Date();
        d.setDate(d.getDate() + days);
        return d.toISOString();
      })();
      const maxUses = newLinkMaxUses.trim() ? parseInt(newLinkMaxUses, 10) : null;
      const res = await fetch(`/api/projects/${projectId}/invite-links`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ role: newLinkRole, maxUses, expiresAt }),
      });
      const json = await res.json() as { ok: boolean; data?: InviteLink };
      if (json.ok && json.data) {
        setInviteLinks(prev => [json.data!, ...prev]);
        setCreateLinkOpen(false);
        setNewLinkRole("editor");
        setNewLinkMaxUses("");
        setNewLinkExpiry("never");
        toast({ title: "Invite link created." });
      } else {
        toast({ title: "Failed to create invite link.", variant: "destructive" });
      }
    } catch {
      toast({ title: "Could not connect to the server.", variant: "destructive" });
    } finally {
      setCreatingLink(false);
    }
  }

  async function handleRevokeLink(id: string) {
    if (!projectId) return;
    setRevokingLinkId(id);
    try {
      const res = await fetch(`/api/projects/${projectId}/invite-links/${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await res.json() as { ok: boolean };
      if (json.ok) {
        setInviteLinks(prev => prev.map(l => l.id === id ? { ...l, isActive: false } : l));
        toast({ title: "Invite link revoked." });
      } else {
        toast({ title: "Failed to revoke link.", variant: "destructive" });
      }
    } catch {
      toast({ title: "Could not connect to the server.", variant: "destructive" });
    } finally {
      setRevokingLinkId(null);
    }
  }

  function handleCopyLink(link: InviteLink) {
    const url = `${window.location.origin}/invite/${link.id}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopiedLinkId(link.id);
      setTimeout(() => setCopiedLinkId(prev => prev === link.id ? null : prev), 2000);
    });
  }

  async function handleTogglePublish() {
    if (!projectId || !project) return;
    setTogglingPublish(true);
    const publishedAt = project.published_at ? null : new Date().toISOString();
    try {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ publishedAt }),
      });
      const json = await res.json() as { ok: boolean; data?: Project };
      if (json.ok && json.data) {
        setProject(json.data);
        toast({ title: json.data.published_at ? "Site published." : "Site unpublished." });
      } else {
        toast({ title: "Failed to update publish state.", variant: "destructive" });
      }
    } catch {
      toast({ title: "Could not connect to the server.", variant: "destructive" });
    } finally {
      setTogglingPublish(false);
    }
  }

  async function handleChangelogModeChange(mode: string) {
    if (!projectId || !project) return;
    setTogglingChangelog(true);
    try {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ changelogMode: mode }),
      });
      const json = await res.json() as { ok: boolean; data?: Project };
      if (json.ok && json.data) {
        setProject(json.data);
        toast({ title: "Changelog setting updated." });
      } else {
        toast({ title: "Failed to update changelog setting.", variant: "destructive" });
      }
    } catch {
      toast({ title: "Could not connect to the server.", variant: "destructive" });
    } finally {
      setTogglingChangelog(false);
    }
  }

  async function handleToggleAi(enabled: boolean) {
    if (!projectId || !project) return;
    setTogglingAi(true);
    try {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ aiEnabled: enabled }),
      });
      const json = await res.json() as { ok: boolean; data?: Project };
      if (json.ok && json.data) {
        setProject(json.data);
        toast({ title: enabled ? "AI features enabled." : "AI features disabled." });
      } else {
        toast({ title: "Failed to update AI setting.", variant: "destructive" });
      }
    } catch {
      toast({ title: "Could not connect to the server.", variant: "destructive" });
    } finally {
      setTogglingAi(false);
    }
  }

  async function handleAiSummarizationTypeChange(type: string) {
    if (!projectId || !project) return;
    setTogglingAiType(true);
    try {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ aiSummarizationType: type }),
      });
      const json = await res.json() as { ok: boolean; data?: Project };
      if (json.ok && json.data) {
        setProject(json.data);
        toast({ title: "AI summarization type updated." });
      } else {
        toast({ title: "Failed to update AI summarization type.", variant: "destructive" });
      }
    } catch {
      toast({ title: "Could not connect to the server.", variant: "destructive" });
    } finally {
      setTogglingAiType(false);
    }
  }

  async function handleToggleGraph(enabled: boolean) {
    if (!projectId || !project) return;
    setTogglingGraph(true);
    try {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ graphEnabled: enabled }),
      });
      const json = await res.json() as { ok: boolean; data?: Project };
      if (json.ok && json.data) {
        setProject(json.data);
        toast({ title: enabled ? "Graph view enabled." : "Graph view disabled." });
      } else {
        toast({ title: "Failed to update graph view setting.", variant: "destructive" });
      }
    } catch {
      toast({ title: "Could not connect to the server.", variant: "destructive" });
    } finally {
      setTogglingGraph(false);
    }
  }

  async function handleTogglePublishedGraph(enabled: boolean) {
    if (!projectId || !project) return;
    setTogglingPublishedGraph(true);
    try {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ publishedGraphEnabled: enabled }),
      });
      const json = await res.json() as { ok: boolean; data?: Project };
      if (json.ok && json.data) {
        setProject(json.data);
        toast({ title: enabled ? "Graph visible on public site." : "Graph hidden from public site." });
      } else {
        toast({ title: "Failed to update setting.", variant: "destructive" });
      }
    } catch {
      toast({ title: "Could not connect to the server.", variant: "destructive" });
    } finally {
      setTogglingPublishedGraph(false);
    }
  }

  async function handleReindex() {
    if (!projectId) return;
    setReindexing(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/graph/reindex`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await res.json() as { ok: boolean; data?: { nextAvailableAt: string }; nextAvailableAt?: string; error?: string };
      if (json.ok && json.data?.nextAvailableAt) {
        setReindexAvailableAt(new Date(json.data.nextAvailableAt));
        toast({ title: "Graph reindexed." });
      } else if (res.status === 429 && json.nextAvailableAt) {
        setReindexAvailableAt(new Date(json.nextAvailableAt));
        toast({ title: "Reindex is rate limited.", variant: "destructive" });
      } else {
        toast({ title: "Failed to reindex graph.", variant: "destructive" });
      }
    } catch {
      toast({ title: "Could not connect to the server.", variant: "destructive" });
    } finally {
      setReindexing(false);
    }
  }

  function addTagRule() {
    setTagColorRules(prev => [...prev, { id: nextRuleId, tag: "", color: "#6366f1" }]);
    setNextRuleId(prev => prev + 1);
  }

  function updateTagRuleTag(id: number, tag: string) {
    setTagColorRules(prev => prev.map(r => r.id === id ? { ...r, tag } : r));
  }

  function updateTagRuleColor(id: number, color: string) {
    setTagColorRules(prev => prev.map(r => r.id === id ? { ...r, color } : r));
  }

  function removeTagRule(id: number) {
    setTagColorRules(prev => prev.filter(r => r.id !== id));
  }

  async function saveTagColors() {
    if (!projectId) return;
    setSavingTagColors(true);
    try {
      const rules = tagColorRules.filter(r => r.tag.trim());
      const res = await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ graphTagColors: rules.map(r => ({ tag: r.tag.trim(), color: r.color })) }),
      });
      const json = await res.json() as { ok: boolean; data?: Project };
      if (json.ok) {
        toast({ title: "Tag colors saved." });
      } else {
        toast({ title: "Failed to save tag colors.", variant: "destructive" });
      }
    } catch {
      toast({ title: "Could not connect to the server.", variant: "destructive" });
    } finally {
      setSavingTagColors(false);
    }
  }

  async function handleToggleHomeDoc(enabled: boolean) {
    if (!projectId || !project) return;
    setTogglingHomeDoc(true);
    try {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ homeDocEnabled: enabled }),
      });
      const json = await res.json() as { ok: boolean; data?: Project };
      if (json.ok && json.data) {
        setProject(json.data);
        toast({ title: enabled ? "Home document created." : "Home document removed." });
      } else {
        toast({ title: "Failed to update home document setting.", variant: "destructive" });
      }
    } catch {
      toast({ title: "Could not connect to the server.", variant: "destructive" });
    } finally {
      setTogglingHomeDoc(false);
    }
  }

  // Wide-slot upload: validate then upload the raw file.
  // Square-slot upload arrives here pre-cropped from AvatarCropDialog as a
  // 512×512 WebP blob - static for stills, animated for animated GIF input
  // (the crop dialog re-encodes every frame and muxes them).
  async function uploadLogoBlob(variant: LogoVariant, file: File | Blob, filename: string) {
    if (!projectId) return;
    setLogoError(prev => ({ ...prev, [variant]: null }));
    setUploadingLogo(prev => ({ ...prev, [variant]: true }));
    try {
      const form = new FormData();
      form.append("file", file instanceof File ? file : new File([file], filename, { type: file.type }));
      const res = await fetch(`/api/projects/${projectId}/logo/${variant}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });
      const json = await res.json() as { ok: boolean; data?: Project; error?: string };
      if (json.ok && json.data) {
        setProject(json.data);
        toast({ title: variant === "square" ? "Square icon uploaded." : "Wordmark uploaded." });
      } else {
        setLogoError(prev => ({ ...prev, [variant]: json.error ?? "Failed to upload logo." }));
      }
    } catch {
      setLogoError(prev => ({ ...prev, [variant]: "Could not connect to the server." }));
    } finally {
      setUploadingLogo(prev => ({ ...prev, [variant]: false }));
    }
  }

  async function handleWideLogoUpload(file: File) {
    setLogoError(prev => ({ ...prev, wide: null }));
    const allowed = ["image/jpeg", "image/png", "image/webp", "image/gif"];
    if (!allowed.includes(file.type)) {
      setLogoError(prev => ({ ...prev, wide: "Invalid file type. Allowed: JPEG, PNG, WebP, GIF." }));
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setLogoError(prev => ({ ...prev, wide: "File too large. Maximum size is 2MB." }));
      return;
    }
    await uploadLogoBlob("wide", file, file.name);
    if (wideLogoInputRef.current) wideLogoInputRef.current.value = "";
  }

  async function handleSquareCropApply(blob: Blob) {
    await uploadLogoBlob("square", blob, "logo-square.webp");
    setSquareCropFile(null);
    if (squareLogoInputRef.current) squareLogoInputRef.current.value = "";
  }

  async function handleLogoRemove(variant: LogoVariant) {
    if (!projectId) return;
    setRemovingLogo(prev => ({ ...prev, [variant]: true }));
    setLogoError(prev => ({ ...prev, [variant]: null }));
    try {
      const res = await fetch(`/api/projects/${projectId}/logo/${variant}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await res.json() as { ok: boolean; data?: Project };
      if (json.ok && json.data) {
        setProject(json.data);
        toast({ title: variant === "square" ? "Square icon removed." : "Wordmark removed." });
      } else {
        setLogoError(prev => ({ ...prev, [variant]: "Failed to remove logo." }));
      }
    } catch {
      setLogoError(prev => ({ ...prev, [variant]: "Could not connect to the server." }));
    } finally {
      setRemovingLogo(prev => ({ ...prev, [variant]: false }));
    }
  }

  async function handleSaveSlug(e: React.FormEvent) {
    e.preventDefault();
    if (!projectId) return;
    setSavingSlug(true);
    setSlugError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ vanitySlug: vanitySlug.trim() || null }),
      });
      const json = await res.json() as { ok: boolean; data?: Project; error?: string };
      if (json.ok && json.data) {
        setProject(json.data);
        setVanitySlug(json.data.vanity_slug ?? "");
        toast({ title: "Custom link saved." });
      } else if (res.status === 409) {
        setSlugError("This URL is already taken.");
      } else {
        setSlugError("Failed to save custom link.");
      }
    } catch {
      setSlugError("Could not connect to the server.");
    } finally {
      setSavingSlug(false);
    }
  }

  async function handleSaveDomain(e: React.FormEvent) {
    e.preventDefault();
    if (!projectId || !domainInput.trim()) return;
    setSavingDomain(true);
    setDomainError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/domain`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ hostname: domainInput.trim() }),
      });
      const json = await res.json() as { ok: boolean; data?: { configured: boolean; domain: CustomDomain }; error?: string };
      if (json.ok && json.data) {
        setDomain(json.data.domain);
        setDomainConfigured(json.data.configured);
        setDomainCnameTarget(json.data.domain.cnameTarget || domainCnameTarget);
        setDomainInput("");
        toast({ title: "Domain added. Add the DNS records below to activate it." });
      } else {
        setDomainError(json.error ?? "Failed to add domain.");
      }
    } catch {
      setDomainError("Could not connect to the server.");
    } finally {
      setSavingDomain(false);
    }
  }

  async function handleRefreshDomain() {
    if (!projectId) return;
    setRefreshingDomain(true);
    setDomainError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/domain/refresh`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await res.json() as { ok: boolean; data?: { domain: CustomDomain }; error?: string };
      if (json.ok && json.data) {
        setDomain(json.data.domain);
        toast({ title: json.data.domain.status === "active" ? "Domain is active." : "Status refreshed." });
      } else {
        setDomainError(json.error ?? "Failed to refresh status.");
      }
    } catch {
      setDomainError("Could not connect to the server.");
    } finally {
      setRefreshingDomain(false);
    }
  }

  async function handleRemoveDomain() {
    if (!projectId) return;
    setRemovingDomain(true);
    setDomainError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/domain`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await res.json() as { ok: boolean };
      if (json.ok) {
        setDomain(null);
        toast({ title: "Custom domain removed." });
      } else {
        setDomainError("Failed to remove domain.");
      }
    } catch {
      setDomainError("Could not connect to the server.");
    } finally {
      setRemovingDomain(false);
    }
  }

  function handleCopyRecord(key: string, value: string) {
    navigator.clipboard.writeText(value).then(() => {
      setCopiedRecord(key);
      setTimeout(() => setCopiedRecord(prev => (prev === key ? null : prev)), 2000);
    }).catch(() => {});
  }

  async function handleLeave() {
    if (!projectId || !currentUser) return;
    setLeaving(true);
    setLeaveError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/members/${currentUser.userId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await res.json() as { ok: boolean };
      if (json.ok) {
        navigate("/dashboard");
      } else {
        setLeaveError("Failed to leave site.");
      }
    } catch {
      setLeaveError("Could not connect to the server.");
    } finally {
      setLeaving(false);
    }
  }

  async function handleDetach() {
    if (!projectId || !project?.organization_id) return;
    setDetaching(true);
    try {
      const res = await fetch(`/api/organizations/${project.organization_id}/projects/${projectId}/attach`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await res.json() as { ok: boolean };
      if (json.ok) {
        setProject(prev => prev ? { ...prev, organization_id: null, organization_name: null } : prev);
        setDetachOrgOpen(false);
        toast({ title: "Site detached from the organization." });
      } else {
        toast({ title: "Failed to detach site.", variant: "destructive" });
      }
    } catch {
      toast({ title: "Could not connect to the server.", variant: "destructive" });
    } finally {
      setDetaching(false);
    }
  }

  async function handleExport() {
    if (!projectId) return;
    setExporting(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/export`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        toast({ title: "Failed to export site.", variant: "destructive" });
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${project!.name}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast({ title: "Site exported." });
    } catch {
      toast({ title: "Could not connect to the server.", variant: "destructive" });
    } finally {
      setExporting(false);
    }
  }

  async function handleDelete() {
    if (!projectId) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await res.json() as { ok: boolean };
      if (json.ok) {
        navigate("/dashboard");
      } else {
        setDeleteError("Failed to delete site.");
      }
    } catch {
      setDeleteError("Could not connect to the server.");
    } finally {
      setDeleting(false);
    }
  }

  const isAdminOrOwner = myRole !== null && ROLE_RANK[myRole] >= ROLE_RANK["admin"];
  const isOwner = myRole === "owner";

  if (!project) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    );
  }

  const settingsSections: SettingsSectionDef[] = [
    { id: "general", label: "General", group: "site" },
    { id: "publishing", label: "Publishing", group: "site", visible: isAdminOrOwner },
    { id: "branding", label: "Branding", group: "site", visible: isAdminOrOwner },
    { id: "features", label: "Features", group: "features", visible: isAdminOrOwner },
    { id: "members", label: "Members", group: "people", visible: isAdminOrOwner },
    { id: "api-keys", label: "API Keys", group: "developer", visible: myRole !== null },
    { id: "danger", label: "Danger Zone", group: "danger", visible: myRole !== null, danger: true },
  ];

  // A key is only ever a ceiling on the owner's live access: a read-write key
  // can't write unless the owner is editor+, and an invite-capable key can't
  // touch members unless the owner is admin+. Reflect that honestly in the
  // create form rather than offering scopes that would silently 403.
  const canMintWriteKey = myRole !== null && ROLE_RANK[myRole] >= ROLE_RANK["editor"];
  const canMintInviteKey = isAdminOrOwner;

  return (
    <SettingsShell
      title="Site Settings"
      description={<>Manage settings for <span className="font-medium text-foreground">{project.name}</span>.</>}
      maxWidth="4xl"
      groups={SITE_SETTINGS_GROUPS}
      sections={settingsSections}
    >
      <div className="max-w-xl">
      {/* General settings */}
      <div id="general" className="flex flex-col gap-5">
        <form onSubmit={handleSaveName} className="flex flex-col gap-1.5">
          <Label htmlFor="settings-name">Name</Label>
          <div className="flex items-center">
            <InlineSaveControls
              changed={isAdminOrOwner && name !== project.name}
              saving={savingName}
              onReset={() => setName(project.name)}
              saveDisabled={!name.trim() || name.trim() === project.name}
              resetLabel="Reset name"
              saveLabel="Save name"
            >
              <Input
                id="settings-name"
                value={name}
                onChange={e => setName(e.target.value)}
                required
                disabled={!isAdminOrOwner}
                className="flex-1 pr-9"
              />
            </InlineSaveControls>
          </div>
        </form>

        <form onSubmit={handleSaveDescription} className="flex flex-col gap-1.5">
          <Label htmlFor="settings-description">Description</Label>
          <div className="flex items-center">
            <InlineSaveControls
              changed={isAdminOrOwner && description !== (project.description ?? "")}
              saving={savingDescription}
              onReset={() => setDescription(project.description ?? "")}
              resetLabel="Reset description"
              saveLabel="Save description"
            >
              <Input
                id="settings-description"
                placeholder="A short description of this site"
                value={description}
                onChange={e => setDescription(e.target.value)}
                disabled={!isAdminOrOwner}
                className="flex-1 pr-9"
              />
            </InlineSaveControls>
          </div>
        </form>

        {saveError && (
          <Alert variant="destructive">
            <AlertDescription>{saveError}</AlertDescription>
          </Alert>
        )}

        {project.organization_id && (
          <div className="flex flex-col gap-1.5">
            <Label>Organization</Label>
            <div className="flex items-center justify-between gap-3 rounded-md border border-border px-4 py-3">
              <div className="flex min-w-0 items-center gap-2.5">
                <Building2 className="h-4 w-4 shrink-0 text-primary" />
                <p className="truncate text-sm">
                  Part of <span className="font-medium">{project.organization_name ?? "an organization"}</span>
                </p>
              </div>
              {isOwner && (
                <AlertDialog open={detachOrgOpen} onOpenChange={setDetachOrgOpen}>
                  <AlertDialogTrigger asChild>
                    <Button variant="outline" size="sm" className="shrink-0">Detach</Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Detach from {project.organization_name}?</AlertDialogTitle>
                      <AlertDialogDescription>
                        Members of the organization will lose the access they had to this site through it. Direct site members are unaffected.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction disabled={detaching} onClick={handleDetach}>
                        {detaching ? "Detaching…" : "Detach"}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Publishing section - admins and owners only */}
      {isAdminOrOwner && (
        <>
          <Separator className="my-10" />
          <div className="flex flex-col gap-4">
            <div id="publishing">
              <h3 className="text-base font-semibold">Publishing</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Control public access to this site. When published, anyone with the link can view all documents.
              </p>
            </div>
            <div className="flex items-center justify-between rounded-md border border-border px-4 py-3">
              <div className="flex items-center gap-3">
                {project.published_at ? (
                  <Globe className="h-4 w-4 text-green-600 dark:text-green-400" />
                ) : (
                  <Lock className="h-4 w-4 text-muted-foreground" />
                )}
                <div>
                  <p className="text-sm font-medium">
                    {project.published_at ? "Published" : "Private"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {project.published_at
                      ? "This site is publicly accessible."
                      : "Only members can view this site."}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {project.published_at && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => {
                      const slug = project.vanity_slug ?? projectId;
                      const url = `${window.location.origin}/s/${slug}`;
                      navigator.clipboard.writeText(url);
                      toast({ title: "Link copied to clipboard." });
                    }}
                  >
                    <Link className="h-4 w-4" />
                  </Button>
                )}
                <Button
                  variant={project.published_at ? "outline" : "default"}
                  size="sm"
                  disabled={togglingPublish}
                  onClick={handleTogglePublish}
                >
                  {togglingPublish
                    ? "Saving…"
                    : project.published_at
                    ? "Unpublish"
                    : "Publish site"}
                </Button>
              </div>
            </div>
            {project.published_at && unpublishedDocCount > 0 && (
              <Alert className="border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-400 [&>svg]:text-amber-600 dark:[&>svg]:text-amber-400">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>
                  {unpublishedDocCount === 1
                    ? "1 document is marked unpublished"
                    : `${unpublishedDocCount} documents are marked unpublished`}
                </AlertTitle>
                <AlertDescription>
                  This site is published, so every document - including{" "}
                  {unpublishedDocCount === 1 ? "this one" : "these"} - is publicly
                  visible. A document's individual publish setting does not hide it
                  while the whole site is published. Unpublish the site if any of
                  these should stay private.
                </AlertDescription>
              </Alert>
            )}
          </div>
        </>
      )}

      {/* Branding section - admins and owners only */}
      {isAdminOrOwner && (
        <>
          <Separator className="my-10" />
          <div className="flex flex-col gap-4">
            <div id="branding">
              <h3 className="text-base font-semibold">Branding</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Customize how your published site looks and is shared.
              </p>
            </div>
            {/* Square icon - used in the projects sidebar, favourites, profile cards.
                Cropped client-side to 512×512 via AvatarCropDialog. */}
            <div className="flex items-center gap-4 rounded-md border border-border px-4 py-3">
              <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-muted/40">
                {project.logo_square_updated_at && logoPreviewUrls.square ? (
                  <img src={logoPreviewUrls.square} alt={project.name} className="max-h-full max-w-full object-cover" />
                ) : (
                  <ImageIcon className="h-6 w-6 text-muted-foreground" />
                )}
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <p className="text-sm font-medium">Square icon</p>
                <p className="text-xs text-muted-foreground">
                  Shown in the projects sidebar, favourites, and profile cards. PNG, JPG, WebP, or GIF, up to 2 MB. You'll crop it to a square.
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    ref={squareLogoInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif"
                    className="hidden"
                    onChange={e => {
                      const file = e.target.files?.[0];
                      if (file) setSquareCropFile(file);
                    }}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="gap-1.5"
                    disabled={uploadingLogo.square || removingLogo.square}
                    onClick={() => squareLogoInputRef.current?.click()}
                  >
                    <Upload className="h-3.5 w-3.5" />
                    {uploadingLogo.square ? "Uploading…" : project.logo_square_updated_at ? "Change" : "Upload icon"}
                  </Button>
                  {project.logo_square_updated_at && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="text-muted-foreground hover:text-destructive"
                      disabled={uploadingLogo.square || removingLogo.square}
                      onClick={() => handleLogoRemove("square")}
                    >
                      {removingLogo.square ? "Removing…" : "Remove"}
                    </Button>
                  )}
                </div>
              </div>
            </div>
            {logoError.square && (
              <Alert variant="destructive">
                <AlertDescription>{logoError.square}</AlertDescription>
              </Alert>
            )}

            {/* Wide wordmark - used at the top-left of the published-site
                header. Native aspect, no client-side crop. */}
            <div className="flex items-center gap-4 rounded-md border border-border px-4 py-3">
              <div className="flex h-16 w-32 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-muted/40">
                {project.logo_wide_updated_at && logoPreviewUrls.wide ? (
                  <img src={logoPreviewUrls.wide} alt={project.name} className="max-h-full max-w-full object-contain" />
                ) : (
                  <ImageIcon className="h-6 w-6 text-muted-foreground" />
                )}
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <p className="text-sm font-medium">Wordmark</p>
                <p className="text-xs text-muted-foreground">
                  Shown in the top-left of your published site. PNG, JPG, WebP, or GIF, up to 2 MB. A wide/horizontal image (around 4:1) on a transparent background works best.
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    ref={wideLogoInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif"
                    className="hidden"
                    onChange={e => {
                      const file = e.target.files?.[0];
                      if (file) handleWideLogoUpload(file);
                    }}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="gap-1.5"
                    disabled={uploadingLogo.wide || removingLogo.wide}
                    onClick={() => wideLogoInputRef.current?.click()}
                  >
                    <Upload className="h-3.5 w-3.5" />
                    {uploadingLogo.wide ? "Uploading…" : project.logo_wide_updated_at ? "Change" : "Upload wordmark"}
                  </Button>
                  {project.logo_wide_updated_at && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="text-muted-foreground hover:text-destructive"
                      disabled={uploadingLogo.wide || removingLogo.wide}
                      onClick={() => handleLogoRemove("wide")}
                    >
                      {removingLogo.wide ? "Removing…" : "Remove"}
                    </Button>
                  )}
                </div>
              </div>
            </div>
            {logoError.wide && (
              <Alert variant="destructive">
                <AlertDescription>{logoError.wide}</AlertDescription>
              </Alert>
            )}

            {squareCropFile && (
              <AvatarCropDialog
                file={squareCropFile}
                shape="square"
                onApply={handleSquareCropApply}
                onClose={() => {
                  setSquareCropFile(null);
                  if (squareLogoInputRef.current) squareLogoInputRef.current.value = "";
                }}
              />
            )}
            {/* Custom Link & Domain - both gated by the CUSTOM_LINK flag */}
            {!!(project.features & 1) && (
              <>
              <div id="custom-link" className="flex flex-col gap-3 rounded-md border border-border px-4 py-3">
                <div>
                  <p className="text-sm font-medium flex items-center gap-2">Custom Link <PremiumBadge /></p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Set a custom URL so your public site can be shared at a memorable address.
                  </p>
                </div>
                <form onSubmit={handleSaveSlug} className="flex flex-col gap-3">
                  <div className="flex flex-col gap-1.5">
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-muted-foreground shrink-0">{window.location.origin}/s/</span>
                      <InlineSaveControls
                        changed={vanitySlug.trim() !== (project.vanity_slug ?? "")}
                        saving={savingSlug}
                        onReset={() => setVanitySlug(project.vanity_slug ?? "")}
                        resetLabel="Reset custom link"
                        saveLabel="Save custom link"
                      >
                        <Input
                          id="vanity-slug"
                          value={vanitySlug}
                          onChange={e => setVanitySlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
                          placeholder="my-site"
                          className="flex-1 pr-9"
                        />
                      </InlineSaveControls>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 shrink-0"
                        aria-label="Copy custom link"
                        onClick={() => {
                          const slug = project.vanity_slug ?? projectId;
                          const url = `${window.location.origin}/s/${slug}`;
                          navigator.clipboard.writeText(url);
                          toast({ title: "Custom link copied to clipboard." });
                        }}
                      >
                        <Link className="h-4 w-4" />
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Lowercase letters, numbers, and hyphens only. 3–50 characters. The original project link will continue to work.
                    </p>
                  </div>
                  {slugError && (
                    <Alert variant="destructive">
                      <AlertDescription>{slugError}</AlertDescription>
                    </Alert>
                  )}
                </form>
              </div>

              {/* Custom Domain - map the site to the owner's own domain (Cloudflare for SaaS) */}
              <div id="custom-domain" className="flex flex-col gap-3 rounded-md border border-border px-4 py-3">
                <div>
                  <p className="text-sm font-medium flex items-center gap-2">
                    <Globe className="h-4 w-4 text-muted-foreground" /> Custom Domain <PremiumBadge />
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Serve your published site from a domain you own, e.g. <span className="font-mono">docs.example.com</span>.
                  </p>
                </div>

                {!domainConfigured ? (
                  <Alert>
                    <AlertDescription>
                      Custom domains aren't available on this deployment yet. Check back later.
                    </AlertDescription>
                  </Alert>
                ) : !domain ? (
                  <form onSubmit={handleSaveDomain} className="flex flex-col gap-2">
                    <div className="flex items-center gap-2">
                      <Input
                        id="custom-domain-input"
                        value={domainInput}
                        onChange={e => setDomainInput(e.target.value.toLowerCase().replace(/[^a-z0-9.-]/g, ""))}
                        placeholder="docs.example.com"
                        className="flex-1"
                      />
                      <Button type="submit" disabled={savingDomain || !domainInput.trim()}>
                        {savingDomain ? "Adding…" : "Add domain"}
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Enter a domain or subdomain you control. We'll give you the DNS records to add. Your site must be published for the domain to serve.
                    </p>
                  </form>
                ) : (
                  <div className="flex flex-col gap-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-2">
                        <a
                          href={`https://${domain.hostname}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="truncate text-sm font-medium hover:underline"
                        >
                          {domain.hostname}
                        </a>
                        <Badge variant={domain.status === "active" ? "default" : domain.status === "error" ? "destructive" : "secondary"}>
                          {domain.status === "active" ? "Active" : domain.status === "error" ? "Error" : "Pending"}
                        </Badge>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <Button variant="outline" size="sm" className="gap-1.5" onClick={handleRefreshDomain} disabled={refreshingDomain}>
                          <RefreshCw className={`h-3.5 w-3.5 ${refreshingDomain ? "animate-spin" : ""}`} />
                          {refreshingDomain ? "Checking…" : "Refresh"}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-muted-foreground hover:text-destructive"
                          onClick={handleRemoveDomain}
                          disabled={removingDomain}
                        >
                          {removingDomain ? "Removing…" : "Remove"}
                        </Button>
                      </div>
                    </div>

                    {domain.status !== "active" && domain.dnsRecords.length > 0 && (
                      <div className="flex flex-col gap-2">
                        <p className="text-xs text-muted-foreground">
                          Add these records at your DNS provider. We re-check automatically - click Refresh once they've propagated (this can take a few minutes).
                        </p>
                        <div className="overflow-x-auto rounded-md border border-border">
                          <table className="w-full text-xs">
                            <thead>
                              <tr className="border-b border-border bg-muted/40 text-left text-muted-foreground">
                                <th className="px-2.5 py-1.5 font-medium">Type</th>
                                <th className="px-2.5 py-1.5 font-medium">Name</th>
                                <th className="px-2.5 py-1.5 font-medium">Value</th>
                              </tr>
                            </thead>
                            <tbody>
                              {domain.dnsRecords.map((rec, i) => (
                                <tr key={i} className="border-b border-border align-top last:border-0">
                                  <td className="px-2.5 py-2 font-mono">{rec.type}</td>
                                  <td className="px-2.5 py-2">
                                    <div className="flex items-start gap-1.5">
                                      <code className="break-all font-mono">{rec.name}</code>
                                      <button
                                        type="button"
                                        aria-label="Copy name"
                                        onClick={() => handleCopyRecord(`${i}-name`, rec.name)}
                                        className="mt-0.5 shrink-0 text-muted-foreground hover:text-foreground"
                                      >
                                        {copiedRecord === `${i}-name` ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                                      </button>
                                    </div>
                                  </td>
                                  <td className="px-2.5 py-2">
                                    <div className="flex items-start gap-1.5">
                                      <code className="break-all font-mono">{rec.value}</code>
                                      <button
                                        type="button"
                                        aria-label="Copy value"
                                        onClick={() => handleCopyRecord(`${i}-value`, rec.value)}
                                        className="mt-0.5 shrink-0 text-muted-foreground hover:text-foreground"
                                      >
                                        {copiedRecord === `${i}-value` ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                                      </button>
                                    </div>
                                    <p className="mt-1 text-[11px] text-muted-foreground">{rec.note}</p>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}

                    {domain.status === "active" && (
                      <p className="text-xs text-muted-foreground">
                        Your site is live at this domain. You can remove the SSL/ownership TXT records now if you like; keep the CNAME in place.
                      </p>
                    )}

                    {domain.verificationErrors.length > 0 && (
                      <Alert variant="destructive">
                        <AlertDescription>
                          <ul className="list-disc pl-4">
                            {domain.verificationErrors.map((err, i) => <li key={i}>{err}</li>)}
                          </ul>
                        </AlertDescription>
                      </Alert>
                    )}
                  </div>
                )}

                {domainError && (
                  <Alert variant="destructive">
                    <AlertDescription>{domainError}</AlertDescription>
                  </Alert>
                )}
              </div>
              </>
            )}
          </div>
        </>
      )}

      {/* Features section - admins and owners only */}
      {isAdminOrOwner && (
        <>
          <Separator className="my-10" />
          <div className="flex flex-col gap-4">
            <div id="features">
              <h3 className="text-base font-semibold">Features</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Enable or disable features for this site.
              </p>
            </div>
            {!!(project.features & 2) && (
              <>
                <div className="flex items-center justify-between rounded-md border border-border px-4 py-3">
                  <div className="flex flex-col gap-0.5">
                    <p className="text-sm font-medium flex items-center gap-2">AI Features <PremiumBadge /></p>
                    <p className="text-xs text-muted-foreground">
                      Enable AI-powered document summarization.
                    </p>
                  </div>
                  <Switch
                    checked={project.ai_enabled === 1}
                    onCheckedChange={handleToggleAi}
                    disabled={togglingAi}
                  />
                </div>
                {project.ai_enabled === 1 && (
                  <div className="flex items-center justify-between rounded-md border border-border px-4 py-3">
                    <div className="flex flex-col gap-0.5">
                      <p className="text-sm font-medium">AI Summarization Type</p>
                      <p className="text-xs text-muted-foreground">
                        Automatic generates a summary when a page is loaded. Manual only summarizes when the sparkle button is pressed.
                      </p>
                    </div>
                    <Select
                      value={project.ai_summarization_type ?? "manual"}
                      onValueChange={handleAiSummarizationTypeChange}
                      disabled={togglingAiType}
                    >
                      <SelectTrigger className="w-36">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="automatic">Automatic</SelectItem>
                        <SelectItem value="manual">Manual</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </>
            )}
            <div className="flex items-center justify-between rounded-md border border-border px-4 py-3">
              <div className="flex flex-col gap-0.5">
                <p className="text-sm font-medium">Save Changelog</p>
                <p className="text-xs text-muted-foreground">
                  Prompt editors to leave a note describing their changes when saving a document.
                </p>
              </div>
              <Select
                value={project.changelog_mode}
                onValueChange={handleChangelogModeChange}
                disabled={togglingChangelog}
              >
                <SelectTrigger className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="off">Off</SelectItem>
                  <SelectItem value="on">On</SelectItem>
                  <SelectItem value="enforced">Enforced</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center justify-between rounded-md border border-border px-4 py-3">
              <div className="flex flex-col gap-0.5">
                <p className="text-sm font-medium flex items-center gap-2">
                  <House className="h-4 w-4 text-muted-foreground" />
                  Home Document
                </p>
                <p className="text-xs text-muted-foreground">
                  Pin a home document that visitors land on when the site URL has no document specified.
                </p>
              </div>
              <Switch
                checked={!!project.home_doc_id}
                onCheckedChange={handleToggleHomeDoc}
                disabled={togglingHomeDoc}
              />
            </div>
            <div className="rounded-md border border-border">
              <div className="flex items-center justify-between px-4 py-3">
                <div className="flex flex-col gap-0.5">
                  <p className="text-sm font-medium flex items-center gap-2">
                    <Network className="h-4 w-4 text-muted-foreground" />
                    Graph View
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Show an interactive graph of how documents link to each other.
                  </p>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  {project.graph_enabled === 1 && (() => {
                    const now = new Date();
                    const locked = reindexAvailableAt !== null && reindexAvailableAt > now;
                    const minsLeft = locked ? Math.ceil((reindexAvailableAt!.getTime() - now.getTime()) / 60000) : 0;
                    return (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-muted-foreground hover:text-foreground"
                        disabled={locked || reindexing}
                        onClick={handleReindex}
                        title={locked ? `Reindex available in ${minsLeft} min` : "Reindex graph"}
                      >
                        <RefreshCw className={`h-3.5 w-3.5 ${reindexing ? "animate-spin" : ""}`} />
                      </Button>
                    );
                  })()}
                  <Switch
                    checked={project.graph_enabled === 1}
                    onCheckedChange={handleToggleGraph}
                    disabled={togglingGraph}
                  />
                </div>
              </div>
              {project.graph_enabled === 1 && (
                <>
                  <div className="flex items-center justify-between border-t border-border px-4 py-3">
                    <div className="flex flex-col gap-0.5">
                      <p className="text-sm font-medium">Show on Published Site</p>
                      <p className="text-xs text-muted-foreground">
                        Make the graph view available to visitors of the public share page.
                      </p>
                    </div>
                    <Switch
                      checked={project.published_graph_enabled === 1}
                      onCheckedChange={handleTogglePublishedGraph}
                      disabled={togglingPublishedGraph}
                    />
                  </div>
                  <div className="border-t border-border">
                    <button
                      type="button"
                      className="flex w-full items-center justify-between px-4 py-2.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
                      onClick={() => setTagColorsOpen(o => !o)}
                    >
                      Tag Colors
                      <ChevronDown className={`h-3.5 w-3.5 transition-transform ${tagColorsOpen ? "rotate-180" : ""}`} />
                    </button>
                  </div>
                  {tagColorsOpen && (
                    <div className="border-t border-border px-4 py-3 flex flex-col gap-2.5">
                      <p className="text-xs text-muted-foreground">
                        Color graph nodes by frontmatter tag. The first matching tag wins.
                      </p>
                      <div className="flex flex-col gap-2">
                        {tagColorRules.map(rule => (
                          <div key={rule.id} className="flex items-center gap-2">
                            <Input
                              placeholder="tag-name"
                              value={rule.tag}
                              onChange={e => updateTagRuleTag(rule.id, e.target.value)}
                              className="flex-1 h-8 text-sm"
                            />
                            <div className="relative shrink-0">
                              <button
                                type="button"
                                className="w-6 h-6 rounded-full border border-border cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                style={{ backgroundColor: rule.color }}
                                aria-label="Pick color"
                                onClick={() => {
                                  const el = document.getElementById(`tag-color-${rule.id}`);
                                  if (el) (el as HTMLInputElement).click();
                                }}
                              />
                              <input
                                id={`tag-color-${rule.id}`}
                                type="color"
                                className="sr-only"
                                value={rule.color}
                                onChange={e => updateTagRuleColor(rule.id, e.target.value)}
                              />
                            </div>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6 shrink-0 text-muted-foreground hover:text-destructive"
                              onClick={() => removeTagRule(rule.id)}
                            >
                              <X className="h-3 w-3" />
                            </Button>
                          </div>
                        ))}
                      </div>
                      <div className="flex items-center gap-3 pt-0.5">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="gap-1.5 h-7 text-xs"
                          onClick={addTagRule}
                        >
                          <Plus className="h-3 w-3" />
                          Add another tag
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          className="h-7 text-xs"
                          disabled={savingTagColors}
                          onClick={saveTagColors}
                        >
                          {savingTagColors ? "Saving…" : "Save"}
                        </Button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </>
      )}

      {/* Members section - admins and owners only */}
      {isAdminOrOwner && (
        <>
          <Separator className="my-10" />

          <div id="members" className="flex flex-col gap-6">
            <div>
              <h3 className="text-base font-semibold">Members</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Manage who has access to this site.
              </p>
            </div>

            {/* Role legend */}
            <div className="rounded-md border border-border bg-muted/40 p-4">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Permission levels</p>
              <div className="flex flex-col gap-1.5">
                {(["limited", "viewer", "editor", "admin", "owner"] as Role[]).map(role => (
                  <div key={role} className="flex items-center gap-2 text-sm">
                    <RoleBadge role={role} />
                    <span className="text-muted-foreground">{ROLE_DESCRIPTIONS[role]}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Member list */}
            {loadingMembers ? (
              <p className="text-sm text-muted-foreground">Loading members…</p>
            ) : (
              <div className="flex flex-col divide-y divide-border rounded-md border border-border">
                {members.map(member => {
                  const isMe = member.userId === currentUser?.userId;
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
                          <Select
                            value={member.role}
                            onValueChange={val => handleRoleChange(member, val as Role)}
                          >
                            <SelectTrigger className="h-7 w-28 text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {(isOwner ? ASSIGNABLE_ROLES : ASSIGNABLE_ROLES.filter(r => ROLE_RANK[r] < ROLE_RANK["admin"])).map(role => (
                                <SelectItem key={role} value={role} className="text-xs">
                                  {ROLE_LABELS[role]}
                                </SelectItem>
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
                            className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive"
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
            )}

            {/* Invite links */}
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-medium">Invite links</h4>
                <Dialog open={createLinkOpen} onOpenChange={setCreateLinkOpen}>
                  <DialogTrigger asChild>
                    <Button variant="outline" size="sm">Create link</Button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>Create invite link</DialogTitle>
                      <DialogDescription>
                        Anyone with the link can join this project with the selected role.
                      </DialogDescription>
                    </DialogHeader>
                    <div className="flex flex-col gap-4 py-2">
                      <div className="flex flex-col gap-1.5">
                        <Label>Role</Label>
                        <Select value={newLinkRole} onValueChange={val => setNewLinkRole(val as Role)}>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {(isOwner ? ASSIGNABLE_ROLES : ASSIGNABLE_ROLES.filter(r => ROLE_RANK[r] < ROLE_RANK["admin"])).map(role => (
                              <SelectItem key={role} value={role}>{ROLE_LABELS[role]}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <Label>Max uses <span className="text-muted-foreground font-normal">(leave blank for unlimited)</span></Label>
                        <Input
                          type="number"
                          min={1}
                          placeholder="Unlimited"
                          value={newLinkMaxUses}
                          onChange={e => setNewLinkMaxUses(e.target.value)}
                        />
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <Label>Expires</Label>
                        <Select value={newLinkExpiry} onValueChange={setNewLinkExpiry}>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {EXPIRY_OPTIONS.map(opt => (
                              <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                    <DialogFooter>
                      <Button variant="outline" onClick={() => setCreateLinkOpen(false)}>Cancel</Button>
                      <Button onClick={handleCreateLink} disabled={creatingLink}>
                        {creatingLink ? "Creating…" : "Create link"}
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              </div>

              {loadingLinks ? (
                <p className="text-sm text-muted-foreground">Loading…</p>
              ) : inviteLinks.filter(l => l.isActive && (l.maxUses === null || l.useCount < l.maxUses)).length === 0 ? (
                <p className="text-sm text-muted-foreground">No invite links yet.</p>
              ) : (
                <div className="flex flex-col divide-y divide-border rounded-md border border-border">
                  {inviteLinks.filter(l => l.isActive && (l.maxUses === null || l.useCount < l.maxUses)).map(link => (
                    <div key={link.id} className="flex items-center gap-3 px-4 py-3">
                      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <div className="flex items-center gap-2">
                          <RoleBadge role={link.role} />
                        </div>
                        <div className="flex gap-2 text-xs text-muted-foreground">
                          <span>{link.maxUses ? `${link.useCount} / ${link.maxUses} uses` : `${link.useCount} uses`}</span>
                          <span>·</span>
                          <span>{expiryLabel(link.expiresAt)}</span>
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs gap-1.5"
                        onClick={() => handleCopyLink(link)}
                      >
                        {copiedLinkId === link.id ? <Check className="size-3" /> : <Copy className="size-3" />}
                        {copiedLinkId === link.id ? "Copied" : "Copy"}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive gap-1.5"
                        disabled={revokingLinkId === link.id}
                        onClick={() => handleRevokeLink(link.id)}
                      >
                        <X className="size-3" />
                        {revokingLinkId === link.id ? "Revoking…" : "Revoke"}
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Invite form */}
            <form onSubmit={handleInvite} className="flex flex-col gap-3">
              <h4 className="text-sm font-medium">Invite a member</h4>
              <div className="flex gap-2">
                <Input
                  type="email"
                  placeholder="user@example.com"
                  value={inviteEmail}
                  onChange={e => setInviteEmail(e.target.value)}
                  required
                  className="flex-1"
                />
                <Select value={inviteRole} onValueChange={val => setInviteRole(val as Role)}>
                  <SelectTrigger className="w-28">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ASSIGNABLE_ROLES.map(role => (
                      <SelectItem key={role} value={role}>
                        {ROLE_LABELS[role]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button type="submit" disabled={inviting}>
                  {inviting ? "Adding…" : "Add"}
                </Button>
              </div>
              {inviteError && (
                <Alert variant="destructive">
                  <AlertDescription>{inviteError}</AlertDescription>
                </Alert>
              )}
            </form>
          </div>
        </>
      )}

      {/* API keys - any member; scope is a ceiling enforced live on every request */}
      {myRole !== null && (
        <>
          <Separator className="my-10" />

          <div id="api-keys" className="flex flex-col gap-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-base font-semibold">API Keys</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  Scoped keys for the <span className="font-medium text-foreground">/v1</span> REST API. Each key is
                  bound to this site and can never do more than your own role allows. Keep them secret - treat a key
                  like a password.
                </p>
              </div>
              <Dialog open={createKeyOpen} onOpenChange={open => { setCreateKeyOpen(open); if (!open) setCreateKeyError(null); }}>
                <DialogTrigger asChild>
                  <Button size="sm" className="shrink-0"><Plus className="size-4" /> New key</Button>
                </DialogTrigger>
                <DialogContent>
                  <form onSubmit={handleCreateKey}>
                    <DialogHeader>
                      <DialogTitle>Create API key</DialogTitle>
                      <DialogDescription>
                        The secret is shown once, right after creation. Store it somewhere safe - it can't be retrieved again.
                      </DialogDescription>
                    </DialogHeader>
                    <div className="flex flex-col gap-4 py-4">
                      <div className="flex flex-col gap-1.5">
                        <Label htmlFor="new-key-name">Name</Label>
                        <Input
                          id="new-key-name"
                          placeholder="e.g. CI publish bot"
                          value={newKeyName}
                          onChange={e => setNewKeyName(e.target.value)}
                          maxLength={100}
                          required
                        />
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <Label>Access</Label>
                        <Select value={newKeyScope} onValueChange={val => setNewKeyScope(val as ApiKeyScope)} disabled={!canMintWriteKey}>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="read">Read only</SelectItem>
                            {canMintWriteKey && <SelectItem value="readwrite">Read &amp; write</SelectItem>}
                          </SelectContent>
                        </Select>
                        {!canMintWriteKey && (
                          <p className="text-xs text-muted-foreground">
                            Your role on this site is read-only, so keys you create can only read.
                          </p>
                        )}
                      </div>
                      {canMintInviteKey && (
                        <div className="flex items-start justify-between gap-4 rounded-md border border-border px-3 py-2.5">
                          <div className="flex flex-col gap-0.5">
                            <Label htmlFor="new-key-invite" className="cursor-pointer">Manage members</Label>
                            <p className="text-xs text-muted-foreground">
                              Allow this key to invite and remove members. Still requires you to remain an admin of this site.
                            </p>
                          </div>
                          <Switch id="new-key-invite" checked={newKeyCanInvite} onCheckedChange={setNewKeyCanInvite} />
                        </div>
                      )}
                      {createKeyError && (
                        <Alert variant="destructive">
                          <AlertDescription>{createKeyError}</AlertDescription>
                        </Alert>
                      )}
                    </div>
                    <DialogFooter>
                      <Button type="submit" disabled={creatingKey || !newKeyName.trim()}>
                        {creatingKey ? "Creating…" : "Create key"}
                      </Button>
                    </DialogFooter>
                  </form>
                </DialogContent>
              </Dialog>
            </div>

            {/* Key list */}
            {loadingKeys ? (
              <p className="text-sm text-muted-foreground">Loading keys…</p>
            ) : apiKeys.length === 0 ? (
              <p className="text-sm text-muted-foreground">No API keys yet. Create one to use the /v1 API.</p>
            ) : (
              <div className="flex flex-col divide-y divide-border rounded-md border border-border">
                {apiKeys.map(key => (
                  <div key={key.id} className="flex items-center gap-3 px-4 py-3">
                    <KeyRound className="size-4 shrink-0 text-muted-foreground" />
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-sm font-medium">{key.name}</span>
                      <span className="truncate font-mono text-xs text-muted-foreground">
                        {key.keyPrefix}… · {key.lastUsedAt ? `last used ${new Date(key.lastUsedAt).toLocaleDateString()}` : "never used"}
                      </span>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Badge variant="outline" className="text-xs font-medium">
                        {key.scope === "readwrite" ? "Read & write" : "Read"}
                      </Badge>
                      {key.canInvite && (
                        <Badge variant="outline" className="text-xs font-medium bg-blue-100 text-blue-700 border-blue-300 dark:bg-blue-950 dark:text-blue-300 dark:border-blue-800">
                          Members
                        </Badge>
                      )}
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive"
                            disabled={revokingKeyId === key.id}
                          >
                            {revokingKeyId === key.id ? "Revoking…" : "Revoke"}
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Revoke "{key.name}"?</AlertDialogTitle>
                            <AlertDialogDescription>
                              Any integration using this key will immediately stop working. This cannot be undone.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction
                              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                              onClick={() => handleRevokeKey(key)}
                            >
                              Revoke key
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Usage hint */}
            <div className="rounded-md border border-border bg-muted/40 p-4">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Using your key</p>
              <pre className="overflow-x-auto rounded bg-background p-3 text-xs leading-relaxed text-muted-foreground">
{`curl ${window.location.origin}/api/v1/docs \\
  -H "Authorization: Bearer annx_your_key_here"`}
              </pre>
              <p className="mt-2 text-xs text-muted-foreground">
                Base URL <span className="font-mono">{window.location.origin}/api/v1</span>. See the full API reference for
                endpoints, scopes and rate limits.
              </p>
            </div>
          </div>

          {/* One-time secret reveal */}
          <Dialog open={newKeySecret !== null} onOpenChange={open => { if (!open) { setNewKeySecret(null); setCopiedSecret(false); } }}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Copy your API key</DialogTitle>
                <DialogDescription>
                  This is the only time you'll see this key. Copy it now and store it securely.
                </DialogDescription>
              </DialogHeader>
              <div className="flex items-center gap-2 py-2">
                <Input readOnly value={newKeySecret ?? ""} className="font-mono text-xs" onFocus={e => e.currentTarget.select()} />
                <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={handleCopySecret}>
                  {copiedSecret ? <Check className="size-4" /> : <Copy className="size-4" />}
                  {copiedSecret ? "Copied" : "Copy"}
                </Button>
              </div>
              <DialogFooter>
                <Button type="button" onClick={() => { setNewKeySecret(null); setCopiedSecret(false); }}>Done</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </>
      )}

      {/* Danger zone */}
      {myRole !== null && (
        <>
          <Separator className="my-10" />

          <div id="danger" className="flex flex-col gap-3">
            <h3 className="text-base font-semibold text-destructive">Danger Zone</h3>

            {isAdminOrOwner && (
              <div className="flex items-start justify-between gap-4 rounded-md border border-border px-4 py-3">
                <div className="flex flex-col gap-0.5">
                  <p className="text-sm font-medium">Export site</p>
                  <p className="text-xs text-muted-foreground">
                    Download a .zip of every document and uploaded file in this site, with folders preserved.
                  </p>
                </div>
                <Button variant="outline" onClick={handleExport} disabled={exporting} className="shrink-0">
                  {exporting ? "Exporting…" : "Export site"}
                </Button>
              </div>
            )}

            {isOwner ? (
              <>
                <p className="text-sm text-muted-foreground">
                  Deleting this site will permanently remove all of its documents and members. This action cannot be undone.
                </p>

                <AlertDialog open={deleteOpen} onOpenChange={open => { setDeleteOpen(open); if (!open) setDeleteError(null); }}>
                  <AlertDialogTrigger asChild>
                    <Button variant="destructive" className="self-start">Delete site</Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Delete "{project.name}"?</AlertDialogTitle>
                      <AlertDialogDescription>
                        This will permanently delete the site and all of its documents. This action cannot be undone.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    {deleteError && (
                      <Alert variant="destructive">
                        <AlertDescription>{deleteError}</AlertDescription>
                      </Alert>
                    )}
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction
                        className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        disabled={deleting}
                        onClick={handleDelete}
                      >
                        {deleting ? "Deleting…" : "Yes, delete"}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">
                  Leaving this site will remove your access. You will need to be re-invited to regain access.
                </p>

                <AlertDialog open={leaveOpen} onOpenChange={open => { setLeaveOpen(open); if (!open) setLeaveError(null); }}>
                  <AlertDialogTrigger asChild>
                    <Button variant="destructive" className="self-start">Leave site</Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Leave "{project.name}"?</AlertDialogTitle>
                      <AlertDialogDescription>
                        You will lose access to this site immediately. You will need to be re-invited to regain access.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    {leaveError && (
                      <Alert variant="destructive">
                        <AlertDescription>{leaveError}</AlertDescription>
                      </Alert>
                    )}
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction
                        className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        disabled={leaving}
                        onClick={handleLeave}
                      >
                        {leaving ? "Leaving…" : "Yes, leave"}
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

function PremiumBadge() {
  return (
    <Badge variant="outline" className="text-[10px] font-semibold px-1.5 py-0 bg-yellow-100 text-yellow-700 border-yellow-300 dark:bg-yellow-950 dark:text-yellow-300 dark:border-yellow-800">
      PREMIUM
    </Badge>
  );
}

function RoleBadge({ role }: { role: Role }) {
  const variants: Record<Role, string> = {
    owner: "bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-300",
    admin: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
    editor: "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300",
    viewer: "bg-muted text-muted-foreground",
    limited: "bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-300",
  };
  return (
    <Badge variant="outline" className={`shrink-0 text-xs font-medium ${variants[role]}`}>
      {ROLE_LABELS[role]}
    </Badge>
  );
}
