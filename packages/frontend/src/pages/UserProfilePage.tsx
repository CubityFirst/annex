import { useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams, useLocation } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { BookOpen, CalendarDays, Clock, CodeXml, Flag, FlaskConical, Globe, Pencil, Star, UserRound } from "lucide-react";
import { UserProfileCard } from "@/components/UserProfileCard";
import { UserAvatar } from "@/components/UserAvatar";
import { ReportUserDialog } from "@/components/ReportUserDialog";
import { InkSparkle } from "@/components/InkSparkle";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { getToken } from "@/lib/auth";
import { formatInkSince } from "@/lib/inkDate";
import { formatTimeInZone, getTimezoneGroup } from "@/lib/timezone";
import { ROLE_BADGE_CLASSES } from "@/lib/roleStyles";

type Role = keyof typeof ROLE_BADGE_CLASSES;

const ROLE_LABELS: Record<Role, string> = {
  owner: "Owner",
  admin: "Admin",
  editor: "Editor",
  viewer: "Viewer",
  limited: "Limited",
};

interface ProfileData {
  userId: string;
  name: string;
  createdAt: string;
  timezone?: string;
  handle?: string;
  sharedProjects: { id: string; name: string; theirRole: Role }[];
  favouriteSites: { id: string; name: string; vanitySlug: string | null; logoSquareUpdatedAt: string | null; note: string | null }[];
  bio?: string;
  personalPlan?: "free" | "ink";
  personalPlanSince?: number | null;
  personalPlanStyle?: string | null;
  badges?: number;
}

const BADGE_DEVELOPER = 1 << 0;
const BADGE_BETA_TESTER = 1 << 1;

// Same constrained bio markdown as the profile card: inline formatting only.
const BIO_ALLOWED_ELEMENTS = ["p", "a", "strong", "em", "code", "del", "br"];
const BIO_REMARK_PLUGINS = [remarkGfm, remarkBreaks];
const bioMarkdownComponents = {
  a: ({ href, children }: { href?: string; children?: ReactNode }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
  ),
};

const PILL = "inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium ring-1 ring-inset focus:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

function Eyebrow({ children }: { children: ReactNode }) {
  return <h2 className="mb-3 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/80">{children}</h2>;
}

/** Card grid shared by the profile's site lists (favourites, your/shared sites). */
const SITE_GRID = "grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3";
const SITE_CARD =
  "flex h-full w-full items-start gap-3 rounded-lg border border-border bg-card p-4 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** 32px site mark: the square logo when there is one, else a muted icon tile. */
function SiteMark({ siteId, logoUpdatedAt, fallback: Fallback }: { siteId: string; logoUpdatedAt?: string | null; fallback: typeof Globe }) {
  if (logoUpdatedAt) {
    return (
      <img
        src={`/api/public/projects/${siteId}/logo/square?v=${encodeURIComponent(logoUpdatedAt)}`}
        alt=""
        className="size-8 shrink-0 rounded-md object-cover"
      />
    );
  }
  return (
    <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-muted/40">
      <Fallback className="size-4 text-muted-foreground" aria-hidden />
    </span>
  );
}

/**
 * Full-page public profile, used when /u/:userId or /@handle is opened
 * directly (not as an in-app modal over another page).
 */
