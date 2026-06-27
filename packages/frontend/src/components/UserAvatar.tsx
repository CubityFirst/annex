import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useAvatarVariant } from "@/lib/avatarVariant";

function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map(w => w[0]?.toUpperCase() ?? "")
    .join("");
}

export type PersonalPlan = "free" | "ink";

// Allowed values mirror INK_RING_STYLES in packages/auth/src/plan.ts.
// Anything unrecognised falls back to the default shimmer style.
// 'none' opts out of the ring entirely - the avatar renders bare.
const KNOWN_INK_STYLES = new Set(["shimmer", "aurora", "ember", "mono", "none"]);

interface UserAvatarProps {
  userId: string;
  name: string;
  className?: string;
  cacheBust?: number;
  // Annex Ink supporters get an animated conic-gradient ring. Other
  // values (or undefined) render with no extra decoration.
  personalPlan?: PersonalPlan;
  // Supporter ring variant. null/undefined → default 'shimmer'. Any
  // unrecognised value also collapses to default - the source of truth
  // for the allowed list lives server-side in plan.ts.
  personalPlanStyle?: string | null;
}

export function UserAvatar({ userId, name, className, cacheBust, personalPlan, personalPlanStyle }: UserAvatarProps) {
  // Variant is derived from the app-wide light/dark signal; the server falls
  // back to dark when the requested variant isn't uploaded, so we always send it.
  const [variant] = useAvatarVariant();
  const params = new URLSearchParams();
  if (cacheBust !== undefined) params.set("v", String(cacheBust));
  params.set("variant", variant);
  const src = `/api/avatar/${userId}?${params.toString()}`;
  const inner = (
    <Avatar className={className}>
      <AvatarImage src={src} alt={name} />
      <AvatarFallback>{initials(name)}</AvatarFallback>
    </Avatar>
  );
  if (personalPlan === "ink") {
    const style = personalPlanStyle && KNOWN_INK_STYLES.has(personalPlanStyle) ? personalPlanStyle : "shimmer";
    if (style === "none") return inner;
    const cls = style === "shimmer" ? "ink-border inline-block" : `ink-border ink-style-${style} inline-block`;
    return <span className={cls}>{inner}</span>;
  }
  return inner;
}
