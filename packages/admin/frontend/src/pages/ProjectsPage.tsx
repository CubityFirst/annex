import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ChevronDown, ChevronRight, Globe, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetTrigger,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetBody,
  SheetFooter,
} from "@/components/ui/sheet";
import { CursorPaginationFooter } from "@/components/CursorPaginationFooter";
import { DetailField } from "@/components/DetailField";
import { expandableRowProps } from "@/components/ExpandableRow";
import { SearchInput } from "@/components/SearchInput";
import { useCursorPagination } from "@/hooks/useCursorPagination";
import { formatDate, formatDateTime, initials } from "@/lib/format";
import {
  type AdminProject,
  type AdminProjectDetails,
  listProjects,
  getProjectDetails,
  fetchProjectLogo,
  updateProjectFeatures,
  deleteProject,
  reindexProjectFts,
  removeProjectDomain,
} from "@/lib/api";

const ProjectFeatures = {
  CUSTOM_LINK: 1,
  AI_FEATURES: 2,
  REALTIME:    4,
} as const;

const FEATURE_FLAGS = [
  {
    bit: ProjectFeatures.CUSTOM_LINK,
    label: "Custom Link & Domain",
    description: "Enables a custom slug (/s/SLUG) and mapping the site to the owner's own domain (e.g. docs.example.com) via Cloudflare for SaaS, configured in Site Settings.",
  },
  {
    bit: ProjectFeatures.AI_FEATURES,
    label: "AI Features",
    description: "Enables AI-generated summaries for documents in this project.",
  },
  {
    bit: ProjectFeatures.REALTIME,
    label: "Realtime Collaboration",
    description: "Enables live co-editing, presence avatars, and per-user cursors in the document editor.",
  },
] as const;

function hasFlag(features: number, bit: number): boolean {
  return (features & bit) !== 0;
}

function setFlag(features: number, bit: number, enabled: boolean): number {
  return enabled ? features | bit : features & ~bit;
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, exp);
  return `${value.toFixed(exp === 0 ? 0 : 1)} ${units[exp]}`;
}

function FeatureState({ on, label }: { on: boolean; label: string }) {
  return <Badge variant={on ? "default" : "outline"}>{label}: {on ? "On" : "Off"}</Badge>;
}

// Site logo for the admin sheet. The endpoint is auth-gated, so we can't point
// an <img src> at it directly - fetch the bytes with the bearer token and
// render an object URL, revoking it on unmount/change. Falls back to a neutral
// initial tile when the site has no logo of that variant.
function ProjectLogo({
  projectId,
  variant,
  name,
  hasLogo,
  className,
}: {
  projectId: string;
  variant: "square" | "wide";
  name: string;
  hasLogo: boolean;
  className?: string;
}) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    if (!hasLogo) {
      setSrc(null);
      return;
    }
    let cancelled = false;
    let objectUrl: string | null = null;
    void fetchProjectLogo(projectId, variant).then(blob => {
      if (cancelled || !blob) return;
      objectUrl = URL.createObjectURL(blob);
      setSrc(objectUrl);
    });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [projectId, variant, hasLogo]);

  if (src) {
    return <img src={src} alt={`${name} ${variant} logo`} className={className} />;
  }
  return (
    <div className={`flex items-center justify-center bg-muted text-muted-foreground font-medium ${className ?? ""}`}>
      {initials(name)}
    </div>
  );
}

function ProjectDetailsLoadingState() {
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 md:grid-cols-2">
        {Array.from({ length: 2 }).map((_, i) => (
          <Card key={i}>
            <CardHeader><CardTitle><Skeleton className="h-4 w-24" /></CardTitle></CardHeader>
            <CardContent className="flex flex-col gap-3">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-5/6" />
            </CardContent>
          </Card>
        ))}
      </div>
      <Card>
        <CardHeader><CardTitle><Skeleton className="h-4 w-24" /></CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
        </CardContent>
      </Card>
    </div>
  );
}

