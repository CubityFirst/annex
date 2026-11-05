import { cn } from "@/lib/utils";

export interface OutlineHeading {
  level: number;
  text: string;
  id: string;
}

/**
 * Doc outline list shared by the app reading view and the published site.
 * A hairline rail with the current section marked by a 2px foreground bar;
 * labels wrap to two lines instead of truncating mid-word.
 */
export function DocOutline({
  headings,
  activeId,
  onSelect,
  className,
}: {
  headings: OutlineHeading[];
  activeId: string | null;
  onSelect: (id: string) => void;
  className?: string;
}) {
  const minLevel = Math.min(...headings.map(h => h.level));
  return (
    <nav aria-label="Outline" className={cn("flex flex-col border-l border-border", className)}>
      {headings.map((h, i) => {
        const isActive = h.id === activeId;
        return (
          <button
            key={`${h.id}-${i}`}
            type="button"
            onClick={() => onSelect(h.id)}
            aria-current={isActive ? "location" : undefined}
            style={{ paddingLeft: `${0.75 + (h.level - minLevel) * 0.75}rem` }}
            className={cn(
              "-ml-px line-clamp-2 border-l-2 py-1 pr-2 text-left text-[13px] leading-5 transition-colors",
              isActive
                ? "border-foreground font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:border-muted-foreground/40 hover:text-foreground",
            )}
          >
            {h.text}
          </button>
        );
      })}
    </nav>
  );
}
