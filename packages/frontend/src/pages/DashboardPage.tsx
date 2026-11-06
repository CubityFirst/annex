import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { readRecentItems } from "@/lib/recentDocs";
import { FileTypeIcon } from "@/components/FileTypeIcon";
import { timeAgo } from "@/components/SearchPalette";
import { Link, useNavigate, useOutletContext } from "react-router-dom";
import { BookOpen, Building2, ChevronDown, FileText, Eye, EyeOff, Globe, Lock, Mail, MoreHorizontal, MousePointer2, Pin, Plus, Settings, Sparkles, Users } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { ProjectSquareLogo } from "@/components/ProjectSquareLogo";
import { getToken } from "@/lib/auth";
import { PAGE_PADDING, WIDE_CONTAINER } from "@/lib/pageContainer";
import type { DocsLayoutContext, ProjectListItem } from "@/layouts/DocsLayout";

type Project = ProjectListItem;

const REALTIME_FEATURE = 4;

// Square slot for the footer's pin / menu buttons: 32px everywhere, with a
// transparent ::before growing the touch area to 44px on phones (max-sm:
// overrides the icon size's own phone bump).
const FOOTER_SLOT = "relative flex h-8 w-8 max-sm:h-8 max-sm:w-8 shrink-0 items-center justify-center before:absolute before:-inset-1.5 before:content-[''] sm:before:hidden";

