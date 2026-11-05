import { useState, useEffect } from "react";
import { Link, useNavigate, useOutletContext } from "react-router-dom";
import { BookOpen, Building2, ChevronDown, Eye, EyeOff, Globe, Lock, Mail, MoreHorizontal, Plus, Radio, Settings, Sparkles, Star, Users } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { getToken } from "@/lib/auth";
import type { DocsLayoutContext, ProjectListItem } from "@/layouts/DocsLayout";

type Project = ProjectListItem;

const REALTIME_FEATURE = 4;

// Shared square slot so every footer item (clickable button or static info icon)
// occupies the same footprint - uniform touch/visual regions across the row.
const FOOTER_SLOT = "flex h-11 w-11 shrink-0 items-center justify-center sm:h-8 sm:w-8";

interface Org {
  id: string;
  name: string;
  role: string;
  site_count: number;
  member_count: number;
}

export function DashboardPage() {
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [pendingCount, setPendingCount] = useState(0);
  const [hiddenOpen, setHiddenOpen] = useState(false);
  const navigate = useNavigate();
  // The site list lives in DocsLayout: it loads it for the sidebar and
  // refetches it with doc/member counts whenever the dashboard is entered.
  const { openCreateSite, openCreateOrg, projects, setProjects } = useOutletContext<DocsLayoutContext>();

  function sortByFavourite(list: Project[]) {
    return [...list].sort((a, b) => b.is_favourite - a.is_favourite);
  }

  async function handleToggleFavourite(e: React.MouseEvent, projectId: string) {
    e.stopPropagation();
    const token = getToken();
    // Favouriting unhides (the two are mutually exclusive - mirrors the server).
    setProjects(prev => sortByFavourite(prev.map(p => p.id === projectId
      ? { ...p, is_favourite: p.is_favourite ? 0 : 1, is_hidden: p.is_favourite ? p.is_hidden : 0 }
      : p)));
    await fetch(`/api/projects/${projectId}/favourite`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => {
      setProjects(prev => sortByFavourite(prev.map(p => p.id === projectId ? { ...p, is_favourite: p.is_favourite ? 0 : 1 } : p)));
    });
  }

  async function handleToggleHidden(e: React.MouseEvent | null, projectId: string) {
    e?.stopPropagation();
    const token = getToken();
    // Hiding clears the favourite flag (mutually exclusive - mirrors the server).
    setProjects(prev => sortByFavourite(prev.map(p => p.id === projectId
      ? { ...p, is_hidden: p.is_hidden ? 0 : 1, is_favourite: p.is_hidden ? p.is_favourite : 0 }
      : p)));
    const res = await fetch(`/api/projects/${projectId}/hidden`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => null);
    if (!res || !res.ok) {
      setProjects(prev => sortByFavourite(prev.map(p => p.id === projectId ? { ...p, is_hidden: p.is_hidden ? 0 : 1 } : p)));
    }
  }

  useEffect(() => {
    const token = getToken();
    if (!token) return;
    fetch("/api/pending-invites", { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then((json: { ok: boolean; data?: unknown[] }) => {
        if (json.ok && json.data) setPendingCount(json.data.length);
      })
      .catch(() => {});
    fetch("/api/organizations", { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then((json: { ok: boolean; data?: Org[] }) => {
        if (json.ok && json.data) setOrgs(json.data);
      })
      .catch(() => {});
  }, []);

  const visibleProjects = projects.filter(p => !p.is_hidden);
  const hiddenProjects = projects.filter(p => p.is_hidden);

  function renderProjectCard(project: Project) {
    return (
      <Card
        key={project.id}
        role="button"
        tabIndex={0}
        onClick={() => navigate(`/projects/${project.id}`)}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === "Enter" || e.key === " ") {
            if (e.key === " ") e.preventDefault();
            navigate(`/projects/${project.id}`);
          }
        }}
        className="group flex cursor-pointer flex-col transition-[border-color,background-color,box-shadow] hover:border-foreground/20 hover:shadow-lg hover:shadow-black/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <CardHeader className="flex-row items-start justify-between gap-3 pb-0">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10">
              <BookOpen className="h-4 w-4 text-primary" />
            </div>
            <div>
              <CardTitle as="h3">{project.name}</CardTitle>
            </div>
          </div>
          {/* Counts arrive with the dashboard's ?counts=1 load; a list reused
              from the sidebar's boot fetch has none until that lands. */}
          {project.doc_count != null && (
            <Badge variant="outline" className="shrink-0">
              {project.doc_count} {project.doc_count === 1 ? "doc" : "docs"}
            </Badge>
          )}
        </CardHeader>

        <CardContent className="flex-1">
          {project.description && (
            <p className="text-sm text-muted-foreground line-clamp-2">{project.description}</p>
          )}
        </CardContent>

        {/* Footer: a labelled visibility status on the left (colour + words,
            not a lone green globe), feature hints as quiet glyphs, and the
            personal actions (favourite / hide) grouped on the right. */}
        <CardFooter className="flex items-center gap-1 pt-1">
          {project.published_at ? (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); navigate(`/s/${project.id}`); }}
              className="inline-flex h-7 items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 text-xs font-medium text-emerald-700 ring-1 ring-inset ring-emerald-500/20 transition-colors hover:bg-emerald-500/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:text-emerald-300"
              aria-label="View public site"
              title="View public site"
            >
              <Globe className="h-3.5 w-3.5" strokeWidth={1.75} />
              Published
            </button>
          ) : (
            <span className="inline-flex h-7 items-center gap-1.5 rounded-full bg-muted px-2.5 text-xs font-medium text-muted-foreground ring-1 ring-inset ring-border" aria-label="Site is private">
              <Lock className="h-3.5 w-3.5" strokeWidth={1.75} />
              Private
            </span>
          )}

          {!!project.ai_enabled && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span tabIndex={0} className={`${FOOTER_SLOT} rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`}>
                  <Sparkles className="h-4 w-4 text-muted-foreground" strokeWidth={1.5} role="img" aria-label="AI features enabled" />
                </span>
              </TooltipTrigger>
              <TooltipContent>AI features enabled</TooltipContent>
            </Tooltip>
          )}

          {!!(project.features & REALTIME_FEATURE) && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span tabIndex={0} className={`${FOOTER_SLOT} rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`}>
                  <Radio className="h-4 w-4 text-muted-foreground" strokeWidth={1.5} role="img" aria-label="Real-time collaboration enabled" />
                </span>
              </TooltipTrigger>
              <TooltipContent>Real-time collaboration enabled</TooltipContent>
            </Tooltip>
          )}

          {project.organization_id && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span tabIndex={0} className={`${FOOTER_SLOT} rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`}>
                  <Building2 className="h-4 w-4 text-muted-foreground" strokeWidth={1.5} role="img" aria-label={`Part of ${project.organization_name ?? "an organization"}`} />
                </span>
              </TooltipTrigger>
              <TooltipContent>
                Part of {project.organization_name ?? "an organization"}
              </TooltipContent>
            </Tooltip>
          )}

          <div className="ml-auto flex items-center gap-0.5">
            {project.member_count != null && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <div
                    className="mr-2.5 flex items-center gap-1 text-xs text-muted-foreground"
                    aria-label={`${project.member_count} ${project.member_count === 1 ? "member" : "members"}`}
                    title={`${project.member_count} ${project.member_count === 1 ? "member" : "members"}`}
                  >
                    <Users className="h-4 w-4" strokeWidth={1.5} />
                    <span className="tabular-nums">{project.member_count}</span>
                  </div>
                </TooltipTrigger>
                <TooltipContent>
                  {project.member_count} {project.member_count === 1 ? "member" : "members"}
                </TooltipContent>
              </Tooltip>
            )}


            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className={FOOTER_SLOT}
                  aria-label={project.is_favourite ? "Remove from favourites" : "Add to favourites"}
                  onClick={(e) => handleToggleFavourite(e, project.id)}
                >
                  <Star
                    className={`h-4 w-4 transition-colors ${project.is_favourite ? "fill-amber-400 text-amber-400" : "text-muted-foreground"}`}
                    strokeWidth={1.5}
                  />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {project.is_favourite ? "Remove from favourites" : "Add to favourites"}
              </TooltipContent>
            </Tooltip>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className={FOOTER_SLOT}
                  aria-label="Site actions"
                  title="More actions"
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => e.stopPropagation()}
                >
                  <MoreHorizontal className="h-4 w-4 text-muted-foreground" strokeWidth={1.75} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[200px]" onClick={(e) => e.stopPropagation()}>
                {project.published_at && (
                  <DropdownMenuItem onSelect={() => navigate(`/s/${project.id}`)}>
                    <Globe className="h-4 w-4" /> View public site
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onSelect={() => navigate(`/projects/${project.id}/settings`)}>
                  <Settings className="h-4 w-4" /> Site settings
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  aria-label={project.is_hidden ? "Unhide site" : "Hide site"}
                  onSelect={() => handleToggleHidden(null, project.id)}
                >
                  {project.is_hidden ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                  {project.is_hidden ? "Show on dashboard" : "Hide from dashboard"}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </CardFooter>

      </Card>
    );
  }

  return (
    <div className="px-4 py-6 sm:px-8 sm:py-10">
      <h1 className="sr-only">Dashboard</h1>
      {orgs.length > 0 && (
        <div className="mb-10">
          <h2 className="text-[1.75rem] font-semibold leading-tight tracking-tight">Your organizations</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Organizations group sites and share access across them.
          </p>
          <div className="mt-6 grid auto-rows-fr grid-cols-1 gap-4 sm:grid-cols-[repeat(auto-fill,minmax(300px,1fr))]">
            {orgs.map(org => (
              <Card key={org.id} asChild>
                <Link
                  to={`/orgs/${org.id}`}
                  className="group flex cursor-pointer flex-col transition-colors hover:border-primary/40 hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                <CardHeader className="flex-row items-start justify-between gap-3 pb-0">
                  <div className="flex items-center gap-2.5">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10">
                      <Building2 className="h-4 w-4 text-primary" />
                    </div>
                    <CardTitle as="h3">{org.name}</CardTitle>
                  </div>
                  <Badge variant="outline" className="shrink-0 capitalize">{org.role}</Badge>
                </CardHeader>
                <CardContent className="flex-1" />
                <CardFooter className="flex flex-wrap items-center gap-4 text-muted-foreground/70">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="flex items-center gap-1 text-xs">
                        <BookOpen className="h-[18px] w-[18px]" strokeWidth={1.5} />
                        {org.site_count}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>{org.site_count} {org.site_count === 1 ? "site" : "sites"}</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="flex items-center gap-1 text-xs">
                        <Users className="h-[18px] w-[18px]" strokeWidth={1.5} />
                        {org.member_count}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>{org.member_count} {org.member_count === 1 ? "member" : "members"}</TooltipContent>
                  </Tooltip>
                </CardFooter>
                </Link>
              </Card>
            ))}
          </div>
        </div>
      )}

      <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-[1.75rem] font-semibold leading-tight tracking-tight">Your sites</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Select a site to browse its documentation.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2 self-start">
          <Button variant="outline" size="sm" onClick={openCreateOrg} className="h-10 gap-1.5 sm:h-9">
            <Building2 className="h-4 w-4" />
            New organization
          </Button>
          {/* With sites present the header carries the primary "New site";
              with none, the large empty-state card below does instead (only
              one "New site" control is ever rendered). */}
          {projects.length > 0 && (
            <Button size="sm" onClick={openCreateSite} className="h-10 gap-1.5 sm:h-9">
              <Plus className="h-4 w-4" />
              New site
            </Button>
          )}
        </div>
      </div>

      <div className="grid auto-rows-fr grid-cols-1 gap-4 sm:grid-cols-[repeat(auto-fill,minmax(300px,1fr))]">
          {visibleProjects.map(project => renderProjectCard(project))}
          {pendingCount > 0 && (
            <Card asChild>
              <Link
                to="/invites/pending"
                className="group flex cursor-pointer flex-col transition-colors hover:border-primary/40 hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
              <CardHeader className="flex-row items-start justify-between gap-3 pb-0">
                <div className="flex items-center gap-2.5">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-amber-500/10">
                    <Mail className="h-4 w-4 text-amber-500" />
                  </div>
                  <div>
                    <CardTitle as="h3">{pendingCount === 1 ? "Pending invite" : "Pending invites"}</CardTitle>
                  </div>
                </div>
                <Badge variant="outline" className="shrink-0">
                  {pendingCount} {pendingCount === 1 ? "invite" : "invites"}
                </Badge>
              </CardHeader>
              <CardContent className="flex-1">
                <p className="text-sm text-muted-foreground line-clamp-2">
                  You have {pendingCount} pending {pendingCount === 1 ? "invite" : "invites"}. Click here to review.
                </p>
              </CardContent>
              <CardFooter />
              </Link>
            </Card>
          )}
          {projects.length === 0 && (
          <Card asChild>
            <button
              type="button"
              onClick={openCreateSite}
              className="group flex w-full cursor-pointer flex-col items-center justify-center border-dashed text-left transition-colors hover:border-primary/40 hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
            <CardContent className="flex flex-col items-center gap-3 py-6">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-dashed border-muted-foreground/40 transition-colors group-hover:border-primary/60">
                <Plus className="h-5 w-5 text-muted-foreground/60 transition-colors group-hover:text-primary" />
              </div>
              <div className="text-center">
                <p className="text-sm font-medium">New site</p>
                <p className="mt-0.5 text-xs text-muted-foreground">Create a new documentation site</p>
              </div>
            </CardContent>
            </button>
          </Card>
          )}
        </div>

      {hiddenProjects.length > 0 && (
        <div className="mt-10">
          <button
            type="button"
            onClick={() => setHiddenOpen(o => !o)}
            className="flex items-center gap-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            <ChevronDown className={`h-4 w-4 transition-transform ${hiddenOpen ? "" : "-rotate-90"}`} />
            <EyeOff className="h-4 w-4" strokeWidth={1.5} />
            Hidden sites
            <Badge variant="secondary" className="ml-1">{hiddenProjects.length}</Badge>
          </button>
          {hiddenOpen && (
            <div className="mt-4 grid auto-rows-fr grid-cols-1 gap-4 sm:grid-cols-[repeat(auto-fill,minmax(300px,1fr))]">
              {hiddenProjects.map(project => renderProjectCard(project))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
