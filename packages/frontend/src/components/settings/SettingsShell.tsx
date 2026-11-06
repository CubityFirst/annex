import { useEffect, useRef, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import type { LucideIcon } from "lucide-react";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
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
  /** Outline group label. */
  label: string;
}

export interface ResolvedGroup extends SettingsGroupDef {
  sections: SettingsSectionDef[];
}

/**
 * Build the outline: drop `visible: false` sections, attach each remaining
 * section to its group preserving declared order, and drop groups left empty
 * (e.g. admin-only groups for a viewer). Pure for unit-testing.
 */
export function resolveOutline(groups: SettingsGroupDef[], sections: SettingsSectionDef[]): ResolvedGroup[] {
  const visible = sections.filter(s => s.visible !== false);
  return groups
    .map(group => ({ ...group, sections: visible.filter(s => s.group === group.id) }))
    .filter(group => group.sections.length > 0);
}

/**
 * Outline text for a group: a group holding a single section shows that
 * section's own label, so the outline always reads exactly like the heading
 * it jumps to ("Members", not "People"; "API keys", not "Developer").
 */
export function groupOutlineLabel(group: ResolvedGroup): string {
  return group.sections.length === 1 ? group.sections[0].label : group.label;
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

/** Compact in-section empty state: a muted 16px icon and one muted line
 *  (ending in a full stop) in a 48px bordered row, with the list's action, if
 *  any, right-aligned in the same row. No dashed box - those are for
 *  page-level empties only. */
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
 *  button on the right, in the normal neutral row card. The button is the
 *  row's only red element. */
export function DangerRow({ title, description, action }: { title: ReactNode; description: ReactNode; action: ReactNode }) {
  return (
    <div className={cn("flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4", SETTINGS_ROW_CARD)}>
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-[13px] leading-snug text-muted-foreground">{description}</p>
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

/** Shared styling for every outline row. Like the legal pages' "On this
 *  page" list, the outline sits on a 1px hairline track and the current
 *  destination is marked by exactly one thing: a 2px bar on that track (plus
 *  foreground text). No fill. Nested rows only indent their text - the bar
 *  always sits on the nav's left edge. */
function outlineItemClass(active: boolean, danger: boolean | undefined, indent: boolean) {
  return cn(
    "-ml-px border-l-2 py-1.5 pr-2 text-left text-sm transition-colors",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
    indent ? "pl-6" : "pl-3.5",
    danger
      ? active
        ? "border-destructive font-medium text-destructive"
        : "border-transparent text-destructive/80 hover:text-destructive"
      : active
        ? "border-foreground font-medium text-foreground"
        : "border-transparent text-muted-foreground hover:text-foreground",
  );
}

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
  // a hash pointing at an initially-gated section (e.g. #theme before /api/me
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
            a group label is a plain jump to its first section, and its
            sections are listed beneath it, indented. */}
        <aside className="hidden md:block w-48 shrink-0">
          <nav aria-label="Settings sections" className="sticky top-10 flex flex-col">
            <p className="mb-3 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/80">On this page</p>
            <div className="flex flex-col border-l border-border">
              {resolved.map(group => {
                // A group holding a single section would just repeat itself
                // ("Danger zone > Danger zone"), so render it as one plain link.
                if (group.sections.length === 1) {
                  const section = group.sections[0];
                  const isActive = active === section.id;
                  return (
                    <button
                      key={group.id}
                      type="button"
                      onClick={() => scrollTo(section.id)}
                      aria-current={isActive ? "true" : undefined}
                      className={outlineItemClass(isActive, section.danger, false)}
                    >
                      {section.label}
                    </button>
                  );
                }
                return (
                  <div key={group.id} role="group" aria-label={group.label} className="flex flex-col">
                    <button
                      type="button"
                      onClick={() => scrollTo(group.sections[0].id)}
                      className={outlineItemClass(false, false, false)}
                    >
                      {group.label}
                    </button>
                    {group.sections.map(section => {
                      const isActive = active === section.id;
                      return (
                        <button
                          key={section.id}
                          type="button"
                          onClick={() => scrollTo(section.id)}
                          aria-current={isActive ? "true" : undefined}
                          className={outlineItemClass(isActive, section.danger, true)}
                        >
                          {section.label}
                        </button>
                      );
                    })}
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
            "min-w-0 max-w-[44rem] flex-1 pb-[max(8rem,calc(100dvh-20rem))]",
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
                  {resolved.map(group =>
                    group.sections.length === 1 ? (
                      <SelectItem
                        key={group.id}
                        value={group.sections[0].id}
                        className={cn("min-h-10", group.sections[0].danger && "text-destructive focus:text-destructive")}
                      >
                        {group.sections[0].label}
                      </SelectItem>
                    ) : (
                      <SelectGroup key={group.id}>
                        <SelectLabel>{group.label}</SelectLabel>
                        {group.sections.map(section => (
                          <SelectItem key={section.id} value={section.id} className="min-h-10 pl-4">
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