// A site card's title: the link stretched over the whole card. In a single
// column (phones) the full name always wraps; in multi-column grids it's
// clamped to two lines so descriptions line up, and the full name is offered
// in a tooltip on hover or keyboard focus - only when the clamp actually cuts
// it (a tooltip repeating visible text is noise).
function SiteCardTitle({ projectId, name }: { projectId: string; name: string }) {
  const ref = useRef<HTMLHeadingElement>(null);
  const [clamped, setClamped] = useState(false);
  // One open state shared by hover (Radix, with the provider's delay) and
  // keyboard focus, so Escape - which Radix routes through onOpenChange -
  // closes it whichever way it opened.
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [clamped]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => setClamped(el.scrollHeight > el.clientHeight + 1);
    check();
    let cancelled = false;
    document.fonts?.ready.then(() => { if (!cancelled) check(); });
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(check);
    ro?.observe(el);
    return () => { cancelled = true; ro?.disconnect(); };
  }, [name]);
  return (
    <CardTitle ref={ref} as="h3" className="line-clamp-none break-words text-[15px] leading-5 @min-[616px]:line-clamp-2">
      <Tooltip open={clamped && open} onOpenChange={(o) => setOpen(o && clamped)}>
        <Link
          to={`/projects/${projectId}`}
          data-card-link
          onFocus={(e) => { if (e.currentTarget.matches(":focus-visible")) setOpen(true); }}
          onBlur={() => setOpen(false)}
          onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); }}
          className="outline-none after:absolute after:inset-0 after:rounded-xl after:content-['']"
        >
          {/* The trigger sits above the stretched ::after so hovering the
              title text (not the whole card) is what opens it. */}
          <TooltipTrigger asChild>
            <span className="relative z-[1]">{name}</span>
          </TooltipTrigger>
        </Link>
        <TooltipContent side="top" align="start" alignOffset={-12} sideOffset={14} className="max-w-md">{name}</TooltipContent>
      </Tooltip>
    </CardTitle>
  );
}

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
  const { openCreateSite, openCreateOrg, projects, setProjects, headerActionSlot } = useOutletContext<DocsLayoutContext>();
  const [isDesktop, setIsDesktop] = useState(() => typeof window !== "undefined" && !!window.matchMedia?.("(min-width: 768px)").matches);
  useEffect(() => {
    const mq = window.matchMedia?.("(min-width: 768px)");
    if (!mq) return;
    const onChange = () => setIsDesktop(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

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
    const features = [
      !!project.ai_enabled && { key: "ai", icon: Sparkles, label: "AI features" },
      !!(project.features & REALTIME_FEATURE) && { key: "rt", icon: MousePointer2, label: "Real-time co-editing" },
    ].filter(Boolean) as { key: string; icon: typeof Sparkles; label: string }[];
    const counts = [
      project.doc_count != null && `${project.doc_count.toLocaleString()} ${project.doc_count === 1 ? "doc" : "docs"}`,
      project.member_count != null && `${project.member_count.toLocaleString()} ${project.member_count === 1 ? "member" : "members"}`,
    ].filter(Boolean).join(" · ");
    // Counts come with the dashboard's ?counts=1 load; a list reused from the
    // sidebar's boot fetch has neither field until that lands.
    const countsPending = project.doc_count === undefined && project.member_count === undefined;
    const initial = (project.name.trim()[0] ?? "?").toUpperCase();
    const orgName = project.organization_name ?? "an organization";

    return (
      // The title link stretches over the whole card (after:inset-0), so the
      // card is one big click target without wrapping buttons in a button.
      // Only the real controls (org, features, pin, menu) sit above
      // it (relative z-10); everything else - pill, padding - clicks through.
      <Card
        key={project.id}
        className="group relative flex cursor-pointer flex-col transition-colors hover:border-foreground/25 hover:bg-accent/30 has-[a[data-card-link]:focus-visible]:ring-2 has-[a[data-card-link]:focus-visible]:ring-ring"
      >
        {/* Identity row: a 40px title slot (centres one line, fills at two)
            so every card's description starts at the same height in a
            multi-column grid; the tile is anchored to that slot, so a longer
            unclamped phone title grows downward without moving it. */}
        <CardHeader className="flex-row items-start gap-2.5 pb-0 pt-4">
          {/* The site's square logo where one is uploaded (as in the
              sidebar and search), its first letter otherwise. */}
          <div aria-hidden className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-md bg-primary/10 text-sm font-semibold text-foreground/80">
            <ProjectSquareLogo
              projectId={project.id}
              logoSquareUpdatedAt={project.logo_square_updated_at}
              className="h-8 w-8 rounded-md"
              fallback={initial}
            />
          </div>
          <div className="flex min-h-10 min-w-0 flex-1 items-center">
            <SiteCardTitle projectId={project.id} name={project.name} />
          </div>
        </CardHeader>

        <CardContent className="flex flex-1 flex-col pb-3 pt-3">
          {project.description ? (
            <p className="break-words text-sm text-muted-foreground line-clamp-3">{project.description}</p>
          ) : (
            <p className="text-sm italic text-muted-foreground">No description</p>
          )}
          {/* Facts, pinned to the bottom so the counts line up across a row.
              The organisation gets its own line (nearly the card's width
              before it truncates): a link to the org page for its members,
              otherwise a reveal of the full name on hover, focus or tap. Counts arrive with the dashboard's ?counts=1 load.
              On phones the org line's 40px tap area extends up into the
              (empty) gap above it, so it never covers the counts. While
              counts are still loading, a placeholder bar holds their line so
              the card doesn't grow when they land. */}
          {(project.organization_id || counts || countsPending) && (
            <div className={`mt-auto flex flex-col items-start gap-1 pt-4 text-xs text-muted-foreground ${project.organization_id ? "max-sm:pt-5" : ""}`}>
              {project.organization_id && orgs.some(o => o.id === project.organization_id) ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Link
                      to={`/orgs/${project.organization_id}`}
                      aria-label={`Part of ${orgName}`}
                      className="relative z-10 -mx-1 flex max-w-full min-w-0 items-center gap-1 rounded px-1 transition-colors before:absolute before:inset-x-0 before:-top-5 before:-bottom-1 before:content-[''] hover:text-foreground sm:before:hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <Building2 className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} aria-hidden />
                      <span className="truncate">{orgName}</span>
                    </Link>
                  </TooltipTrigger>
                  <TooltipContent>Part of {orgName}</TooltipContent>
                </Tooltip>
              ) : project.organization_id && (
                <Popover>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <PopoverTrigger asChild>
                        <button
                          type="button"
                          aria-label={`Part of ${orgName}`}
                          className="relative z-10 -mx-1 flex max-w-full min-w-0 items-center gap-1 rounded px-1 transition-colors before:absolute before:inset-x-0 before:-top-5 before:-bottom-1 before:content-[''] hover:text-foreground sm:before:hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <Building2 className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} aria-hidden />
                          <span className="truncate">{project.organization_name ?? "Organization"}</span>
                        </button>
                      </PopoverTrigger>
                    </TooltipTrigger>
                    <TooltipContent>Part of {orgName}</TooltipContent>
                  </Tooltip>
                  <PopoverContent align="start" className="w-auto max-w-72 px-3 py-2 text-sm">
                    <span className="text-muted-foreground">Part of </span>
                    <span className="font-medium">{orgName}</span>
                  </PopoverContent>
                </Popover>
              )}
              {counts ? (
                <p className="tabular-nums">{counts}</p>
              ) : countsPending && (
                <span aria-hidden className="my-0.5 block h-3 w-28 rounded-sm bg-muted/60" />
              )}
            </div>
          )}
        </CardContent>

        {/* Footer: status (words + colour), the site's features as one quiet
            group, and the personal actions (pin / menu) set apart on the
            right. Controls keep their compact desktop look on phones; a
            transparent ::before extends each to a 44px touch area. */}
        <CardFooter className="gap-2 pt-0">
          {project.published_at ? (
            <span className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 text-xs font-medium text-emerald-700 ring-1 ring-inset ring-emerald-500/20 dark:text-emerald-300">
              <Globe className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
              Published
            </span>
          ) : (
            <span className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-muted px-2.5 text-xs font-medium text-muted-foreground ring-1 ring-inset ring-border">
              <Lock className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
              Private
            </span>
          )}

          {features.length > 0 && (
            <Popover>
              <Tooltip>
                <TooltipTrigger asChild>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      aria-label={`Site features: ${features.map(f => f.label).join(", ")}`}
                      className="relative z-10 flex h-7 min-w-7 shrink-0 items-center justify-center gap-2 rounded-md bg-muted/70 px-1.5 group-hover:bg-muted text-muted-foreground transition-colors before:absolute before:-inset-2 before:content-[''] hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-accent data-[state=open]:text-foreground sm:before:hidden"
                    >
                      {features.map(f => <f.icon key={f.key} className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />)}
                    </button>
                  </PopoverTrigger>
                </TooltipTrigger>
                <TooltipContent>{features.map(f => f.label).join(" · ")}</TooltipContent>
              </Tooltip>
              <PopoverContent align="start" className="w-auto min-w-48 p-2">
                <p className="px-2 pb-1.5 pt-1 text-xs font-medium text-muted-foreground">Enabled on this site</p>
                <ul className="flex flex-col">
                  {features.map(f => (
                    <li key={f.key} className="flex items-center gap-2 px-2 py-1 text-sm">
                      <f.icon className="h-4 w-4 text-muted-foreground" strokeWidth={1.5} aria-hidden />
                      {f.label}
                    </li>
                  ))}
                </ul>
              </PopoverContent>
            </Popover>
          )}

          {/* -mr-2 puts the ⋯ glyph on the padding edge; gap-3 on phones
              keeps the two 44px touch areas from overlapping. */}
          <div className="relative z-10 -mr-2 ml-auto flex shrink-0 items-center gap-3 sm:gap-0.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className={FOOTER_SLOT}
                  aria-label={project.is_favourite ? "Unpin" : "Pin to top"}
                  aria-pressed={!!project.is_favourite}
                  onClick={(e) => handleToggleFavourite(e, project.id)}
                >
                  {/* A per-member pin (sorts the site first) - not the
                      profile's "Favourite sites" showcase, hence a pin. */}
                  <Pin
                    className={`h-4 w-4 transition-colors ${project.is_favourite ? "fill-foreground/85 text-foreground/85" : "text-muted-foreground"}`}
                    strokeWidth={1.5}
                  />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {project.is_favourite ? "Unpin" : "Pin to top"}
              </TooltipContent>
            </Tooltip>
            <DropdownMenu>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className={FOOTER_SLOT}
                      aria-label="Site actions"
                    >
                      <MoreHorizontal className="h-4 w-4 text-muted-foreground" strokeWidth={1.75} />
                    </Button>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent>Site actions</TooltipContent>
              </Tooltip>
              <DropdownMenuContent align="end" className="min-w-[200px]">
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

  const pageActions = (
    // Phones: two equal buttons side by side, primary first; desktop: outline
    // then primary at the right end of the top bar.
    <div className="flex shrink-0 flex-row-reverse gap-2 self-stretch sm:flex-row sm:items-center sm:self-start [&>button]:min-w-0 [&>button]:flex-1 sm:[&>button]:flex-none">
      <Button variant="outline" size="sm" onClick={openCreateOrg} className="h-10 gap-1.5 sm:h-8">
        <Building2 className="h-4 w-4" />
        New organization
      </Button>
      {/* With sites present this carries the primary "New site"; with none,
          the large empty-state card below does instead (only one "New site"
          control is ever rendered). */}
      {projects.length > 0 && (
        <Button size="sm" onClick={openCreateSite} className="h-10 gap-1.5 sm:h-8">
          <Plus className="h-4 w-4" />
          New site
        </Button>
      )}
    </div>
  );

  // Recently opened docs/files across all of the user's sites.
  const recent = visibleProjects
    .flatMap(p => readRecentItems(p.id).map(item => ({ ...item, project: p })))
    .sort((a, b) => b.accessedAt - a.accessedAt)
    .slice(0, 6);

  return (
    // Shared wide container: same left edge as the doc column at xl.
    <div className={PAGE_PADDING}>
    <div className={WIDE_CONTAINER}>
      <h1 className="sr-only">Dashboard</h1>
      {orgs.length > 0 && (
        <div className="mb-10">
          <h2 className="text-[1.75rem] font-semibold leading-tight tracking-tight">Your organizations</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Organizations group sites and share access across them.
          </p>
          <div className="mt-6 @container">
          <div className="grid grid-cols-1 gap-4 @min-[616px]:grid-cols-[repeat(auto-fill,minmax(300px,1fr))]">
            {orgs.map(org => (
              <Card key={org.id} asChild>
                <Link
                  to={`/orgs/${org.id}`}
                  className="group flex cursor-pointer flex-col transition-colors hover:border-foreground/25 hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
        </div>
      )}

      {isDesktop && headerActionSlot && createPortal(pageActions, headerActionSlot)}
      <div className="mb-8 flex flex-col gap-4">
        <div>
          <h2 className="text-[1.75rem] font-semibold leading-tight tracking-tight">Your sites</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Select a site to browse its documentation.
          </p>
        </div>
        {/* Phones: actions under the heading. Desktop renders the same
            buttons once, in the top bar (portal below) - never both, so each
            label stays unique on the page. */}
        {!isDesktop && pageActions}
      </div>

      {/* Container query, not viewport: equal-height rows (and the tall
          ghost tile) only once the grid really fits two 300px columns. */}
      <TooltipProvider delayDuration={400} skipDelayDuration={300}>
      <div className="@container">
      <div className="grid grid-cols-1 gap-4 @min-[616px]:grid-cols-[repeat(auto-fill,minmax(300px,1fr))]">
          {visibleProjects.map(project => renderProjectCard(project))}
          {pendingCount > 0 && (
            <Card asChild>
              <Link
                to="/invites/pending"
                className="group flex cursor-pointer flex-col transition-colors hover:border-foreground/25 hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
          {projects.length > 0 && (
            // Quiet ghost tile so a short list still reads as a grid. Worded
            // differently from the header's "New site" so that label stays
            // unique on the page.
            <button
              type="button"
              onClick={openCreateSite}
              className="group flex h-14 w-full flex-row items-center justify-center gap-2 self-start rounded-xl border border-dashed border-border text-sm text-muted-foreground transition-colors hover:border-foreground/25 hover:bg-accent/30 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring @min-[616px]:h-auto @min-[616px]:min-h-[7.5rem] @min-[616px]:flex-col @min-[616px]:self-stretch"
            >
              <Plus className="h-5 w-5" />
              Add another site
            </button>
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
      </div>
      </TooltipProvider>

      {recent.length > 0 && (
        <section className="mt-8 sm:mt-12">
          <h2 className="mb-3 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/80">Recently opened</h2>
          <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
            {recent.map(item => (
              <li key={`${item.project.id}:${item.kind}:${item.id}`}>
                <Link
                  to={`/projects/${item.project.id}/${item.kind === "doc" ? "docs" : "files"}/${item.id}`}
                  className="flex items-center gap-3 px-4 py-2.5 text-sm transition-colors hover:bg-accent/60 focus-visible:bg-accent/60 focus-visible:outline-none"
                >
                  {item.kind === "doc"
                    ? <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                    : <FileTypeIcon mimeType={item.mime ?? ""} name={item.title} className="h-4 w-4 shrink-0 text-muted-foreground" />}
                  <span className="min-w-0 flex-1 truncate font-medium">{item.title}</span>
                  {/* "Site · time", matching the search palette's recent rows
                      (phones drop the site to keep the title readable). */}
                  <span className="flex min-w-0 shrink-0 items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground">
                    <span className="hidden max-w-[12rem] truncate sm:inline">{item.project.name}</span>
                    <span aria-hidden="true" className="hidden sm:inline">·</span>
                    <span className="tabular-nums">{timeAgo(item.accessedAt)}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

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
            <TooltipProvider delayDuration={400} skipDelayDuration={300}>
              <div className="mt-4 @container">
                <div className="grid grid-cols-1 gap-4 @min-[616px]:grid-cols-[repeat(auto-fill,minmax(300px,1fr))]">
                  {hiddenProjects.map(project => renderProjectCard(project))}
                </div>
              </div>
            </TooltipProvider>
          )}
        </div>
      )}
    </div>
    </div>
  );
}