function UserProfileFullPage({ userId, initialName }: { userId: string; initialName: string }) {
  const navigate = useNavigate();
  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [selfId, setSelfId] = useState<string | null>(null);
  const [reportOpen, setReportOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setProfile(null);
    setLoadError(false);
    const headers = { Authorization: `Bearer ${getToken()}` };
    fetch(`/api/users/${userId}`, { headers })
      .then(r => r.json() as Promise<{ ok: boolean; data?: ProfileData }>)
      .then(json => {
        if (cancelled) return;
        if (json.ok && json.data) setProfile(json.data);
        else setLoadError(true);
      })
      .catch(() => { if (!cancelled) setLoadError(true); });
    fetch("/api/me", { headers })
      .then(r => r.json() as Promise<{ ok: boolean; data?: { userId: string } }>)
      .then(json => { if (!cancelled && json.ok && json.data) setSelfId(json.data.userId); })
      .catch(() => { /* self-only chrome just stays hidden */ });
    return () => { cancelled = true; };
  }, [userId]);

  const displayName = profile?.name || initialName;
  const isSelf = selfId !== null && selfId === userId;
  const isOther = selfId !== null && selfId !== userId;

  const badgeBits = profile?.badges ?? 0;
  const isInk = profile?.personalPlan === "ink";
  const isDeveloper = (badgeBits & BADGE_DEVELOPER) !== 0;
  const isBetaTester = (badgeBits & BADGE_BETA_TESTER) !== 0;
  const inkSince = isInk ? formatInkSince(profile?.personalPlanSince) : null;
  const tz = profile?.timezone ? getTimezoneGroup(profile.timezone) : undefined;

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-10">
      {/* Header */}
      <header className="flex flex-col items-center text-center">
        <UserAvatar
          userId={userId}
          name={displayName || "?"}
          className="size-28 [&_[data-slot=avatar-fallback]]:text-[2.75rem] [&_[data-slot=avatar-fallback]]:font-medium"
          personalPlan={profile?.personalPlan}
          personalPlanStyle={profile?.personalPlanStyle}
        />
        {displayName ? (
          <h1 className="mt-5 max-w-full truncate text-[1.75rem] font-semibold leading-tight tracking-tight">{displayName}</h1>
        ) : (
          <Skeleton className="mt-5 h-8 w-48" />
        )}
        {profile?.handle && <p className="mt-1 text-sm text-muted-foreground">@{profile.handle}</p>}

        {(isInk || isDeveloper || isBetaTester) && (
          <TooltipProvider delayDuration={0}>
            <div className="mt-3 flex flex-wrap items-center justify-center gap-1.5">
              {isDeveloper && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <a
                      href="https://docs.cubityfir.st/s/help/872895fc-3990-451e-a3a5-1dedc7405c42"
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label="Annex Developer"
                      className={`${PILL} bg-emerald-500/10 text-emerald-700 ring-emerald-500/20 dark:text-emerald-300`}
                    >
                      <CodeXml className="size-3.5" aria-hidden />
                      Developer
                    </a>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="text-xs">Annex Developer</TooltipContent>
                </Tooltip>
              )}
              {isBetaTester && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-label="Beta Tester"
                      className={`${PILL} bg-violet-500/10 text-violet-700 ring-violet-500/20 dark:text-violet-300`}
                    >
                      <FlaskConical className="size-3.5" aria-hidden />
                      Beta tester
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="text-xs">Beta Tester</TooltipContent>
                </Tooltip>
              )}
              {isInk && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button type="button" aria-label="Annex Ink" className={`${PILL} bg-muted text-foreground ring-border`}>
                      <InkSparkle className="size-3.5 ink-icon" />
                      Ink supporter
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="text-xs">
                    {inkSince ? `Annex Ink since ${inkSince}` : "Annex Ink"}
                  </TooltipContent>
                </Tooltip>
              )}
            </div>
          </TooltipProvider>
        )}

        {loadError ? (
          <p role="alert" className="mt-3 text-sm text-muted-foreground">Couldn’t load this profile.</p>
        ) : profile ? (
          <div className="mt-3 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <CalendarDays className="size-4 shrink-0" aria-hidden />
              Member since {formatDate(profile.createdAt)}
            </span>
            {profile.timezone && (
              <span className="inline-flex items-center gap-1.5">
                <Clock className="size-4 shrink-0" aria-hidden />
                {formatTimeInZone(profile.timezone)} · {tz?.offset ?? profile.timezone}
              </span>
            )}
          </div>
        ) : (
          <div role="status" aria-live="polite">
            <Skeleton className="mt-3 h-4 w-56" />
            <span className="sr-only">Loading profile…</span>
          </div>
        )}

        {isSelf && (
          <Button variant="outline" size="sm" className="mt-5 gap-1.5" onClick={() => navigate("/settings#account")}>
            <Pencil className="size-3.5" aria-hidden />
            Edit profile
          </Button>
        )}
      </header>

      {profile && (
        <div className="mt-10 flex flex-col gap-8">
          {profile.bio && (
            <section>
              <Eyebrow>About</Eyebrow>
              <div className="rounded-lg border border-border bg-card px-5 py-4 text-sm leading-relaxed text-foreground [&_p]:m-0 [&_p+p]:mt-2 [&_a]:break-words [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2 [&_strong]:font-semibold [&_em]:italic [&_del]:line-through [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-xs">
                <ReactMarkdown
                  remarkPlugins={BIO_REMARK_PLUGINS}
                  allowedElements={BIO_ALLOWED_ELEMENTS}
                  unwrapDisallowed
                  components={bioMarkdownComponents}
                >
                  {profile.bio}
                </ReactMarkdown>
              </div>
            </section>
          )}

          {profile.favouriteSites.length > 0 && (
            <section>
              <Eyebrow>Favourite sites</Eyebrow>
              <ul className={SITE_GRID}>
                {profile.favouriteSites.map(site => {
                  const note = site.note?.trim();
                  return (
                    <li key={site.id}>
                      <button type="button" onClick={() => navigate(`/s/${site.vanitySlug ?? site.id}`)} className={SITE_CARD}>
                        <SiteMark siteId={site.id} logoUpdatedAt={site.logoSquareUpdatedAt} fallback={Globe} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">{site.name}</span>
                          {note ? (
                            <span className="mt-0.5 line-clamp-3 whitespace-pre-wrap break-words text-xs text-muted-foreground">{note}</span>
                          ) : (
                            <span className="mt-0.5 block text-xs text-muted-foreground">Published site</span>
                          )}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          {/* On your own profile this list is every site you belong to (the
              API intersects your memberships with the profile owner's, which
              for yourself is all of them), so it reads "Your sites". */}
          {profile.sharedProjects.length > 0 && (
            <section>
              <Eyebrow>{isSelf ? "Your sites" : "Sites you share"}</Eyebrow>
              <ul className={SITE_GRID}>
                {profile.sharedProjects.map(proj => (
                  <li key={proj.id}>
                    <button type="button" onClick={() => navigate(`/projects/${proj.id}`)} className={SITE_CARD}>
                      <SiteMark siteId={proj.id} fallback={BookOpen} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{proj.name}</span>
                        <Badge variant="outline" className={`mt-1.5 text-xs font-medium ${ROLE_BADGE_CLASSES[proj.theirRole]}`}>
                          {ROLE_LABELS[proj.theirRole]}
                        </Badge>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {!profile.bio && profile.favouriteSites.length === 0 && profile.sharedProjects.length === 0 && (
            <div className="flex flex-col items-center rounded-lg border border-dashed border-border px-6 py-10 text-center">
              <UserRound className="mb-2 size-5 text-muted-foreground" aria-hidden />
              <p className="text-sm font-medium">Nothing to show yet</p>
              {isSelf ? (
                <>
                  {/* Bio is an Ink perk, so only mention it to Ink users. */}
                  <p className="mt-0.5 text-sm text-muted-foreground">
                    {isInk ? "Add a bio or favourite sites to fill out your profile." : "Add favourite sites to fill out your profile."}
                  </p>
                  <Button asChild variant="outline" size="sm" className="mt-4 gap-1.5">
                    <Link to={isInk ? "/settings#billing" : "/settings#favourites"}>
                      <Star className="size-3.5" aria-hidden />
                      {isInk ? "Edit your profile in Settings" : "Add favourite sites in Settings"}
                    </Link>
                  </Button>
                </>
              ) : (
                <p className="mt-0.5 text-sm text-muted-foreground">
                  {isInk ? `${displayName} hasn't added a bio or favourite sites.` : `${displayName} hasn't added any favourite sites.`}
                </p>
              )}
            </div>
          )}

          {isOther && (
            <div className="flex justify-center">
              <Button
                variant="ghost"
                size="sm"
                className="gap-1.5 font-normal text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                onClick={() => setReportOpen(true)}
              >
                <Flag className="size-3.5" aria-hidden />
                Report user
              </Button>
              <ReportUserDialog userId={userId} userName={displayName} open={reportOpen} onOpenChange={setReportOpen} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The profile for a resolved user id. Opened from inside the app (a link that
 * carries `state.backgroundLocation`) it stays a modal card over the previous
 * page; opened directly it renders as a full page.
 */
export function UserProfileView({ userId, initialName = "" }: { userId: string; initialName?: string }) {
  const navigate = useNavigate();
  const location = useLocation();
  const cameFromInApp = Boolean((location.state as { backgroundLocation?: unknown } | null)?.backgroundLocation);
  const [name, setName] = useState<string>(initialName);

  useEffect(() => {
    if (initialName || !cameFromInApp) return;
    let cancelled = false;
    const token = getToken();
    fetch(`/api/users/${userId}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then((json: { ok: boolean; data?: { name: string } }) => {
        if (!cancelled && json.ok && json.data) setName(json.data.name);
      })
      .catch(() => { /* UserProfileCard handles its own fetch + error state */ });
    return () => { cancelled = true; };
  }, [userId, initialName, cameFromInApp]);

  if (!cameFromInApp) return <UserProfileFullPage key={userId} userId={userId} initialName={initialName} />;

  return (
    <UserProfileCard
      key={userId}
      userId={userId}
      name={name}
      open
      onOpenChange={next => {
        if (next) return;
        navigate(-1);
      }}
      forceViewAsPublic
      standalone
    />
  );
}

export function UserProfilePage() {
  const { userId } = useParams<{ userId: string }>();
  if (!userId) return null;
  return <UserProfileView userId={userId} />;
}
