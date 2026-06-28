import { useState, useEffect } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import {
  Dialog,
  DialogContent,
  DialogTrigger,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { UserAvatar } from "@/components/UserAvatar";
import { getToken, clearToken } from "@/lib/auth";
import { CalendarDays, Clock, Settings, KeyRound, LogOut, ChevronRight, CodeXml, FlaskConical, Globe, Eye } from "lucide-react";
import { formatTimeInZone, getTimezoneGroup } from "@/lib/timezone";
import { formatInkSince } from "@/lib/inkDate";
import { TimezoneMap } from "@/components/TimezoneMap";
import { InkSparkle } from "@/components/InkSparkle";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";

// Constrained inline-ish markdown for Ink supporter bios. Raw HTML is never
// rendered (react-markdown's default) and `javascript:` URLs are filtered by
// the default urlTransform - so the allowlist below is purely about layout,
// not safety. Blocks like headings/lists/tables are unwrapped so their text
// content survives but doesn't add huge vertical spacing in the profile card.
const BIO_ALLOWED_ELEMENTS = ["p", "a", "strong", "em", "code", "del", "br"];
const BIO_REMARK_PLUGINS = [remarkGfm, remarkBreaks];
const bioMarkdownComponents = {
  a: ({ href, children }: { href?: string; children?: React.ReactNode }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
  ),
};

let currentUserIdCache: string | null = null;
let currentUserIdPromise: Promise<string | null> | null = null;
function getCurrentUserId(): Promise<string | null> {
  if (currentUserIdCache !== null) return Promise.resolve(currentUserIdCache);
  if (currentUserIdPromise) return currentUserIdPromise;
  const token = getToken();
  currentUserIdPromise = fetch("/api/me", { headers: { Authorization: `Bearer ${token}` } })
    .then(r => r.json() as Promise<{ ok: boolean; data?: { userId: string } }>)
    .then(json => {
      if (json.ok && json.data) {
        currentUserIdCache = json.data.userId;
        return currentUserIdCache;
      }
      return null;
    })
    .catch(() => null)
    .finally(() => { currentUserIdPromise = null; });
  return currentUserIdPromise;
}

type Role = "limited" | "viewer" | "editor" | "admin" | "owner";

const ROLE_COLORS: Record<Role, string> = {
  owner: "bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-300",
  admin: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  editor: "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300",
  viewer: "bg-muted text-foreground",
  limited: "bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-300",
};

const ROLE_LABELS: Record<Role, string> = {
  owner: "Owner",
  admin: "Admin",
  editor: "Editor",
  viewer: "Viewer",
  limited: "Limited",
};

interface SharedProject {
  id: string;
  name: string;
  theirRole: Role;
}

interface FavouriteSite {
  id: string;
  name: string;
  vanitySlug: string | null;
  logoSquareUpdatedAt: string | null;
  note: string | null;
}

interface ProfileData {
  userId: string;
  name: string;
  createdAt: string;
  timezone?: string;
  sharedProjects: SharedProject[];
  favouriteSites: FavouriteSite[];
  bio?: string;
  personalPlan?: "free" | "ink";
  personalPlanSince?: number | null;
  personalPlanStyle?: string | null;
  badges?: number;
}

const BADGE_DEVELOPER = 1 << 0;
const BADGE_BETA_TESTER = 1 << 1;

interface UserProfileCardProps {
  userId: string;
  name: string;
  children?: React.ReactNode;
  /** Controlled open state. When provided, the dialog is fully controlled and `children`/`DialogTrigger` are skipped. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Force the bio/favourites/shared view even when viewing your own profile (used by the /u/:userId route). */
  forceViewAsPublic?: boolean;
  /** Standalone /u/:userId route: the card is the whole page, so the visible name is promoted to the page's single h1. */
  standalone?: boolean;
}

export function UserProfileCard({ userId, name, children, open: controlledOpen, onOpenChange, forceViewAsPublic, standalone }: UserProfileCardProps) {
  const isControlled = controlledOpen !== undefined;
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = isControlled ? controlledOpen : uncontrolledOpen;
  const setOpen = (next: boolean) => {
    if (!isControlled) setUncontrolledOpen(next);
    onOpenChange?.(next);
  };
  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [isSelf, setIsSelf] = useState<boolean>(currentUserIdCache === userId);
  // Single source of truth for which badge tooltip is open, so that moving
  // the cursor from one badge to another forces the previous tooltip closed
  // even if Radix hasn't fired its own mouseleave yet.
  const [openBadge, setOpenBadge] = useState<"developer" | "beta" | "ink" | null>(null);
  const badgeTooltipProps = (id: "developer" | "beta" | "ink") => ({
    open: openBadge === id,
    onOpenChange: (o: boolean) => {
      if (o) setOpenBadge(id);
      else setOpenBadge((curr) => (curr === id ? null : curr));
    },
  });
  const navigate = useNavigate();
  const location = useLocation();
  const showPublicView = forceViewAsPublic || !isSelf;
  const displayName = name || profile?.name || "";

  useEffect(() => {
    if (!open || profile) return;
    setLoading(true);
    setLoadError(false);
    const token = getToken();
    fetch(`/api/users/${userId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.json())
      .then((json: { ok: boolean; data?: ProfileData }) => {
        if (json.ok && json.data) setProfile(json.data);
        else setLoadError(true);
      })
      .catch(() => setLoadError(true))
      .finally(() => setLoading(false));
  }, [open, userId, profile]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    getCurrentUserId().then(id => { if (!cancelled) setIsSelf(id === userId); });
    return () => { cancelled = true; };
  }, [open, userId]);

  function formatDate(iso: string): string {
    return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {children !== undefined && <DialogTrigger asChild>{children}</DialogTrigger>}
      <DialogContent
        className="max-w-lg p-0 overflow-y-auto max-h-[calc(100dvh-2rem)] focus:outline-none focus-visible:outline-none focus-visible:ring-0"
        onContextMenu={e => e.stopPropagation()}
        onOpenAutoFocus={e => e.preventDefault()}
      >
        <DialogTitle className="sr-only">{displayName}'s profile</DialogTitle>
        <DialogDescription className="sr-only">Profile information for {displayName}</DialogDescription>

        {/* Header */}
        <div className="relative overflow-hidden flex items-center gap-5 px-6 pt-6 pb-5">
          {/* Map background - only when timezone is known */}
          {profile?.timezone && (() => {
            const g = getTimezoneGroup(profile.timezone);
            if (!g) return null;
            return (
              <div className="absolute inset-0 pointer-events-none">
                <TimezoneMap lon={g.coords[0]} lat={g.coords[1]} />
                {/* Fade the map out on the left so the avatar area stays legible */}
                <div className="absolute inset-0 bg-gradient-to-r from-background via-background/90 to-background/60" />
              </div>
            );
          })()}

          <UserAvatar userId={userId} name={displayName} className="relative z-10 size-20 shrink-0 text-2xl" personalPlan={profile?.personalPlan} personalPlanStyle={profile?.personalPlanStyle} />
          <div className="relative z-10 min-w-0 flex-1">
            {standalone ? (
              <h1 className="truncate text-lg font-semibold">{displayName}</h1>
            ) : (
              <h2 className="truncate text-lg font-semibold">{displayName}</h2>
            )}
            {profile && (() => {
              const badgeBits = profile.badges ?? 0;
              const isInk = profile.personalPlan === "ink";
              const isDeveloper = (badgeBits & BADGE_DEVELOPER) !== 0;
              const isBetaTester = (badgeBits & BADGE_BETA_TESTER) !== 0;
              if (!isInk && !isDeveloper && !isBetaTester) return null;
              const inkSince = isInk ? formatInkSince(profile.personalPlanSince) : null;
              return (
                <TooltipProvider delayDuration={0}>
                  <div className="mt-1 flex flex-wrap items-center gap-1">
                    {isDeveloper && (
                      <Tooltip {...badgeTooltipProps("developer")}>
                        <TooltipTrigger asChild>
                          <a
                            href="https://docs.cubityfir.st/s/help/872895fc-3990-451e-a3a5-1dedc7405c42"
                            target="_blank"
                            rel="noopener noreferrer"
                            aria-label="Annex Developer"
                            className="inline-flex size-9 sm:size-7 items-center justify-center rounded-full text-green-600 transition-colors hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:text-green-400"
                          >
                            <CodeXml className="size-4" />
                          </a>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="text-xs">Annex Developer</TooltipContent>
                      </Tooltip>
                    )}
                    {isBetaTester && (
                      <Tooltip {...badgeTooltipProps("beta")}>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            aria-label="Beta Tester"
                            onClick={() => setOpenBadge(curr => (curr === "beta" ? null : "beta"))}
                            className="inline-flex size-9 sm:size-7 items-center justify-center rounded-full text-purple-600 transition-colors hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:text-purple-400"
                          >
                            <FlaskConical className="size-4" />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="text-xs">Beta Tester</TooltipContent>
                      </Tooltip>
                    )}
                    {isInk && (
                      <Tooltip {...badgeTooltipProps("ink")}>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            aria-label="Annex Ink"
                            onClick={() => setOpenBadge(curr => (curr === "ink" ? null : "ink"))}
                            className="inline-flex size-9 sm:size-7 items-center justify-center rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            <InkSparkle className="size-4 ink-icon" />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="text-xs">
                          {inkSince ? `Annex Ink since ${inkSince}` : "Annex Ink"}
                        </TooltipContent>
                      </Tooltip>
                    )}
                  </div>
                </TooltipProvider>
              );
            })()}
            {loading ? (
              <div role="status" aria-live="polite">
                <Skeleton className="mt-2 h-4 w-40" />
                <span className="sr-only">Loading profile…</span>
              </div>
            ) : loadError ? (
              <p role="alert" className="mt-1.5 text-sm text-muted-foreground">
                Couldn’t load this profile.
              </p>
            ) : profile ? (
              <>
                <div className="mt-1.5 flex items-center gap-2 text-sm text-muted-foreground">
                  <CalendarDays className="size-4 shrink-0" />
                  <span>Member since {formatDate(profile.createdAt)}</span>
                </div>
                {profile.timezone && (() => {
                  const g = getTimezoneGroup(profile.timezone);
                  return (
                    <div className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
                      <Clock className="size-4 shrink-0" />
                      <span>{g?.offset ?? profile.timezone} · {formatTimeInZone(profile.timezone)}</span>
                    </div>
                  );
                })()}
              </>
            ) : null}
          </div>
        </div>

        {/* Separator hidden when nothing follows (other-user view, no bio /
            favourites / shared) so the dialog doesn't show an orphaned line. */}
        {((!showPublicView) || loading || (profile && (profile.bio || profile.favouriteSites.length > 0 || profile.sharedProjects.length > 0))) && (
          <Separator />
        )}

        {/* Shared sites - or quick self-actions when viewing your own card */}
        {!showPublicView ? (
          <div className="flex flex-col gap-1 px-3 py-3">
            <button
              type="button"
              onClick={() => { setOpen(false); navigate(`/u/${userId}`, { state: { backgroundLocation: location } }); }}
              className="group flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left transition-colors hover:bg-muted/60"
            >
              <Eye className="size-4 shrink-0 text-muted-foreground" />
              <span className="flex-1 text-sm font-medium">View your public profile</span>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
            </button>
            <button
              type="button"
              onClick={() => { setOpen(false); navigate("/settings"); }}
              className="group flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left transition-colors hover:bg-muted/60"
            >
              <Settings className="size-4 shrink-0 text-muted-foreground" />
              <span className="flex-1 text-sm font-medium">Account settings</span>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
            </button>
            <button
              type="button"
              onClick={() => { setOpen(false); navigate("/settings#sessions"); }}
              className="group flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left transition-colors hover:bg-muted/60"
            >
              <KeyRound className="size-4 shrink-0 text-muted-foreground" />
              <span className="flex-1 text-sm font-medium">Security &amp; sessions</span>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
            </button>
            <button
              type="button"
              onClick={async () => {
                setOpen(false);
                const t = getToken();
                if (t) {
                  try {
                    await fetch("/api/me/sessions/logout", {
                      method: "POST",
                      headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` },
                    });
                  } catch { /* ignore */ }
                }
                clearToken();
                navigate("/login");
              }}
              className="group flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left transition-colors hover:bg-destructive/10 hover:text-destructive"
            >
              <LogOut className="size-4 shrink-0 text-muted-foreground group-hover:text-destructive" />
              <span className="flex-1 text-sm font-medium">Sign out</span>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-destructive" />
            </button>
          </div>
        ) : loading ? (
          <div className="px-6 py-5" aria-hidden="true">
            <div className="space-y-2">
              <Skeleton className="h-11 w-full rounded-md" />
              <Skeleton className="h-11 w-full rounded-md" />
              <Skeleton className="h-11 w-full rounded-md" />
            </div>
          </div>
        ) : profile ? (() => {
          // Available tabs in priority order (also drives the default tab).
          // Render a single section flush when only one is present; tabs
          // appear once 2+ have content.
          const bioContent = profile.bio ? (
            <div className="px-6 py-5">
              <div className="text-sm leading-relaxed text-foreground [&_p]:m-0 [&_p+p]:mt-2 [&_a]:break-words [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2 [&_strong]:font-semibold [&_em]:italic [&_del]:line-through [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-xs">
                <ReactMarkdown
                  remarkPlugins={BIO_REMARK_PLUGINS}
                  allowedElements={BIO_ALLOWED_ELEMENTS}
                  unwrapDisallowed
                  components={bioMarkdownComponents}
                >
                  {profile.bio}
                </ReactMarkdown>
              </div>
            </div>
          ) : null;

          const favouritesContent = profile.favouriteSites.length > 0 ? (
            <div className="px-6 py-5">
              <div className="flex flex-col gap-1">
                {profile.favouriteSites.map(site => {
                  const slug = site.vanitySlug ?? site.id;
                  const note = site.note?.trim();
                  return (
                    <button
                      key={site.id}
                      type="button"
                      className="flex w-full cursor-pointer items-start gap-3 rounded-md px-3 py-2.5 text-left transition-colors hover:bg-muted/60"
                      onClick={() => { setOpen(false); navigate(`/s/${slug}`); }}
                    >
                      {site.logoSquareUpdatedAt ? (
                        <img
                          src={`/api/public/projects/${site.id}/logo/square?v=${encodeURIComponent(site.logoSquareUpdatedAt)}`}
                          alt=""
                          className="size-6 shrink-0 rounded object-cover"
                        />
                      ) : (
                        <Globe className="size-5 shrink-0 text-muted-foreground" />
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{site.name}</span>
                        {note ? (
                          <span className="mt-0.5 block text-xs text-muted-foreground whitespace-pre-wrap break-words">
                            {note}
                          </span>
                        ) : null}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null;

          const sharedContent = profile.sharedProjects.length > 0 ? (
            <div className="px-6 py-5">
              <div className="flex flex-col gap-1">
                {profile.sharedProjects.map(proj => (
                  <button
                    key={proj.id}
                    type="button"
                    className="flex w-full cursor-pointer items-center justify-between rounded-md px-3 py-2.5 text-left transition-colors hover:bg-muted/60"
                    onClick={() => { setOpen(false); navigate(`/projects/${proj.id}`); }}
                  >
                    <span className="truncate text-sm font-medium">{proj.name}</span>
                    <Badge
                      className={`ml-3 shrink-0 border-0 px-2 py-0.5 text-xs ${ROLE_COLORS[proj.theirRole]}`}
                      variant="outline"
                    >
                      {ROLE_LABELS[proj.theirRole]}
                    </Badge>
                  </button>
                ))}
              </div>
            </div>
          ) : null;

          const tabs: { value: string; label: string; content: React.ReactNode }[] = [];
          if (bioContent) tabs.push({ value: "bio", label: "Bio", content: bioContent });
          if (favouritesContent) tabs.push({ value: "favourites", label: "Favourites", content: favouritesContent });
          if (sharedContent) tabs.push({ value: "shared", label: "Shared", content: sharedContent });

          if (tabs.length === 0) return null;
          if (tabs.length === 1) return tabs[0].content;

          return (
            <Tabs defaultValue={tabs[0].value} className="gap-0">
              <TabsList className="mx-6 mt-4 self-start">
                {tabs.map(t => (
                  <TabsTrigger key={t.value} value={t.value}>{t.label}</TabsTrigger>
                ))}
              </TabsList>
              {tabs.map(t => (
                <TabsContent key={t.value} value={t.value} className="m-0">
                  {t.content}
                </TabsContent>
              ))}
            </Tabs>
          );
        })() : null}
      </DialogContent>
    </Dialog>
  );
}
