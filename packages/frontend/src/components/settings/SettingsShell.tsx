import { useEffect, useRef, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import type { LucideIcon } from "lucide-react";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { useScrollSpy } from "./useScrollSpy";

export interface SettingsSectionDef {
  /** Matches the `id` on the section's content wrapper in the page JSX. */
  id: string;
  /** Outline link text. */
  label: string;
  /** Group key this section belongs to (see SettingsGroupDef.id). */
  group: string;
  /** Pass the page's existing gate expression; default true. Hidden sections
   *  are dropped from the outline (and groups with no visible sections too). */
  visible?: boolean;
  /** Render the outline link in the destructive colour (Danger zone). The
   *  section heading itself stays in the normal foreground colour. */
  danger?: boolean;
}

export interface SettingsGroupDef {
  /** Group key referenced by SettingsSectionDef.group. */
  id: string;
  /** Outline group label (an eyebrow above the group's links). For a
   *  `separated` group it is only the accessible name - not shown. */
  label: string;
  /** Set apart after a thin divider, with no eyebrow label (e.g. Danger
   *  zone). Its links keep the normal indent. Defaults to true when every
   *  section in the group is `danger`, false otherwise. */
  separated?: boolean;
}

export interface ResolvedGroup extends SettingsGroupDef {
  sections: SettingsSectionDef[];
  separated: boolean;
}

/**
 * Build the outline: drop `visible: false` sections, attach each remaining
 * section to its group preserving declared order, and drop groups left empty
 * (e.g. admin-only groups for a viewer). A group made only of danger
 * sections is `separated` unless the page says otherwise. Pure for
 * unit-testing.
 */
export function resolveOutline(groups: SettingsGroupDef[], sections: SettingsSectionDef[]): ResolvedGroup[] {
  const visible = sections.filter(s => s.visible !== false);
  return groups
    .map(group => {
      const own = visible.filter(s => s.group === group.id);
      return { ...group, sections: own, separated: group.separated ?? (own.length > 0 && own.every(s => s.danger)) };
    })
    .filter(group => group.sections.length > 0);
}

/** Destructive-outline button styling (pair with variant="outline"): red text
 *  and border, red wash on hover. Solid red is reserved for confirm dialogs. */
export const DESTRUCTIVE_OUTLINE_BUTTON =
  "border-destructive/40 text-destructive hover:border-destructive/60 hover:bg-destructive/10 hover:text-destructive";

/** Shared row-card chrome for every settings row (toggle, select, action). */
export const SETTINGS_ROW_CARD = "rounded-lg border border-border bg-card px-4 py-3";

/** Shared section heading + description. `id` anchors the outline link.
 *  Headings are always the normal foreground colour - including Danger zone,
 *  whose red signals are limited to its outline link and its buttons. */
export function SettingsSectionHeader({
  title,
  description,
  action,
  as: Heading = "h2",
}: {
  title: ReactNode;
  description?: ReactNode;
  /** Optional right-aligned control (e.g. "New key"). */
  action?: ReactNode;
  as?: "h2" | "h3";
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <Heading className="text-base font-semibold">{title}</Heading>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

/**
 * One settings row: label + 13px muted description on the left, its control
 * on the right, in a bordered row card. Used by every settings page so toggle,
 * select and action rows share one geometry.
 */
export function SettingsRow({
  title,
  titleId,
  description,
  icon,
  children,
  className,
}: {
  title: ReactNode;
  /** Id on the title element, for aria-labelledby on the control. */
  titleId?: string;
  description?: ReactNode;
  /** Optional 16px leading icon; the description indents to align with the title text. */
  icon?: ReactNode;
  /** The control(s) shown on the right. */
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center justify-between gap-4", SETTINGS_ROW_CARD, className)}>
      <div className="flex min-w-0 flex-col gap-0.5">
        <div id={titleId} className="flex items-center gap-2 text-sm font-medium">
          {icon}
          {title}
        </div>
        {description && (
          <div className={cn("text-[13px] leading-snug text-muted-foreground", icon && "pl-6")}>{description}</div>
        )}
      </div>
      {children && <div className="flex shrink-0 items-center gap-2">{children}</div>}
    </div>
  );
}

/** Design-system "nothing here" state: a dashed card with a muted 20px icon,
 *  a medium-weight line, an optional muted hint and an optional action
 *  centred below. Use it whenever a list or section has nothing to show. */
export const EMPTY_STATE_CARD = "flex flex-col items-center rounded-lg border border-dashed border-border px-6 py-10 text-center";

export function SettingsEmptyState({
  icon: Icon,
  title,
  hint,
  action,
  className,
}: {
  icon: LucideIcon;
  title: ReactNode;
  hint?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn(EMPTY_STATE_CARD, className)}>
      <Icon className="mb-2 size-5 text-muted-foreground" aria-hidden />
      <p className="text-sm font-medium">{title}</p>
      {hint && <p className="mt-0.5 text-pretty text-sm text-muted-foreground">{hint}</p>}
      {action && <div className="mt-4 flex items-center justify-center gap-2">{action}</div>}
    </div>
  );
}

/** Compact in-section placeholder row: a muted 16px icon and one muted line
 *  in a 48px bordered row, with the list's action, if any, right-aligned in
 *  the same row. For transient states (loading) and rows inside populated
 *  lists; a list with nothing in it uses SettingsEmptyState instead. */
export function SettingsEmptyRow({ icon: Icon, action, children }: { icon: LucideIcon; action?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-12 items-center justify-between gap-4 rounded-lg border border-border px-4 py-2">
      <div className="flex min-w-0 items-center gap-2.5 text-sm text-muted-foreground">
        <Icon className="size-4 shrink-0 text-muted-foreground/70" aria-hidden />
        <span className="min-w-0">{children}</span>
      </div>
      {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
    </div>
  );
}

/** First row of a populated list card: a muted one-line summary ("2 keys")
 *  with the list's action right-aligned - the same slot the action occupies
 *  in the list's SettingsEmptyRow, so it never moves. */
export function SettingsListStatusRow({ action, children }: { action?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-12 items-center justify-between gap-4 px-4 py-2">
      <span className="min-w-0 text-sm text-muted-foreground">{children}</span>
      {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
    </div>
  );
}

/** A single danger-zone action: title + description, destructive-outline
 *  button on the right, in a row card with a faint destructive border. The
 *  title text stays neutral; the border and button carry the warning. */
export function DangerRow({ title, description, action }: { title: ReactNode; description: ReactNode; action: ReactNode }) {
  return (
    <div className={cn("flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4", SETTINGS_ROW_CARD, "border-destructive/30")}>
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-pretty text-[13px] leading-snug text-muted-foreground">{description}</p>
      </div>
      <div className="shrink-0">{action}</div>
    </div>
  );
}

interface SettingsShellProps {
  title: string;
  description?: ReactNode;
  groups: SettingsGroupDef[];
  sections: SettingsSectionDef[];
  children: ReactNode;
}

/** Shared styling for every outline link. Like the legal pages' "On this
 *  page" list, the outline sits on a 1px hairline track and the current
 *  destination is marked by exactly one thing: a 2px bar on that track (plus
 *  foreground text). No fill, no weight change. Every link sits at one indent,
 *  under its group's eyebrow label - the bar always sits on the nav's left
 *  edge. */
function outlineItemClass(active: boolean, danger: boolean | undefined) {
  return cn(
    "-ml-px border-l-2 py-1.5 pl-6 pr-2 text-left text-sm font-normal transition-colors",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
    danger
      ? active
        ? "border-destructive text-destructive"
        : "border-transparent text-destructive/80 hover:text-destructive"
      : active
        ? "border-foreground text-foreground"
        : "border-transparent text-muted-foreground hover:text-foreground",
  );
}

/** Group label in the outline: a non-interactive eyebrow (11px uppercase,
 *  muted) so it can never be mistaken for a link. */
const OUTLINE_GROUP_LABEL = "pb-1 pl-3.5 pr-2 pt-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/80";

/**
 * Shared chrome for every settings surface (user, site, org): a header, a
 * sticky grouped outline (every group always expanded, so items never move
 * under the cursor while scrolling), a mobile "Jump to section"
 * select in place of the outline, and a content column holding the page's own
 * section JSX. Owns scroll-spy and hash deep-linking; knows nothing about
 * auth - pages pass pre-gated `visible` flags.
 *
 * Geometry is fixed so every settings page lines up identically: a 12rem
 * outline, a 3.5rem gutter and a 44rem (704px) content measure shared by the
 * header, its divider and every section. Pages must not add their own
 * narrower max-width wrappers.
 */
export function SettingsShell({ title, description, groups, sections, children }: SettingsShellProps) {
  const location = useLocation();
  const resolved = resolveOutline(groups, sections);
  const orderedIds = resolved.flatMap(group => group.sections.map(s => s.id));
  const idsKey = orderedIds.join("|");
  const { active, scrollTo } = useScrollSpy(orderedIds);

  // Deep-link support (e.g. /settings#billing, /settings#sessions): on hash
  // change, scroll to the section once it has rendered. scrollTo also sets the
  // section active, so its outline link is marked. We re-run on idsKey changes so
  // a hash pointing at an initially-gated section (e.g. #members before the role
  // resolves) still scrolls once that section appears - but honoredHash ensures
  // each hash is honored only once, so a later gate flip can't yank the user
  // back to the hash after they've scrolled away.
  const honoredHashRef = useRef<string | null>(null);
  useEffect(() => {
    if (!location.hash) {
      honoredHashRef.current = null;
      return;
    }
    if (honoredHashRef.current === location.hash) return;
    const id = location.hash.slice(1);
    if (!orderedIds.includes(id)) return;
    honoredHashRef.current = location.hash;
    const frame = requestAnimationFrame(() => scrollTo(id));
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.hash, idsKey]);

  return (
    <div className="mx-auto w-full max-w-[64rem] px-4 py-8 sm:px-8 sm:py-10">
      <div className="flex gap-14">
        {/* Grouped outline - desktop only; below md the "Jump to section"
            select under the header takes its place. Groups never collapse:
            a group label is a non-interactive eyebrow and its sections are
            listed beneath it, indented. */}
        <aside className="hidden md:block w-48 shrink-0">
          <nav aria-label="Settings sections" className="sticky top-10 flex flex-col">
            {/* Group eyebrows already head the outline; a second "On this
                page" eyebrow above them would stack two label levels. Only
                shown when no group renders an eyebrow of its own. */}
            {resolved.every(group => group.separated) && (
              <p className="mb-3 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/80">On this page</p>
            )}
            <div className="flex flex-col border-l border-border">
              {resolved.map((group, index) => {
                const links = group.sections.map(section => {
                  const isActive = active === section.id;
                  return (
                    <button
                      key={section.id}
                      type="button"
                      onClick={() => scrollTo(section.id)}
                      aria-current={isActive ? "true" : undefined}
                      className={outlineItemClass(isActive, section.danger)}
                    >
                      {section.label}
                    </button>
                  );
                });
                // A separated group (Danger zone) is set apart by a 16px gap
                // and a hairline instead of an eyebrow; every other group -
                // even a single-section one - gets its label, so all links
                // share one indent and a label never reads as a stray link.
                if (group.separated) {
                  return (
                    <div key={group.id} role="group" aria-label={group.label} className="flex flex-col">
                      {index > 0 && <div aria-hidden className="mb-2 ml-3.5 mr-2 mt-4 h-px bg-border" />}
                      {links}
                    </div>
                  );
                }
                return (
                  <div
                    key={group.id}
                    role="group"
                    aria-labelledby={`settings-outline-group-${group.id}`}
                    className={cn("flex flex-col", index > 0 && "mt-2")}
                  >
                    <p id={`settings-outline-group-${group.id}`} className={OUTLINE_GROUP_LABEL}>
                      {group.label}
                    </p>
                    {links}
                  </div>
                );
              })}
            </div>
          </nav>
        </aside>

        {/* Content column - one measure for header, divider and sections.
            The bottom padding is most of a viewport tall so every section,
            even a short trailing one (Sessions, Danger zone), can scroll up to
            the scroll-spy reading line and a jump lands it at the top.
            Below sm, text inputs, select triggers and text buttons grow to a
            44px touch target (icon buttons carry an aria-label and keep their
            own square sizing; switches/radios/OTP slots are excluded). */}
        <div
          className={cn(
            "min-w-0 max-w-[44rem] flex-1 pb-[max(8rem,calc(100dvh-12rem))]",
            "max-sm:[&_input:not([type=checkbox],[type=radio],[type=file],[type=color],[data-input-otp])]:min-h-11",
            "max-sm:[&_button:not([aria-label],[role=switch],[role=radio],[role=checkbox])]:min-h-11",
            "max-sm:[&_button[role=combobox]]:min-h-11",
          )}
        >
          <h1 className="text-[1.75rem] font-semibold leading-tight tracking-tight">{title}</h1>
          {description && <p className="mt-1.5 text-sm text-muted-foreground">{description}</p>}
          {orderedIds.length > 1 && (
            <div className="mt-5 md:hidden">
              <Select value={active ?? undefined} onValueChange={scrollTo}>
                <SelectTrigger className="h-11 w-full" aria-label="Jump to section">
                  {/* A div, not a span: SelectTrigger line-clamps its direct
                      span children, which would collapse this flex row. */}
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className="shrink-0 text-muted-foreground">Jump to</span>
                    <span className="min-w-0 truncate font-medium"><SelectValue placeholder="Section" /></span>
                  </div>
                </SelectTrigger>
                <SelectContent>
                  {resolved.map((group, index) =>
                    group.separated ? (
                      <SelectGroup key={group.id} aria-label={group.label}>
                        {index > 0 && <SelectSeparator />}
                        {group.sections.map(section => (
                          <SelectItem
                            key={section.id}
                            value={section.id}
                            className={cn("min-h-10 pl-4", section.danger && "text-destructive focus:text-destructive")}
                          >
                            {section.label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    ) : (
                      <SelectGroup key={group.id}>
                        <SelectLabel>{group.label}</SelectLabel>
                        {group.sections.map(section => (
                          <SelectItem
                            key={section.id}
                            value={section.id}
                            className={cn("min-h-10 pl-4", section.danger && "text-destructive focus:text-destructive")}
                          >
                            {section.label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    ),
                  )}
                </SelectContent>
              </Select>
            </div>
          )}
          <Separator className="mb-6 mt-5 md:mb-10 md:mt-7" />
          {children}
        </div>
      </div>
    </div>
  );
}
