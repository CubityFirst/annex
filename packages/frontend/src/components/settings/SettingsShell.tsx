import { useEffect, useRef, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { ChevronDown } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
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
  /** Render the link in the destructive colour (Danger Zone). */
  danger?: boolean;
}

export interface SettingsGroupDef {
  /** Group key referenced by SettingsSectionDef.group. */
  id: string;
  /** Accordion header text. */
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

interface SettingsShellProps {
  title: string;
  description?: ReactNode;
  /** Content column max width. Defaults to 3xl; SiteSettings uses 4xl. */
  maxWidth?: "3xl" | "4xl";
  groups: SettingsGroupDef[];
  sections: SettingsSectionDef[];
  children: ReactNode;
}

/**
 * Shared chrome for both settings surfaces: a header, a sticky grouped
 * accordion outline that auto-expands the group of the section you're scrolled
 * to (and collapses the rest), and a content column holding the page's own
 * section JSX verbatim. Owns scroll-spy and hash deep-linking; knows nothing
 * about auth - pages pass pre-gated `visible` flags.
 */
export function SettingsShell({ title, description, maxWidth = "3xl", groups, sections, children }: SettingsShellProps) {
  const location = useLocation();
  const resolved = resolveOutline(groups, sections);
  const orderedIds = resolved.flatMap(group => group.sections.map(s => s.id));
  const idsKey = orderedIds.join("|");
  const { active, scrollTo } = useScrollSpy(orderedIds);

  // Deep-link support (e.g. /settings#billing, /settings#sessions): on hash
  // change, scroll to the section once it has rendered. scrollTo also sets the
  // section active, so the owning group expands. We re-run on idsKey changes so
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

  const activeGroupId = resolved.find(group => group.sections.some(s => s.id === active))?.id ?? null;
  const maxWidthClass = maxWidth === "4xl" ? "max-w-4xl" : "max-w-3xl";

  return (
    <div className={cn("mx-auto px-6 py-10", maxWidthClass)}>
      <div className="flex gap-12">
        {/* Grouped accordion outline - desktop only, mirrors DocsLayout's own
            mobile sidebar gesture by staying out of the way on small screens. */}
        <aside className="hidden md:block w-44 shrink-0">
          <nav className="sticky top-10 flex flex-col">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">On this page</p>
            {resolved.map(group => {
              const isActiveGroup = group.id === activeGroupId;
              return (
                <Collapsible key={group.id} open={isActiveGroup}>
                  <CollapsibleTrigger
                    type="button"
                    onClick={() => scrollTo(group.sections[0].id)}
                    aria-expanded={isActiveGroup}
                    className={cn(
                      "flex w-full items-center justify-between gap-2 py-1 text-left text-sm transition-colors",
                      isActiveGroup ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {group.label}
                    <ChevronDown
                      className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", isActiveGroup && "rotate-180")}
                    />
                  </CollapsibleTrigger>
                  <CollapsibleContent className="flex flex-col">
                    {group.sections.map(section => {
                      const isActive = active === section.id;
                      return (
                        <button
                          key={section.id}
                          type="button"
                          onClick={() => scrollTo(section.id)}
                          aria-current={isActive ? "true" : undefined}
                          className={cn(
                            "py-1 pl-3 text-left text-sm transition-colors",
                            section.danger
                              ? isActive
                                ? "text-destructive"
                                : "text-destructive/70 hover:text-destructive"
                              : isActive
                                ? "text-foreground"
                                : "text-muted-foreground hover:text-foreground",
                          )}
                        >
                          {section.label}
                        </button>
                      );
                    })}
                  </CollapsibleContent>
                </Collapsible>
              );
            })}
          </nav>
        </aside>

        {/* Content column - the page's existing sections, unchanged. */}
        <div className="flex-1 min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
          <Separator className="my-6" />
          {children}
        </div>
      </div>
    </div>
  );
}