function ProjectDetailsPanel({ details }: { details: AdminProjectDetails }) {
  const { profile, branding, organization, settings, members, content } = details;
  const grantedFeatures = FEATURE_FLAGS.filter(f => hasFlag(settings.features, f.bit));

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Site</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <DetailField
              label="Status"
              value={profile.published ? <Badge>Published</Badge> : <Badge variant="outline">Draft</Badge>}
            />
            <DetailField label="Site ID" value={<span className="font-mono text-xs">{profile.id}</span>} />
            <DetailField label="Created" value={formatDateTime(profile.created_at)} />
            {profile.published && profile.published_at && (
              <DetailField label="Published" value={formatDateTime(profile.published_at)} />
            )}
            <DetailField
              label="Description"
              value={profile.description?.trim()
                ? profile.description
                : <span className="text-muted-foreground">None</span>}
            />
            <DetailField label="Changelog mode" value={<span className="capitalize">{profile.changelog_mode}</span>} />
            <DetailField
              label="Home doc"
              value={profile.home_doc_id
                ? <span className="font-mono text-xs">{profile.home_doc_id}</span>
                : <span className="text-muted-foreground">Default (doc list)</span>}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Ownership</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <DetailField
              label="Owner"
              value={profile.owner ? (
                <div className="flex flex-col">
                  <span>{profile.owner.name ?? "Unknown"}</span>
                  <span className="font-mono text-xs text-muted-foreground">
                    {profile.owner.email ?? profile.owner.id}
                  </span>
                </div>
              ) : (
                <span className="text-muted-foreground">Unknown (owner account deleted)</span>
              )}
            />
            <DetailField
              label="Owner ID"
              value={<span className="font-mono text-xs">{profile.owner?.id ?? "-"}</span>}
            />
            <DetailField
              label="Organization"
              value={organization ? (
                <div className="flex flex-col">
                  <span>{organization.name || "Unnamed org"}</span>
                  <span className="font-mono text-xs text-muted-foreground">{organization.id}</span>
                </div>
              ) : (
                <span className="text-muted-foreground">Standalone (no organization)</span>
              )}
            />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Branding</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <DetailField
              label="Vanity slug"
              value={branding.vanity_slug
                ? <span className="font-mono">/s/{branding.vanity_slug}</span>
                : <span className="text-muted-foreground">None</span>}
            />
            <DetailField
              label="Custom domain"
              value={branding.custom_domain ? (
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-mono">{branding.custom_domain.hostname}</span>
                  {branding.custom_domain.status && (
                    <Badge variant="outline">{branding.custom_domain.status}</Badge>
                  )}
                </span>
              ) : (
                <span className="text-muted-foreground">None</span>
              )}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Square logo</p>
              {branding.logo_square_updated_at ? (
                <div className="flex items-center gap-3">
                  <ProjectLogo
                    projectId={profile.id}
                    variant="square"
                    name={profile.name}
                    hasLogo
                    className="size-12 rounded-md border bg-muted object-cover"
                  />
                  <span className="text-xs text-muted-foreground">
                    Updated {formatDateTime(branding.logo_square_updated_at)}
                  </span>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">Not set</p>
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Wide logo</p>
              {branding.logo_wide_updated_at ? (
                <div className="flex flex-col gap-2">
                  <ProjectLogo
                    projectId={profile.id}
                    variant="wide"
                    name={profile.name}
                    hasLogo
                    className="h-12 w-auto max-w-full rounded-md border bg-muted object-contain px-2"
                  />
                  <span className="text-xs text-muted-foreground">
                    Updated {formatDateTime(branding.logo_wide_updated_at)}
                  </span>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">Not set</p>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Content</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-4">
            <DetailField label="Total docs" value={content.docs.total} />
            <DetailField label="Published" value={content.docs.published} />
            <DetailField label="Drafts" value={content.docs.drafts} />
            <DetailField label="With AI summary" value={content.docs.with_ai_summary} />
            <DetailField label="Folders" value={content.folders} />
            <DetailField label="Files" value={`${content.files.count} (${formatBytes(content.files.total_bytes)})`} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Features</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Granted (admin)</p>
              {grantedFeatures.length === 0 ? (
                <p className="text-sm text-muted-foreground">No feature flags granted.</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {grantedFeatures.map(f => (
                    <Badge key={f.bit} variant="secondary">{f.label}</Badge>
                  ))}
                </div>
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Owner-enabled</p>
              <div className="flex flex-wrap gap-1.5">
                <FeatureState on={settings.ai_enabled} label="AI" />
                <FeatureState on={settings.graph_enabled} label="Graph" />
                <FeatureState on={settings.published_graph_enabled} label="Public graph" />
              </div>
              {settings.ai_enabled && (
                <p className="text-xs text-muted-foreground">AI summaries: {settings.ai_summarization_type}</p>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Members</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">{members.accepted} member{members.accepted === 1 ? "" : "s"}</span>
            {members.pending > 0 && <Badge variant="outline">{members.pending} pending</Badge>}
            {members.by_role.length > 0 && (
              <span className="ml-auto flex flex-wrap gap-1.5">
                {members.by_role.map(r => (
                  <Badge key={r.role} variant="secondary">{r.count} {r.role}</Badge>
                ))}
              </span>
            )}
          </div>
          {members.list.length === 0 ? (
            <p className="text-sm text-muted-foreground">This site has no members.</p>
          ) : (
            members.list.map(m => (
              <div key={m.id} className="rounded-lg border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-medium">{m.name}</p>
                  <div className="flex items-center gap-2">
                    {!m.accepted && <Badge variant="outline">Pending</Badge>}
                    <Badge variant={m.role === "owner" ? "default" : "secondary"}>{m.role}</Badge>
                  </div>
                </div>
                <p className="mt-1 font-mono text-xs text-muted-foreground">{m.email}</p>
                <p className="mt-2 text-xs text-muted-foreground">Joined {formatDateTime(m.created_at)}</p>
              </div>
            ))
          )}
          {members.list.length >= 250 && (
            <p className="text-xs text-muted-foreground">Showing the first 250 members.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

interface ProjectRowProps {
  project: AdminProject;
  onSaved: (id: string, features: number) => void;
  onDeleted: () => void;
  onDomainRemoved: () => void;
}

function ProjectRow({ project, onSaved, onDeleted, onDomainRemoved }: ProjectRowProps) {
  const [expanded, setExpanded] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [savedFeatures, setSavedFeatures] = useState(project.features);
  const [pendingFeatures, setPendingFeatures] = useState(project.features);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteConfirmName, setDeleteConfirmName] = useState("");
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [reindexing, setReindexing] = useState(false);
  const [removingDomain, setRemovingDomain] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [details, setDetails] = useState<AdminProjectDetails | null>(null);

  useEffect(() => {
    setSavedFeatures(project.features);
    setPendingFeatures(project.features);
  }, [project.features]);

  function handleSheetOpen(open: boolean) {
    setSheetOpen(open);
    if (open) setPendingFeatures(savedFeatures);
  }

  async function loadDetails(force = false) {
    if (detailsLoading) return;
    if (!force && details) return;
    setDetailsLoading(true);
    try {
      setDetails(await getProjectDetails(project.id));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load project details");
    } finally {
      setDetailsLoading(false);
    }
  }

  function handleDetailsOpenChange(open: boolean) {
    setDetailsOpen(open);
    // Always refetch on open so the sheet can't show stale data across
    // close/reopen (cached details keep rendering while the refresh runs).
    if (open) void loadDetails(true);
  }

  async function handleApply() {
    setSaving(true);
    try {
      await updateProjectFeatures(project.id, pendingFeatures);
      setSavedFeatures(pendingFeatures);
      onSaved(project.id, pendingFeatures);
      // Keep the details sheet's "granted features" in sync if it's been opened.
      if (details) void loadDetails(true);
      setSheetOpen(false);
      toast.success("Feature flags saved");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save features");
    } finally {
      setSaving(false);
    }
  }

  function handleDeleteDialogChange(open: boolean) {
    setDeleteDialogOpen(open);
    if (!open) setDeleteConfirmName("");
  }

  async function handleDelete() {
    setDeleting(true);
    try {
      await deleteProject(project.id);
      handleDeleteDialogChange(false);
      onDeleted();
      toast.success("Project deleted");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to delete project");
    } finally {
      setDeleting(false);
    }
  }

  async function handleReindex() {
    setReindexing(true);
    try {
      const result = await reindexProjectFts(project.id);
      toast.success(`Search index rebuilt (${result.indexed} docs)`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to reindex search");
    } finally {
      setReindexing(false);
    }
  }

  async function handleRemoveDomain() {
    setRemovingDomain(true);
    try {
      const { hostname } = await removeProjectDomain(project.id);
      // Refresh the list AND an open details sheet - both display the domain.
      onDomainRemoved();
      if (details) void loadDetails(true);
      toast.success(hostname ? `Removed custom domain ${hostname}` : "No custom domain was mapped");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to remove custom domain");
    } finally {
      setRemovingDomain(false);
    }
  }

  const dirty = pendingFeatures !== savedFeatures;
  const deleteNameMatches = deleteConfirmName.trim() === project.name;

  return (
    <>
      <TableRow {...expandableRowProps(expanded, setExpanded)}>
        <TableCell className="w-8 pr-0">
          {expanded
            ? <ChevronDown className="h-4 w-4 text-muted-foreground" />
            : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
        </TableCell>
        <TableCell className="font-medium whitespace-normal">
          {project.name}
          <span className="mt-0.5 block font-mono text-[11px] font-normal text-muted-foreground sm:hidden">
            {project.id}
          </span>
          <span className="mt-0.5 block text-[11px] font-normal text-muted-foreground md:hidden">
            {formatDate(project.created_at)}
          </span>
        </TableCell>
        <TableCell className="hidden font-mono text-xs text-muted-foreground sm:table-cell">{project.id}</TableCell>
        <TableCell className="hidden text-xs text-muted-foreground md:table-cell">
          {formatDate(project.created_at)}
        </TableCell>
      </TableRow>
      {expanded && (
        <TableRow className="hover:bg-transparent bg-muted/20">
          <TableCell colSpan={4} className="py-3 pl-10 pr-6">
            <div className="flex flex-col gap-3" onClick={e => e.stopPropagation()}>
            <div className="flex flex-wrap items-center gap-2">
              <Sheet open={detailsOpen} onOpenChange={handleDetailsOpenChange}>
                <SheetTrigger asChild>
                  <Button size="sm" variant="secondary">
                    Project details
                  </Button>
                </SheetTrigger>
                <SheetContent className="max-w-3xl">
                  <SheetHeader>
                    <div className="flex items-center gap-3">
                      <ProjectLogo
                        projectId={project.id}
                        variant="square"
                        name={project.name}
                        hasLogo={!!details?.branding.logo_square_updated_at}
                        className="size-12 shrink-0 rounded-md border bg-muted object-cover"
                      />
                      <div className="min-w-0">
                        <SheetTitle className="truncate">{project.name}</SheetTitle>
                        <SheetDescription className="font-mono text-xs">{project.id}</SheetDescription>
                      </div>
                    </div>
                  </SheetHeader>
                  <SheetBody>
                    {detailsLoading && !details
                      ? <ProjectDetailsLoadingState />
                      : details
                        ? <ProjectDetailsPanel details={details} />
                        : <p className="text-sm text-muted-foreground">Project details could not be loaded.</p>}
                  </SheetBody>
                  <SheetFooter className="flex flex-row justify-end gap-2">
                    <Button type="button" variant="outline" disabled={detailsLoading} onClick={() => void loadDetails(true)}>
                      Refresh details
                    </Button>
                  </SheetFooter>
                </SheetContent>
              </Sheet>

              <Sheet open={sheetOpen} onOpenChange={handleSheetOpen}>
                <SheetTrigger asChild>
                  <Button size="sm" variant="outline">
                    Feature flags
                  </Button>
                </SheetTrigger>
                <SheetContent>
                  <SheetHeader>
                    <SheetTitle>Feature Flags</SheetTitle>
                    <SheetDescription>{project.name}</SheetDescription>
                    <p className="text-sm text-muted-foreground pt-1">These flags grant access to features, they don't force-enable anything. Users can toggle each feature themselves within their project settings.</p>
                  </SheetHeader>
                  <SheetBody className="space-y-5">
                    {FEATURE_FLAGS.map(({ bit, label, description }) => (
                      <div key={bit} className="flex items-start gap-3">
                        <Checkbox
                          id={`sheet-${project.id}-${bit}`}
                          checked={hasFlag(pendingFeatures, bit)}
                          onCheckedChange={checked =>
                            setPendingFeatures(f => setFlag(f, bit, !!checked))
                          }
                          className="mt-0.5"
                        />
                        <div>
                          <Label htmlFor={`sheet-${project.id}-${bit}`} className="cursor-pointer font-medium">
                            {label}
                          </Label>
                          <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
                        </div>
                      </div>
                    ))}
                  </SheetBody>
                  <SheetFooter>
                    <Button className="w-full" onClick={handleApply} disabled={saving || !dirty}>
                      {saving ? "Applying..." : "Apply"}
                    </Button>
                  </SheetFooter>
                </SheetContent>
              </Sheet>

              <Button size="sm" variant="outline" disabled={reindexing} onClick={handleReindex}>
                <RefreshCw className={`h-3.5 w-3.5 ${reindexing ? "animate-spin" : ""}`} />
                {reindexing ? "Reindexing..." : "Reindex search"}
              </Button>

              <Dialog open={deleteDialogOpen} onOpenChange={handleDeleteDialogChange}>
                <DialogTrigger asChild>
                  <Button size="sm" variant="destructive" disabled={deleting}>
                    <Trash2 className="h-3.5 w-3.5" />
                    {deleting ? "Deleting..." : "Delete project"}
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Delete project?</DialogTitle>
                    <DialogDescription>
                      This will permanently delete <strong>{project.name}</strong> and all associated docs,
                      files, and assets. This action cannot be undone.
                    </DialogDescription>
                  </DialogHeader>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor={`delete-confirm-${project.id}`}>
                      Type <span className="font-semibold">{project.name}</span> to confirm
                    </Label>
                    <Input
                      id={`delete-confirm-${project.id}`}
                      value={deleteConfirmName}
                      onChange={e => setDeleteConfirmName(e.target.value)}
                      placeholder={project.name}
                      autoComplete="off"
                    />
                  </div>
                  <DialogFooter>
                    <Button type="button" variant="outline" onClick={() => handleDeleteDialogChange(false)} disabled={deleting}>
                      Cancel
                    </Button>
                    <Button
                      type="button"
                      variant="destructive"
                      onClick={handleDelete}
                      disabled={deleting || !deleteNameMatches}
                    >
                      {deleting ? "Deleting..." : "Delete project"}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </div>

            {project.custom_domain && (
              <div className="flex items-center gap-2 text-sm">
                <Globe className="h-4 w-4 text-muted-foreground shrink-0" />
                <span className="text-muted-foreground">Custom domain:</span>
                <span className="font-mono">{project.custom_domain}</span>
                {project.custom_domain_status && (
                  <span className="text-xs text-muted-foreground">({project.custom_domain_status})</span>
                )}
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button size="sm" variant="destructive" className="ml-auto" disabled={removingDomain}>
                      <Trash2 className="h-3.5 w-3.5" />
                      {removingDomain ? "Removing..." : "Remove custom domain"}
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Remove custom domain?</AlertDialogTitle>
                      <AlertDialogDescription>
                        This unmaps <strong>{project.custom_domain}</strong> from <strong>{project.name}</strong>:
                        the Cloudflare custom hostname is deregistered and the mapping is cleared. The site itself
                        is untouched and the owner can map a domain again later. This cannot be undone.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction variant="destructive" onClick={handleRemoveDomain}>
                        Remove
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            )}
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

export function ProjectsPage() {
  // `query` is the live text box; `committedQuery` is the query actually being
  // paged over (set on submit). Paging keeps committedQuery and only moves the
  // cursor; submitting always refetches (even an unchanged query - that's the
  // page's refresh).
  const [query, setQuery] = useState("");
  const [committedQuery, setCommittedQuery] = useState("");

  const fetchPage = useCallback(
    async (cursor: string | undefined, signal: AbortSignal) => {
      const res = await listProjects({ q: committedQuery || undefined, cursor }, signal);
      return { items: res.projects, nextCursor: res.nextCursor };
    },
    [committedQuery],
  );
  const pager = useCursorPagination<AdminProject>(fetchPage);

  // Optimistic feature-flag overlay (same pattern as UsersPage overrides);
  // dropped on every refetch.
  const [featureOverrides, setFeatureOverrides] = useState<Record<string, number>>({});
  useEffect(() => {
    setFeatureOverrides({});
  }, [pager.items]);
  const projects = pager.items.map(p =>
    featureOverrides[p.id] !== undefined ? { ...p, features: featureOverrides[p.id] } : p,
  );

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    setCommittedQuery(query.trim());
    pager.reset();
  }

  function handleSaved(id: string, features: number) {
    setFeatureOverrides(prev => ({ ...prev, [id]: features }));
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Projects</h1>
        <p className="text-sm text-muted-foreground mt-1">Inspect site details and manage project feature flags.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Filter</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSearch} className="flex gap-2">
            <SearchInput
              value={query}
              onChange={setQuery}
              placeholder="Filter by name..."
              ariaLabel="Filter projects by name"
              className="max-w-sm w-full"
            />
            <Button type="submit" disabled={pager.loading}>
              Search
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-5">
          {pager.loading ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : projects.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">No projects found.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8" />
                  <TableHead>Name</TableHead>
                  <TableHead className="hidden sm:table-cell">ID</TableHead>
                  <TableHead className="hidden md:table-cell">Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {projects.map(project => (
                  <ProjectRow
                    key={project.id}
                    project={project}
                    onSaved={handleSaved}
                    onDeleted={() => pager.refresh()}
                    onDomainRemoved={() => pager.refresh()}
                  />
                ))}
              </TableBody>
            </Table>
          )}

          <CursorPaginationFooter pager={pager} />
        </CardContent>
      </Card>
    </div>
  );
}
